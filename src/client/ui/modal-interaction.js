const FOCUSABLE_SELECTOR = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';
const MODAL_SELECTOR = '.rb-modal';
const KEY_LISTENER_OPTIONS = Object.freeze({ capture: true });

function isTopModal(overlay) {
  const layers = [...overlay.ownerDocument.querySelectorAll(MODAL_SELECTOR)];
  layers.sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex));
  return layers.at(-1) === overlay;
}

function visibleControls(panel) {
  return [...panel.querySelectorAll(FOCUSABLE_SELECTOR)]
    .filter(element => element.getClientRects().length > 0 && element.tabIndex >= 0);
}

function wrapFocus(event, panel) {
  const controls = visibleControls(panel);
  const first = controls[0] || panel;
  const last = controls.at(-1) || panel;
  const active = panel.ownerDocument.activeElement;
  const outside = !panel.contains(active);
  if (event.shiftKey ? active === first || outside : active === last || outside) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

function updateViewport(overlay, viewport) {
  if (!viewport) return;
  for (const [property, value] of Object.entries({
    height: viewport.height, width: viewport.width,
    top: viewport.offsetTop, left: viewport.offsetLeft,
  })) overlay.style.setProperty(`--rb-modal-viewport-${property}`, `${value}px`);
}

export function subscribeModalInteraction(overlay, { dismiss, opener }) {
  const document = overlay.ownerDocument;
  const window = document.defaultView;
  const viewport = window.visualViewport;
  const panel = overlay.querySelector('.rb-modal__panel');
  let frame = null;
  const resize = () => {
    if (frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      updateViewport(overlay, viewport);
      if (panel.contains(document.activeElement)) {
        document.activeElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    });
  };
  const keydown = event => {
    if (!isTopModal(overlay) || event.isComposing) return;
    if (event.key === 'Tab') wrapFocus(event, panel);
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dismiss();
  };
  updateViewport(overlay, viewport);
  if (!panel.contains(document.activeElement)) (visibleControls(panel)[0] || panel).focus();
  document.addEventListener('keydown', keydown, KEY_LISTENER_OPTIONS);
  viewport?.addEventListener('resize', resize);
  viewport?.addEventListener('scroll', resize);
  return () => {
    document.removeEventListener('keydown', keydown, KEY_LISTENER_OPTIONS);
    viewport?.removeEventListener('resize', resize);
    viewport?.removeEventListener('scroll', resize);
    if (frame !== null) window.cancelAnimationFrame(frame);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
}
