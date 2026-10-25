import { DrawingAutosave } from './DrawingAutosave.js';
import { drawingTargetUnchanged } from '../../domain/drawing-image-target.js';
import { drawingArtifact } from './drawing-paint.js';
import { saveDrawingArtifact } from './drawing-save.js';

const MAX_DRAWING_DPR = 2;
const RESTORE_FIELDS = Object.freeze(['x', 'y', 'w', 'h', 'src', 'natW', 'natH', 'parentZoneId']);
export class DrawingLiveSession {
  constructor(draft, operations, target = null) {
    this.draft = draft; this.operations = operations; this.initialTarget = target ? { ...target } : null; this.target = this.initialTarget; this.imageId = target?.id ?? null;
    this.id = operations.createId(); this.completed = draft.completedStrokes; this.saved = this.completed; this.disposed = false;
    this.abort = new AbortController();
    this.autosave = new DrawingAutosave({ save: () => this.save() });
    this.watchTarget();
  }
  changed() {
    this.preview();
    if (this.completed === this.draft.completedStrokes) return;
    this.completed = this.draft.completedStrokes; this.autosave.changed();
  }
  preview() {
    if (this.draft.strokes === this.saved) { this.operations.previews()?.clear(); return; }
    this.operations.previews()?.publish(() => ({ id: this.id, targetId: this.target?.id ?? null,
      base: this.initialTarget, strokes: this.draft.strokes }));
  }
  watchTarget() {
    this.unwatchTarget?.();
    this.unwatchTarget = this.operations.previews()?.watchTargetDeletion?.(this.target?.id, () => {
      this.dispose(); this.draft.clear(); this.operations.changed(); this.operations.removed?.();
    });
  }
  checkpoint(saved, strokes) {
    if (saved) { this.saved = strokes; this.preview(); }
    return saved;
  }
  canCommit() {
    return !this.disposed && !this.abort.signal.aborted && this.operations.canEdit()
      && (!this.target || drawingTargetUnchanged(this.target, this.operations.items()));
  }
  restoreEmpty() {
    if (!this.target) return true;
    const target = this.initialTarget;
    if (!target) { this.unwatchTarget?.(); this.operations.removeItem(this.target.id); this.target = null; return true; }
    const patch = Object.fromEntries(RESTORE_FIELDS.map(field => [field, target[field]]));
    if (!this.operations.updateItem(target.id, patch)) return false;
    this.target = { ...this.target, ...patch }; return true;
  }
  async save() {
    if (!this.canCommit()) { this.operations.error('draw.conflict'); return false; }
    const strokes = this.draft.completedStrokes;
    this.operations.saving(true); this.operations.error(null);
    try {
      if (!strokes.length) return this.checkpoint(this.restoreEmpty(), strokes);
      const artifact = await drawingArtifact(strokes, this.operations.zoom() * Math.min(globalThis.devicePixelRatio || 1, MAX_DRAWING_DPR),
        this.operations.document(), this.operations.baseImage());
      if (!this.canCommit()) { this.operations.error('draw.conflict'); return false; }
      if (artifact?.empty) return this.checkpoint(this.restoreEmpty(), strokes);
      if (!artifact) { this.operations.error('draw.encodeFailed'); return false; }
      const saved = await saveDrawingArtifact(artifact, {
        isCurrent: () => !this.disposed && !this.abort.signal.aborted, canEdit: () => this.operations.canEdit(),
        uploadImage: blob => this.operations.uploadImage(blob, this.abort.signal),
        uploadFailed: () => this.operations.error('draw.saveFailed'),
        author: () => this.operations.author(), createId: () => this.imageId ?? this.operations.createId(), now: Date.now,
        items: () => this.operations.items(), stopUndoCapture: () => this.operations.stopUndoCapture(),
        addItem: item => {
          if (!this.operations.addItem(item)) return false;
          this.target = { ...item }; this.imageId = item.id; this.watchTarget(); this.preview(); return true;
        },
        updateItem: (id, patch) => {
          if (!this.operations.updateItem(id, patch)) return false;
          this.target = { ...this.target, ...patch }; return true;
        }, selectItem: () => {},
      }, this.target);
      return this.checkpoint(saved, strokes);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      this.operations.error('draw.encodeFailed'); return false;
    } finally { if (!this.disposed) { this.operations.saving(false); this.operations.changed(); } }
  }
  async close() {
    if (this.disposed) return true;
    this.draft.cancelStroke(); this.changed();
    if (!await this.autosave.flush()) return false;
    this.operations.previews()?.clear();
    if (this.target) this.operations.selectItem(this.target.id);
    return true;
  }
  discard() { this.dispose(); }
  dispose() {
    this.disposed = true; this.unwatchTarget?.(); this.abort.abort(); this.autosave.dispose(); this.operations.previews()?.clear();
  }
}
