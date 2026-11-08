/**
 * The rendered URL of one encrypted image slot. It only ever exposes the URL of the lease that is live for the
 * current source: switching source, a failed load or disposal clears it BEFORE the lease is released, so a
 * revoked blob URL is never shown. `onChange({ src, url })` receives every state.
 */
export function createImageUrlSlot({ resolve, onChange }) {
  let lease = null;
  let disposed = false;
  const publish = (src, url) => { if (!disposed) onChange({ src, url }); };
  const drop = () => {
    if (!lease) return;
    const old = lease;
    lease = null;
    old.release();
  };
  return {
    setSrc(src) {
      publish(src, null);
      drop();
      if (!src) return;
      const mine = resolve(src);
      lease = mine;
      mine.url.then(
        (url) => { if (lease === mine) publish(src, url); },
        () => { if (lease === mine) publish(src, null); },
      );
    },
    dispose() {
      publish(null, null);
      disposed = true;
      drop();
    },
  };
}
