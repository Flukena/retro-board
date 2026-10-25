const TEXT_ITEM_TYPES = new Set(['sticky', 'text']);
export const MOBILE_EDITOR_VISIBILITY_EVENT = 'rb:mobile-editor-visibility';
export const MOBILE_EDITOR_CLEARANCE_PX = 12;

export function mobileEditableField(item) {
  if (!item) return null;
  if (item.type === 'zone') return 'title';
  return TEXT_ITEM_TYPES.has(item.type) ? 'text' : null;
}

export function mobileViewportStyle(viewport, layoutHeightPx = 0) {
  if (!viewport) return {};
  return {
    '--rb-mobile-keyboard-bottom-px': `${Math.max(0, layoutHeightPx - viewport.offsetTop - viewport.height)}px`,
  };
}

export function editorContentOverflowPx(node) {
  const viewportBounded = node.dataset.mobileHeightBounded === 'true' || node.dataset.mobileWidthBounded === 'true';
  return viewportBounded ? 0 : node.scrollHeight - node.clientHeight;
}

function axisPanDelta(start, end, visibleStart, visibleEnd) {
  if (end - start > visibleEnd - visibleStart || start < visibleStart) return visibleStart - start;
  return end > visibleEnd ? visibleEnd - end : 0;
}

export function mobileEditorPanDelta(editor, viewport, insets = {}) {
  const left = viewport.left + (insets.left ?? 0) + MOBILE_EDITOR_CLEARANCE_PX;
  const top = viewport.top + (insets.top ?? 0) + MOBILE_EDITOR_CLEARANCE_PX;
  const right = Math.max(left, viewport.right - (insets.right ?? 0) - MOBILE_EDITOR_CLEARANCE_PX);
  const bottom = Math.max(top, viewport.bottom - (insets.bottom ?? 0) - MOBILE_EDITOR_CLEARANCE_PX);
  return {
    x: axisPanDelta(editor.left, editor.right, left, right),
    y: axisPanDelta(editor.top, editor.bottom, top, bottom),
  };
}
