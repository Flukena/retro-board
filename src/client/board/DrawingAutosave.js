export const DRAWING_AUTOSAVE_IDLE_MS = 700;
export const DRAWING_AUTOSAVE_MIN_INTERVAL_MS = 5000;

// One upload at a time. Changes during an upload stay queued; a late result can
// never mark a newer draft as saved or create a second image.
export class DrawingAutosave {
  constructor(operations, clock = globalThis) {
    this.operations = operations; this.clock = clock; this.timer = null; this.pending = false;
    this.running = null; this.lastStarted = -Infinity; this.disposed = false;
  }
  changed() {
    this.pending = true;
    if (this.disposed || this.timer !== null || this.running) return;
    const delay = Math.max(DRAWING_AUTOSAVE_IDLE_MS, this.lastStarted + DRAWING_AUTOSAVE_MIN_INTERVAL_MS - this.clock.Date.now());
    this.timer = this.clock.setTimeout(() => { this.timer = null; void this.flush(false); }, delay);
  }
  async flush(force = true) {
    if (this.timer !== null) this.clock.clearTimeout(this.timer); this.timer = null;
    if (this.disposed) return false;
    if (this.running) {
      if (!await this.running) return false;
      return force && this.pending ? this.flush() : true;
    }
    if (!this.pending) return true;
    this.pending = false; this.lastStarted = this.clock.Date.now();
    this.running = this.operations.save();
    let saved;
    try { saved = await this.running; }
    finally { this.running = null; }
    if (!saved) { this.pending = true; return false; }
    if (this.pending) {
      if (force) return this.flush();
      this.changed();
    }
    return true;
  }
  dispose() {
    this.disposed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer); this.timer = null;
  }
}
