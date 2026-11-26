import { boardItemWriteError, boardItemsWriteError, META_INTERNAL_PREFIX, originOf } from './snapshot-doc.js';
import { geometryErrorForItem, geometryErrorForPatch } from '../../../domain/board-geometry.js';
import { stickyTextEditPatch } from '../../../domain/sticky-editor.js';

export function createBoardMethods({ ydoc, yItems, yMeta, snapshot, publicPermit }) {
  const { permitPublicCreations, consumePublicCreationFailure } = publicPermit;
  const { readItemSnapshot, createItem, concealForAdditions, patchProtectedItems, writeBoardSnapshot } = snapshot;
  return {
    // --- Granular board writes (delta-only; see helpers above) ---
    canCreateItems(items) { return Array.isArray(items) && permitPublicCreations(items); },
    consumePublicCreationFailure,
    addItem(item, opts) {
      if (boardItemWriteError(item) || geometryErrorForItem(item) || yItems.has(item.id)) return false;
      if (!permitPublicCreations([item])) return false;
      const concealed = concealForAdditions([item]);
      ydoc.transact(() => { createItem(item.id, item); patchProtectedItems(concealed); }, originOf(opts));
      return true;
    },
    addItems(items, opts) {
      if (!Array.isArray(items) || !items.length) return false;
      if (boardItemsWriteError(items) || items.some((item) => yItems.has(item.id))) return false;
      if (!permitPublicCreations(items)) return false;
      const concealed = concealForAdditions(items);
      ydoc.transact(() => {
        items.forEach((item) => createItem(item.id, item));
        patchProtectedItems(concealed);
      }, originOf(opts));
      return true;
    },
    updateItem(id, patch, opts) {
      if (!id || !patch || typeof patch !== 'object') return false;
      const current = readItemSnapshot(yItems.get(id), id);
      if (!current
        || ('type' in patch && patch.type !== current.type)
        || geometryErrorForPatch(current, patch)) return false;
      const editPatch = stickyTextEditPatch(current, patch, opts?.editor);
      ydoc.transact(() => { patchProtectedItems([{ id, patch: editPatch }]); }, originOf(opts));
      return true;
    },
    updateItems(entries, opts) {
      if (!Array.isArray(entries) || !entries.length) return false;
      const valid = entries.every((entry) => {
        if (!entry?.id || !entry.patch || typeof entry.patch !== 'object') return false;
        const current = readItemSnapshot(yItems.get(entry.id), entry.id);
        if (!current || ('type' in entry.patch && entry.patch.type !== current.type)) return false;
        return geometryErrorForPatch(current, entry.patch) == null;
      });
      if (!valid) return false;
      ydoc.transact(() => {
        patchProtectedItems(entries);
      }, originOf(opts));
      return true;
    },
    removeItem(id, opts) {
      if (!id) return;
      ydoc.transact(() => { if (yItems.has(id)) yItems.delete(id); }, originOf(opts));
    },
    setMeta(patch, opts) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
      ydoc.transact(() => {
        Object.entries(patch).forEach(([k, v]) => {
          if (k.startsWith(META_INTERNAL_PREFIX)) return;
          if (v === undefined || v === null) yMeta.delete(k);
          else yMeta.set(k, v);
        });
      }, originOf(opts));
      return true;
    },
    // Full board replace — for import / clear only. Reuses the proven
    // delete-missing + per-field upsert diff.
    replaceBoard(board, opts) {
      return writeBoardSnapshot(board, originOf(opts));
    },

  };
}
