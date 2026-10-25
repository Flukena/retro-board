export function observeContentSize(node, measure, Observer = globalThis.ResizeObserver, view = globalThis) {
  if (typeof Observer !== 'function') {
    measure();
    return () => {};
  }
  let frame = null;
  const observer = new Observer(() => {
    if (frame === null) frame = view.requestAnimationFrame(() => { frame = null; measure(); });
  });
  observer.observe(node);
  return () => {
    observer.disconnect();
    if (frame !== null) view.cancelAnimationFrame(frame);
  };
}
