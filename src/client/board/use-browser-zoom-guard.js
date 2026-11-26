import { useEffect } from 'react';

const DPR_ZOOM_TOLERANCE = 0.01;
const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'];
const ZOOM_KEYS = ['+', '-', '=', '0'];

export function attachBrowserZoomGuard({
  view = globalThis.window, ownerDocument = globalThis.document, blockGestures = false,
} = {}) {
  const onWheel = (e) => {
    // Canvas already preventDefaults its own wheel; this stops zoom
    // when pinch/ctrl-wheel happens over toolbars or modals.
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  };
  const onKeyDown = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (ZOOM_KEYS.includes(e.key)) e.preventDefault();
  };

  const onGesture = event => event.preventDefault();
  if (blockGestures) GESTURE_EVENTS.forEach(type => view.addEventListener(type, onGesture));

  view.addEventListener('wheel', onWheel, { passive: false });
  view.addEventListener('keydown', onKeyDown);

  const baseDPR = view.devicePixelRatio || 1;
  const counterZoom = () => {
    const ratio = (view.devicePixelRatio || 1) / baseDPR;
    ownerDocument.body.style.zoom = Math.abs(ratio - 1) > DPR_ZOOM_TOLERANCE ? String(1 / ratio) : '';
  };
  counterZoom();
  view.addEventListener('resize', counterZoom);
  view.visualViewport?.addEventListener('resize', counterZoom);

  const dispose = () => {
    if (blockGestures) GESTURE_EVENTS.forEach(type => view.removeEventListener(type, onGesture));
    view.removeEventListener('wheel', onWheel);
    view.removeEventListener('keydown', onKeyDown);
    view.removeEventListener('resize', counterZoom);
    view.visualViewport?.removeEventListener('resize', counterZoom);
    ownerDocument.body.style.zoom = '';
  };
  return { dispose };
}

export function useBrowserZoomGuard(options) {
  useEffect(() => {
    const guard = attachBrowserZoomGuard(options);
    return () => guard.dispose();
  }, []);
}
