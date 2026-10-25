import { useBrowserLayoutEffect } from '../ui/use-browser-layout-effect.js';

const VIEWPORT_GAP_PX = 12;
const VIEWPORT_MARGIN_TOTAL_PX = VIEWPORT_GAP_PX * 2;
const POPUP_GAP_PX = 6;

export function zoneMenuOffset(rect, viewport) {
  const minX = viewport.left + VIEWPORT_GAP_PX;
  const minY = viewport.top + VIEWPORT_GAP_PX;
  const maxX = viewport.left + viewport.width - VIEWPORT_GAP_PX - rect.width;
  const maxY = viewport.top + viewport.height - VIEWPORT_GAP_PX - rect.height;
  return {
    x: Math.max(minX, Math.min(rect.left, maxX)) - rect.left,
    y: Math.max(minY, Math.min(rect.top, maxY)) - rect.top,
  };
}

export function zoneInlineToolWidth(anchor, viewport, rail, zoom) {
  const overlapsRail = rail && rail.top < anchor.bottom && rail.bottom > anchor.top;
  const left = Math.max(viewport.left + VIEWPORT_GAP_PX, overlapsRail ? rail.right + VIEWPORT_GAP_PX : viewport.left);
  const right = Math.min(anchor.right, viewport.left + viewport.width - VIEWPORT_GAP_PX);
  return Math.max(0, right - left) / zoom;
}

function fitPopup(header, popup, zoom) {
  if (!popup) return;
  const window = header.ownerDocument.defaultView;
  const strip = header.querySelector('.rb-zone__tool-strip');
  const compact = strip && window.getComputedStyle(strip).display === 'none';
  const primary = header.querySelector('.rb-zone__admin-action');
  popup.dataset.primaryVisible = primary && window.getComputedStyle(primary).display !== 'none' ? 'true' : 'false';
  popup.style.display = compact ? 'flex' : 'none';
  const visual = window.visualViewport;
  const viewport = { left: visual?.offsetLeft || 0, top: visual?.offsetTop || 0,
    width: visual?.width || window.innerWidth, height: visual?.height || window.innerHeight };
  const anchor = header.querySelector('.rb-zone__menu').getBoundingClientRect();
  if (!compact) {
    const rail = header.ownerDocument.querySelector('.rb-tool-dock')?.getBoundingClientRect();
    header.style.setProperty('--zone-tools-viewport-width', `${zoneInlineToolWidth(anchor, viewport, rail, zoom)}px`);
    return;
  }
  popup.style.maxHeight = `${Math.max(0, viewport.height - VIEWPORT_MARGIN_TOTAL_PX)}px`;
  popup.style.maxWidth = `${Math.max(0, viewport.width - VIEWPORT_MARGIN_TOTAL_PX)}px`;
  const rect = { left: anchor.right - popup.offsetWidth, top: anchor.bottom + POPUP_GAP_PX,
    width: popup.offsetWidth, height: popup.offsetHeight };
  const offset = zoneMenuOffset(rect, viewport);
  popup.style.left = `${rect.left + offset.x}px`;
  popup.style.top = `${rect.top + offset.y}px`;
}

export function useZoneMenuViewport(headerRef, popupRef, mounted, phase, zoom) {
  useBrowserLayoutEffect(() => {
    if (!mounted || !headerRef.current) return undefined;
    const header = headerRef.current;
    const window = header.ownerDocument.defaultView;
    const fit = () => fitPopup(header, popupRef.current, zoom);
    fit();
    const observer = new window.ResizeObserver(fit);
    observer.observe(header);
    window.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('resize', fit);
    };
  }, [headerRef, popupRef, mounted, phase, zoom]);
}
