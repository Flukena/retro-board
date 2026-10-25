// Chromium re-rasters a composited layer every time its scale changes, which
// made every zoom frame redraw the whole visible board. While input is live,
// `will-change: transform` keeps the current raster and lets the GPU scale it;
// clearing the hint after input settles re-rasters crisply exactly once.
// `onSettle` runs only when input stops on its own, not on an explicit release,
// because explicit releases come from a full settled paint.

// Longer than the board's 120ms wheel commit debounce, so a slow wheel or a
// paused finger does not drop and re-add the hint between events.
export const LIVE_LAYER_SETTLE_MS = 160;
const LIVE_HINT = 'transform';
const IDLE_HINT = '';

class LiveLayerHint {
  constructor(element, scheduler) {
    this.element = element;
    this.scheduler = scheduler;
    this.timer = null;
  }

  hold(onSettle) {
    this.element.style.willChange = LIVE_HINT;
    this.cancelTimer();
    this.timer = this.scheduler.setTimeout(() => {
      this.release();
      onSettle?.();
    }, LIVE_LAYER_SETTLE_MS);
  }

  release() {
    this.cancelTimer();
    this.element.style.willChange = IDLE_HINT;
  }

  cancelTimer() {
    if (this.timer === null) return;
    this.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }
}

const hints = new WeakMap();

export function holdLiveLayer(element, onSettle, scheduler = globalThis) {
  let hint = hints.get(element);
  if (!hint) {
    hint = new LiveLayerHint(element, scheduler);
    hints.set(element, hint);
  }
  hint.hold(onSettle);
}

export function releaseLiveLayer(element) {
  const hint = hints.get(element);
  if (!hint) return;
  hints.delete(element);
  hint.release();
}
