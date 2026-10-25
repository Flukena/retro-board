import { isSafeId } from './comment-schema.js';
import { normalizeCustomTemplates } from './import-schema.js';
import {
  IMPORT_MAX_CUSTOM_TEMPLATES,
  IMPORT_MAX_TOTAL_TEMPLATE_ZONES,
} from './security-boundaries.js';

export const TEMPLATE_PREFIX = 's||template:';
export const LEGACY_TEMPLATE_KEY = 's||customTemplates';
const TEMPLATE_FALLBACK_CREATED_AT_MS = 0;
const LOCAL_ORIGIN = 'local';
const MIGRATION_ORIGIN = 'system';
const templateKey = (id) => `${TEMPLATE_PREFIX}${id}`;

export const isTemplateKey = (key) => (
  key === LEGACY_TEMPLATE_KEY || key.startsWith(TEMPLATE_PREFIX)
);

// Only the schema decoder can reject an entry here. Use a fixed fallback
// rather than wall-clock time so every peer orders missing timestamps alike.
export const normalizeTemplateEntries = (entries) => {
  try {
    return normalizeCustomTemplates(entries, TEMPLATE_FALLBACK_CREATED_AT_MS);
  } catch (error) {
    // The decoder's validation failures are plain Errors; propagate runtime
    // failures such as TypeError rather than disguising them as bad data.
    if (error?.constructor !== Error) throw error;
    return null;
  }
};

const decodeTemplate = (entry) => normalizeTemplateEntries([entry])?.[0] ?? null;

const compareTemplates = (a, b) => (
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : Number(a.id > b.id))
);

const mergedTemplates = (ymap) => {
  const entries = new Map();
  const legacy = ymap.get(LEGACY_TEMPLATE_KEY);
  if (Array.isArray(legacy)) {
    legacy.forEach((entry) => {
      const decoded = decodeTemplate(entry);
      if (decoded) entries.set(decoded.id, decoded);
    });
  }
  ymap.forEach((entry, key) => {
    if (!key.startsWith(TEMPLATE_PREFIX)) return;
    const decoded = decodeTemplate(entry);
    if (decoded && key === templateKey(decoded.id)) entries.set(decoded.id, decoded);
  });
  return [...entries.values()].sort(compareTemplates);
};

const withinCaps = (templates) => (
  templates.length <= IMPORT_MAX_CUSTOM_TEMPLATES
  && templates.reduce((total, entry) => total + entry.zones.length, 0) <= IMPORT_MAX_TOTAL_TEMPLATE_ZONES
);

export const readTemplates = (ymap) => {
  let totalZones = 0;
  const result = [];
  for (const entry of mergedTemplates(ymap)) {
    if (result.length === IMPORT_MAX_CUSTOM_TEMPLATES) break;
    if (totalZones + entry.zones.length > IMPORT_MAX_TOTAL_TEMPLATE_ZONES) continue;
    result.push(entry);
    totalZones += entry.zones.length;
  }
  return result;
};

export const migrateLegacyTemplates = (ydoc, ymap) => {
  // No tombstones: an old-bundle client rewriting the legacy array can
  // reintroduce a deleted id. Merge-on-read and re-migration preserve its data.
  if (!ymap.has(LEGACY_TEMPLATE_KEY)) return;
  const templates = readTemplates(ymap);
  ydoc.transact(() => {
    templates.forEach((entry) => {
      const key = templateKey(entry.id);
      if (!ymap.has(key)) ymap.set(key, entry);
    });
    ymap.delete(LEGACY_TEMPLATE_KEY);
  }, MIGRATION_ORIGIN);
};

// Causally later sets win. Concurrent sets use Y.Map's client-id tie-break.
// A concurrent delete only deletes the value it observed: an unseen set
// survives. A delete after observing that set removes it on every peer.
export const putTemplate = (ydoc, ymap, template) => {
  migrateLegacyTemplates(ydoc, ymap);
  const decoded = decodeTemplate(template);
  if (!decoded) return false;
  const next = mergedTemplates(ymap).filter((entry) => entry.id !== decoded.id);
  next.push(decoded);
  if (!withinCaps(next)) return false;
  ydoc.transact(() => ymap.set(templateKey(decoded.id), decoded), LOCAL_ORIGIN);
  return true;
};

export const removeTemplate = (ydoc, ymap, id) => {
  migrateLegacyTemplates(ydoc, ymap);
  if (!isSafeId(id) || !ymap.has(templateKey(id))) return false;
  ydoc.transact(() => ymap.delete(templateKey(id)), LOCAL_ORIGIN);
  return true;
};

// The bridge preflights the import before opening its outer transaction.
// No nested migration here: replacement belongs to the single undoable import.
export const replaceTemplates = (ymap, templates) => {
  const normalized = normalizeTemplateEntries(templates);
  if (!normalized) return false;
  const keys = [...ymap.keys()].filter(isTemplateKey);
  keys.forEach((key) => ymap.delete(key));
  normalized.forEach((entry) => ymap.set(templateKey(entry.id), entry));
  return true;
};
