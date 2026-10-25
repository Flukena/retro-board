import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { paintDrawing } from './drawing-paint.js';
import { loadDrawingImage } from './drawing-image.js';
import { hideDrawingImage } from './drawing-visibility.js';
import { useBrowserLayoutEffect } from '../ui/use-browser-layout-effect.js';

const EMPTY = Object.freeze([]);
const MAX_PREVIEW_EDGE_PX = 1024;
const NO_PREVIEWS = { subscribe: () => () => {}, getSnapshot: () => EMPTY };
const LiveDrawingPreview = React.memo(function LiveDrawingPreview({ preview }) {
  const canvasRef = useRef(null), baseRef = useRef(null);
  const [loaded, setLoaded] = useState(!preview.base);
  const base = preview.base;
  useEffect(() => {
    if (!base) return undefined;
    const abort = new AbortController(); let asset = null; setLoaded(false);
    loadDrawingImage(base, { signal: abort.signal }).then(value => {
      if (abort.signal.aborted) { value?.image.close(); return; }
      asset = value; baseRef.current = value; setLoaded(!!value);
    }, () => { if (!abort.signal.aborted) setLoaded(false); });
    return () => { abort.abort(); asset?.image.close(); baseRef.current = null; };
  }, [base?.src]);
  useBrowserLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!loaded || !canvas) return undefined;
    const { x, y, w, h } = preview.bounds;
    const ratio = Math.min(1, MAX_PREVIEW_EDGE_PX / Math.max(w, h));
    canvas.width = Math.max(1, Math.ceil(w * ratio)); canvas.height = Math.max(1, Math.ceil(h * ratio));
    const ctx = canvas.getContext('2d'); if (!ctx) return undefined;
    ctx.setTransform(ratio, 0, 0, ratio, -x * ratio, -y * ratio);
    paintDrawing(ctx, preview.strokes, baseRef.current);
    return hideDrawingImage(canvas.ownerDocument, preview.targetId);
  }, [preview, loaded]);
  return <canvas ref={canvasRef} data-drawing-preview={preview.id} aria-hidden="true"
    style={{ position: 'absolute', pointerEvents: 'none', left: preview.bounds.x, top: preview.bounds.y,
      width: preview.bounds.w, height: preview.bounds.h, visibility: loaded ? 'visible' : 'hidden' }} />;
});
export function LiveDrawingPreviews() {
  const bridge = typeof window === 'undefined' ? NO_PREVIEWS : window.storage?.drawingPreviews ?? NO_PREVIEWS;
  const previews = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, () => EMPTY);
  return previews.map(preview => <LiveDrawingPreview key={preview.id} preview={preview} />);
}
