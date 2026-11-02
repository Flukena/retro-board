const leases = new WeakMap();
export function hideDrawingImage(document, id) {
  if (!id) return () => {};
  const selector = `[data-image-id="${CSS.escape(id)}"]`;
  const element = document.querySelector(selector);
  if (element) return hideElement(element);
  const Observer = document.defaultView?.MutationObserver;
  if (!Observer || !document.documentElement) return () => {};
  let release = () => {};
  const observer = new Observer(() => {
    const found = document.querySelector(selector);
    if (!found) return;
    observer.disconnect(); release = hideElement(found);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return () => { observer.disconnect(); release(); };
}

function hideElement(element) {
  const lease = leases.get(element) ?? { count: 0, previous: element.style.visibility };
  lease.count++; leases.set(element, lease); element.style.visibility = 'hidden';
  return () => {
    lease.count--;
    if (!lease.count) { element.style.visibility = lease.previous; leases.delete(element); }
  };
}
