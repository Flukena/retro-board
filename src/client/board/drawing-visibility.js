const leases = new WeakMap();
export function hideDrawingImage(document, id) {
  if (!id) return () => {};
  const element = document.querySelector(`[data-image-id="${CSS.escape(id)}"]`);
  if (!element) return () => {};
  const lease = leases.get(element) ?? { count: 0, previous: element.style.visibility };
  lease.count++; leases.set(element, lease); element.style.visibility = 'hidden';
  return () => {
    lease.count--;
    if (!lease.count) { element.style.visibility = lease.previous; leases.delete(element); }
  };
}
