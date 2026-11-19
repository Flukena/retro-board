import * as Y from 'yjs';
import { protectedItemEntries, concealEntriesForMove } from '../../../domain/move-concealment.js';
import { isSafeId } from '../../../domain/comment-schema.js';
import { geometryErrorForBoard, geometryErrorForItem, geometryErrorForPatch } from '../../../domain/board-geometry.js';
import { collaborativeTextToString, isCollaborativeTextField, setCollaborativeTextField } from '../collaborative-text.js';
import { decodeRemoteBoard } from '../../board/remote-board-decoder.js';
import { repairStoredBoardGeometry } from '../../board/stored-geometry-repair.js';
import { migrateLegacyTemplates } from '../../../domain/template-store.js';

export const LEGACY_BOARD_KEY = 's||boardState';
export const META_INTERNAL_PREFIX = '__';
export const IMAGE_REPAIR_ORIGIN = 'image-repair';
export const originOf = (opts) => (opts && opts.silent ? 'system' : 'local');

const BOARD_ITEM_TYPES = new Set(['sticky', 'zone', 'text', 'image']);

export const boardItemWriteError = (item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'item must be an object';
  if (!isSafeId(item.id)) return 'item has an invalid id';
  if (!BOARD_ITEM_TYPES.has(item.type)) return `item ${item.id} has an invalid type`;
  return null;
};

export const boardItemsWriteError = (items) => {
  if (!Array.isArray(items)) return 'board items must be an array';
  const ids = new Set();
  for (const item of items) {
    const error = boardItemWriteError(item);
    if (error) return error;
    if (ids.has(item.id)) return `duplicate item id: ${item.id}`;
    ids.add(item.id);
  }
  return geometryErrorForBoard(items);
};

export function createSnapshotDoc({ ydoc, yItems, yMeta, publicPermit }) {
  const { permitPublicCreations } = publicPermit;
  const newSnapshotItems = items => items.filter(item => item?.id && !(yItems.get(item.id) instanceof Y.Map));

  const valuesEqual = (a, b) => {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;
    // JSON-equality is sufficient for board fields (primitives + small arrays).
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  };

  const setItemField = (yItem, field, value) => {
    if (value === undefined) {
      yItem.delete(field);
      return;
    }
    if (isCollaborativeTextField(field) && typeof value === 'string') {
      setCollaborativeTextField(yItem, field, value);
      return;
    }
    yItem.set(field, value);
  };

  const readItemSnapshot = (yItem, id) => {
    if (!(yItem instanceof Y.Map)) return null;
    if (yItem.has('id') && yItem.get('id') !== id) return null;
    const item = Object.assign(Object.create(null), { id });
    yItem.forEach((value, key) => { item[key] = collaborativeTextToString(value); });
    return item;
  };

  const readBoardSnapshot = () => {
    const items = [];
    // Y.Map iterates in insertion order, which matches the order items were
    // added across the doc's history — deterministic on all peers.
    yItems.forEach((yItem, id) => {
      const item = readItemSnapshot(yItem, id);
      if (item) items.push(item);
    });
    const meta = Object.create(null);
    yMeta.forEach((val, key) => {
      if (key.startsWith(META_INTERNAL_PREFIX)) return;
      meta[key] = val;
    });
    return { ...meta, items };
  };

  const readRemoteBoardSnapshot = () => {
    const { items, ...meta } = readBoardSnapshot();
    return decodeRemoteBoard(items, meta);
  };

  const writeBoardSnapshot = (newBoard, origin = 'local') => {
    if (!newBoard || typeof newBoard !== 'object' || !Array.isArray(newBoard.items)) return false;
    if (boardItemsWriteError(newBoard.items)) return false;
    if (!permitPublicCreations(newSnapshotItems(newBoard.items))) return false;
    const cur = readBoardSnapshot();
    const curById = new Map();
    cur.items.forEach((it) => curById.set(it.id, it));
    const newById = new Map();
    (newBoard.items || []).forEach((it) => {
      if (it && it.id) newById.set(it.id, it);
    });

    ydoc.transact(() => {
      // Deletions
      curById.forEach((_oldItem, id) => {
        if (!newById.has(id)) yItems.delete(id);
      });
      // Upserts + per-field diffs
      newById.forEach((nItem, id) => {
        const oItem = curById.get(id);
        const yItem = yItems.get(id);
        if (!(yItem instanceof Y.Map)) {
          // Brand-new item — seed a fresh Y.Map with all fields.
          seedItem(id, nItem);
          return;
        }
        const allFields = new Set([
          ...Object.keys(oItem || {}),
          ...Object.keys(nItem),
        ]);
        allFields.forEach((field) => {
          if (field === 'id') return;
          const ov = oItem ? oItem[field] : undefined;
          const nv = nItem[field];
          if (valuesEqual(ov, nv)) return;
          setItemField(yItem, field, nv);
        });
      });
      // Board-level meta diff (everything except `items`)
      const allMetaKeys = new Set([
        ...Object.keys(cur).filter((k) => k !== 'items'),
        ...Object.keys(newBoard).filter((k) => k !== 'items'),
      ]);
      allMetaKeys.forEach((key) => {
        if (key.startsWith(META_INTERNAL_PREFIX)) return;
        const ov = cur[key];
        const nv = newBoard[key];
        if (valuesEqual(ov, nv)) return;
        if (nv === undefined || nv === null) yMeta.delete(key);
        else yMeta.set(key, nv);
      });
    }, origin);
    return true;
  };

  // ---------------------------------------------------------------------------
  // Granular board writes. The UI sends only the delta it changed instead of the
  // whole board, so a single text edit or a per-frame drag no longer pays the
  // O(items × fields) cost of reading + diffing the entire board. Each runs in
  // one transaction; `origin` decides undo-stack membership, exactly as
  // writeBoardSnapshot did — 'local' = user action (undoable), 'system' = derived
  // / automatic change (skipped by the UndoManager).
  // ---------------------------------------------------------------------------
  // Not a tracked undo origin: a repair rewrites sources without becoming an undo step.

  // Seed a brand-new item as its own Y.Map (mirrors writeBoardSnapshot's
  // create branch). Populated before attaching so peers see it complete.
  const seedItem = (id, fields) => {
    const yItem = new Y.Map();
    Object.entries(fields).forEach(([k, v]) => {
      if (k === 'id' || v === undefined) return;
      setItemField(yItem, k, v);
    });
    yItems.set(id, yItem);
  };

  const createItem = (id, fields) => {
    if (yItems.has(id) || geometryErrorForItem({ ...fields, id })) return false;
    seedItem(id, fields);
    return true;
  };

  const patchExistingItem = (id, patch) => {
    const yItem = yItems.get(id);
    if (!(yItem instanceof Y.Map)) return false;
    const current = readItemSnapshot(yItem, id);
    if (!current || geometryErrorForPatch(current, patch)) return false;
    Object.entries(patch).forEach(([k, v]) => {
      if (k === 'id') return;
      setItemField(yItem, k, v);
    });
    return true;
  };

  // Called inside the same transaction as every granular geometry/reveal write.
  const patchProtectedItems = (entries) => {
    const { items, allRevealed } = readBoardSnapshot();
    protectedItemEntries(items, entries, allRevealed).forEach(({ id, patch }) => patchExistingItem(id, patch));
  };
  const concealForAdditions = (additions) => {
    const { items, allRevealed } = readBoardSnapshot();
    return concealEntriesForMove(items, [...items, ...additions], allRevealed);
  };

  const attachMaintenance = ({ provider, ymap }) => {
    let migrationDone = false;
    const tryMigrate = () => {
      if (migrationDone) return;
      if (yMeta.get('__migrated')) { migrationDone = true; return; }
      const legacy = ymap.get(LEGACY_BOARD_KEY);
      // Empty legacy state and an already-populated item map both only need the flag.
      if (!legacy || typeof legacy !== 'object' || yItems.size > 0) {
        ydoc.transact(() => { yMeta.set('__migrated', true); }, 'system');
        migrationDone = true;
        return;
      }
      ydoc.transact(() => {
        (legacy.items || []).forEach((it) => {
          if (!it || !it.id) return;
          seedItem(it.id, it);
        });
        Object.entries(legacy).forEach(([k, v]) => {
          if (k === 'items' || v === undefined || v === null) return;
          yMeta.set(k, v);
        });
        yMeta.set('__migrated', true);
        // Drop the legacy blob so it can't drift out of sync with yItems.
        ymap.delete(LEGACY_BOARD_KEY);
      }, 'system');
      migrationDone = true;
    };

    // Existing boards stored editable fields as scalar strings. Upgrade them
    // after every sync (a no-op once upgraded) so both old boards and items added
    // by a stale client gain character-level CRDT merging without a manual reset.
    const ensureCollaborativeTextFields = () => {
      ydoc.transact(() => {
        yItems.forEach((yItem) => {
          if (!(yItem instanceof Y.Map)) return;
          const type = yItem.get('type');
          const fields = type === 'zone' ? ['title'] : (type === 'sticky' || type === 'text' ? ['text'] : []);
          fields.forEach((field) => {
            const value = yItem.get(field);
            if (typeof value === 'string') setItemField(yItem, field, value);
          });
        });
      }, 'system');
    };

    const migrateAndRepair = () => {
      tryMigrate();
      repairStoredBoardGeometry(ydoc, yItems);
      ensureCollaborativeTextFields();
      migrateLegacyTemplates(ydoc, ymap);
    };
    if (provider) {
      provider.on('sync', (isSynced) => { if (isSynced) migrateAndRepair(); });
      if (provider.synced) migrateAndRepair();
    }

  };
  return { readBoardSnapshot, readRemoteBoardSnapshot, writeBoardSnapshot, readItemSnapshot,
    createItem, patchExistingItem, patchProtectedItems, concealForAdditions, newSnapshotItems, attachMaintenance };
}
