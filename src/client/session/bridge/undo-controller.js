import * as Y from 'yjs';

// ---------------------------------------------------------------------------
// Undo / Redo via Y.UndoManager.
//
// Tracks operations on yItems, yMeta, and ymap (per-vote, comment, and template keys).
// `trackedOrigins: ['local']` means:
//   - Local board edits, vote/comment changes, template puts/removes → tracked.
//   - Remote peer writes (origin = WebsocketProvider) → ignored, so undo
//     never reverses another user's work.
//   - Per-device settings + presence (origin = 'system') → ignored.
//   - Migration (origin = 'system') → ignored.
//
// Because yItems is tracked as a parent type, Y.UndoManager auto-tracks ops
// on the nested per-item Y.Maps too — so a sticky-text edit and a sticky drag
// produce independent stack entries that can be undone individually without
// touching any peer's concurrent changes.
// ---------------------------------------------------------------------------
export const UNDO_CAPTURE_TIMEOUT_MS = 500;

export function createUndoController({ yItems, yMeta, ymap }) {
  const undoEmitter = new EventTarget();
  const undoManager = new Y.UndoManager([yItems, yMeta, ymap], {
    trackedOrigins: new Set(['local']),
    captureTimeout: UNDO_CAPTURE_TIMEOUT_MS,
  });
  const fire = () => undoEmitter.dispatchEvent(new Event('change'));
  undoManager.on('stack-item-added', fire);
  undoManager.on('stack-item-popped', fire);
  undoManager.on('stack-cleared', fire);

  const methods = {
    stopUndoCapture() { undoManager?.stopCapturing(); },
    undo() {
      if (!undoManager || undoManager.undoStack.length === 0) return false;
      undoManager.undo();
      return true;
    },
    redo() {
      if (!undoManager || undoManager.redoStack.length === 0) return false;
      undoManager.redo();
      return true;
    },
    canUndo() { return !!(undoManager && undoManager.undoStack.length > 0); },
    canRedo() { return !!(undoManager && undoManager.redoStack.length > 0); },
    onUndoChange(handler) { undoEmitter.addEventListener('change', handler); },
    offUndoChange(handler) { undoEmitter.removeEventListener('change', handler); },
  };
  return { undoManager, methods };
}
