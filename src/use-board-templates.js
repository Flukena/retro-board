import { useEffect, useMemo, useRef, useState } from 'react';
import { TEMPLATE_NAME_MAX_LENGTH } from './security-boundaries.js';
import { getTemplates } from './builtin-templates.js';
import { resolveOwnerZone } from './board-ownership.js';
import { templateZonesFromSelection, templateBounds, templatePlacementOffset, templateOccupiedRects } from './template-model.js';
import { t } from './i18n.js';

const normalizeTemplateName = (rawName) => (rawName || '').trim().slice(0, TEMPLATE_NAME_MAX_LENGTH);

export const subscribeTemplates = (storage, onSnapshot) => {
  let active = true;
  const refresh = () => {
    if (active) onSnapshot(storage?.snapshotTemplates?.() || []);
  };
  storage?.onTemplatesChange?.(refresh);
  const offSync = storage?.onSynced?.(refresh);
  refresh();
  return () => {
    active = false;
    storage?.offTemplatesChange?.(refresh);
    offSync?.();
  };
};

export const createTemplateActions = ({
  storage, createId, setToast, setSaveTemplateOpen, onDraftChange = () => {},
  addItemsLocal, userId, userName, closeTemplates, draftRef = { current: [] },
  renameRef = { current: null }, onRenameTargetChange = () => {},
}) => {
  const warn = (key) => setToast({ msg: t(key), type: 'warn' });
  const updateDraft = (zones) => {
    draftRef.current = zones;
    onDraftChange(zones);
  };
  const closeSaveDialog = () => {
    updateDraft([]);
    setSaveTemplateOpen(false);
  };
  const openSaveTemplate = (items, selectedIds) => {
    const zones = templateZonesFromSelection(items, selectedIds);
    if (!zones.length) {
      closeSaveDialog();
      warn('tmpl.selectZones');
      return false;
    }
    updateDraft(zones);
    setSaveTemplateOpen(true);
    closeTemplates?.();
    return true;
  };
  const saveCurrentAsTemplate = (rawName) => {
    const name = normalizeTemplateName(rawName);
    if (!name) return;
    if (!draftRef.current.length) { warn('tmpl.selectZones'); return; }
    const saved = storage?.putTemplate?.({ id: createId(), name, zones: draftRef.current, createdAt: Date.now() });
    if (!saved) { warn('tmpl.saveFailed'); return; }
    closeSaveDialog();
    setToast({ msg: t('tmpl.saved', { name }), type: 'info' });
  };
  const updateRenameTarget = (target) => {
    renameRef.current = target;
    onRenameTargetChange(target);
  };
  const closeRenameDialog = () => updateRenameTarget(null);
  const findTemplate = (id) => storage?.snapshotTemplates?.().find((entry) => entry.id === id);
  const openRenameTemplate = (id) => {
    const template = findTemplate(id);
    if (!template) { warn('tmpl.renameMissing'); return; }
    updateRenameTarget({ id, name: template.name });
    closeTemplates?.();
  };
  const renameCustomTemplate = (rawName) => {
    const name = normalizeTemplateName(rawName);
    if (!name || !renameRef.current) return;
    const latest = findTemplate(renameRef.current.id);
    if (!latest) {
      warn('tmpl.renameMissing');
      closeRenameDialog();
      return;
    }
    if (!storage.putTemplate({ ...latest, name })) { warn('tmpl.saveFailed'); return; }
    setToast({ msg: t('tmpl.renamed', { name }), type: 'info' });
    closeRenameDialog();
  };
  const deleteCustomTemplate = (id) => {
    if (!storage?.removeTemplate?.(id)) warn('tmpl.saveFailed');
  };
  const applyTemplate = (key, { viewportCenter, items }) => {
    const template = getTemplates()[key] || storage?.snapshotTemplates?.().find((entry) => entry.id === key);
    if (!template) return null;
    const offset = templatePlacementOffset({
      templateZones: template.zones, viewportCenter, occupiedRects: templateOccupiedRects(items),
    });
    if (!offset) { warn('tmpl.placementFailed'); return null; }
    const zones = template.zones.map((zone) => ({
      ...zone, id: createId(), type: 'zone', x: zone.x + offset.dx, y: zone.y + offset.dy,
      authorId: userId, authorName: userName, createdAt: Date.now(),
    }));
    zones.forEach((zone) => { zone.parentZoneId = resolveOwnerZone(zone, zones)?.id ?? null; });
    if (!addItemsLocal(zones)) return null;
    closeTemplates();
    return templateBounds(zones);
  };
  return { openSaveTemplate, closeSaveDialog, saveCurrentAsTemplate, deleteCustomTemplate, applyTemplate,
    openRenameTemplate, renameCustomTemplate, closeRenameDialog };
};

export const useBoardTemplates = ({ storage, createId, setToast, setSaveTemplateOpen,
  addItemsLocal, userId, userName, closeTemplates }) => {
  const [customTemplates, setCustomTemplates] = useState(() => storage?.snapshotTemplates?.() || []);
  const [templateDraft, setTemplateDraft] = useState([]);
  const draftRef = useRef([]);
  const [renameTarget, setRenameTarget] = useState(null);
  const renameRef = useRef(null);
  useEffect(() => subscribeTemplates(storage, setCustomTemplates), [storage]);
  const actions = useMemo(() => createTemplateActions({
    storage, createId, setToast, setSaveTemplateOpen, onDraftChange: setTemplateDraft,
    addItemsLocal, userId, userName, closeTemplates, draftRef, renameRef, onRenameTargetChange: setRenameTarget,
  }), [storage, createId, setToast, setSaveTemplateOpen, addItemsLocal, userId, userName, closeTemplates]);
  return { customTemplates, templateDraft, renameTarget, ...actions };
};
