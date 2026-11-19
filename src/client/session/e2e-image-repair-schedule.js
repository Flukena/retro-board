const IMAGE_REPAIR_DEBOUNCE_MS = 1000;

/**
 * Decides WHEN image repair runs (the repair itself is serial and idempotent). It runs after a key epoch change
 * and again, debounced, whenever the document changes while an earlier key is held, because replay or a peer can
 * still bring old references. It only runs while the provider has read the whole log (appliedSeq === head);
 * otherwise it waits another debounce interval.
 */
export function createImageRepairScheduler({
  ydoc, provider, getRoomKey, repair, debounceMs = IMAGE_REPAIR_DEBOUNCE_MS, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let timer = null;
  let destroyed = false;
  const hasEarlierKey = () => (getRoomKey()?.previousKeys?.size ?? 0) > 0;
  const run = () => {
    timer = null;
    if (destroyed || !hasEarlierKey()) return;
    if (provider.appliedSeq !== provider.head) { request(); return; }
    Promise.resolve(repair()).then((result) => { if (result?.failed > 0) request(); }, request);
  };
  function request() {
    if (destroyed || timer !== null || !hasEarlierKey()) return;
    timer = setTimer(run, debounceMs);
  }
  const onUpdate = () => request();
  ydoc.on('update', onUpdate);
  return {
    request,
    destroy() {
      destroyed = true;
      ydoc.off('update', onUpdate);
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
