import {
  MOBILE_EDITOR_CLEARANCE_PX, MOBILE_EDITOR_VISIBILITY_EVENT, mobileEditorFocusViewport, mobileEditorPanDelta,
} from './mobile-editing.js';

const EDITOR_SELECTOR = '.rb-mobile-editor__input';
// Focus zoom frames the whole card; an empty input alone is only a few pixels wide.
const FOCUS_CARD_SELECTOR = '[data-sticky-id]';
const HEIGHT_LIMIT_PROPERTY = '--rb-inline-editor-max-height-px';
const WIDTH_LIMIT_PROPERTY = '--rb-inline-editor-max-width-px';
const MIN_EDITOR_HEIGHT_SCREEN_PX = 24;
const MIN_EDITOR_WIDTH_SCREEN_PX = 44;

function controlRect(root, selector) {
  const rect = root.querySelector(selector)?.getBoundingClientRect();
  return rect?.width > 0 && rect.height > 0 ? rect : null;
}

export function mobileEditorInsets(root, viewport) {
  const header = controlRect(root, '.rb-topbar');
  const dock = controlRect(root, '.rb-tool-dock');
  const done = controlRect(root, '.rb-mobile-editor__done');
  return {
    left: Math.max(0, (dock?.right ?? viewport.left) - viewport.left),
    top: Math.max(0, (header?.bottom ?? viewport.top) - viewport.top),
    bottom: Math.max(0, viewport.bottom - (done?.top ?? viewport.bottom)),
  };
}

export function mobileEditorHeightLimitPx(viewport, insets, zoom) {
  const availableHeightPx = viewport.height - insets.top - insets.bottom
    - MOBILE_EDITOR_CLEARANCE_PX - MOBILE_EDITOR_CLEARANCE_PX;
  return Math.max(MIN_EDITOR_HEIGHT_SCREEN_PX, availableHeightPx) / zoom;
}

export function mobileEditorWidthLimitPx(viewport, insets, zoom) {
  const availableWidthPx = viewport.width - insets.left - (insets.right ?? 0)
    - MOBILE_EDITOR_CLEARANCE_PX - MOBILE_EDITOR_CLEARANCE_PX;
  return Math.max(MIN_EDITOR_WIDTH_SCREEN_PX, availableWidthPx) / zoom;
}

function releaseEditor(editor) {
  editor.style.removeProperty(HEIGHT_LIMIT_PROPERTY);
  editor.style.removeProperty(WIDTH_LIMIT_PROPERTY);
  delete editor.dataset.mobileHeightBounded;
  delete editor.dataset.mobileWidthBounded;
}

function boundEditorSize(editor, heightLimitPx, widthLimitPx, zoom) {
  editor.style.removeProperty(HEIGHT_LIMIT_PROPERTY);
  editor.style.removeProperty(WIDTH_LIMIT_PROPERTY);
  const natural = editor.getBoundingClientRect();
  const heightBounded = natural.height > heightLimitPx * zoom;
  const widthBounded = natural.width > widthLimitPx * zoom;
  if (heightBounded) editor.style.setProperty(HEIGHT_LIMIT_PROPERTY, `${heightLimitPx}px`);
  if (widthBounded) editor.style.setProperty(WIDTH_LIMIT_PROPERTY, `${widthLimitPx}px`);
  editor.dataset.mobileHeightBounded = String(heightBounded);
  editor.dataset.mobileWidthBounded = String(widthBounded);
}

/** Coordinates DOM visibility and viewport operations without changing board items. */
export function attachMobileEditorViewport(root, { getViewport, commitViewport }) {
  const view = root.ownerDocument.defaultView;
  let activeEditor = null;
  const reveal = (event) => {
    const editor = event.target;
    const visible = event.detail?.viewportRect;
    if (!visible || !editor?.matches?.(EDITOR_SELECTOR) || !root.contains(editor)) return;
    if (root.ownerDocument.activeElement !== editor) return;
    const viewport = getViewport();
    const insets = mobileEditorInsets(root, visible);
    if (activeEditor && activeEditor !== editor) releaseEditor(activeEditor);
    activeEditor = editor;
    const focusTarget = editor.closest?.(FOCUS_CARD_SELECTOR) ?? editor;
    const focused = mobileEditorFocusViewport({ editor: focusTarget.getBoundingClientRect(), visible, insets, viewport,
      origin: root.getBoundingClientRect(), fitWide: focusTarget !== editor });
    if (focused) { commitViewport(focused); return; }
    boundEditorSize(editor, mobileEditorHeightLimitPx(visible, insets, viewport.zoom),
      mobileEditorWidthLimitPx(visible, insets, viewport.zoom), viewport.zoom);
    const delta = mobileEditorPanDelta(editor.getBoundingClientRect(), visible, insets);
    if (delta.x === 0 && delta.y === 0) return;
    commitViewport({ ...viewport, x: viewport.x + delta.x, y: viewport.y + delta.y });
  };
  const finish = (event) => {
    if (activeEditor !== event.target) return;
    releaseEditor(activeEditor);
    activeEditor = null;
  };
  view.addEventListener(MOBILE_EDITOR_VISIBILITY_EVENT, reveal);
  view.addEventListener('focusout', finish);
  return () => {
    view.removeEventListener(MOBILE_EDITOR_VISIBILITY_EVENT, reveal);
    view.removeEventListener('focusout', finish);
    if (activeEditor) releaseEditor(activeEditor);
  };
}
