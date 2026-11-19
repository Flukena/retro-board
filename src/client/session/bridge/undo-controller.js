import * as Y from 'yjs';

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
