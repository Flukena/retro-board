export const TOPBAR_INSET_PX = 12;
export const TOPBAR_H_PX = 60;
export const TOPBAR_BOTTOM_PX = TOPBAR_INSET_PX + TOPBAR_H_PX;
export const TOOLBAR_TOPBAR_CLEARANCE_PX = 52;
export const TOOLBAR_MIN_ANCHOR_PX = TOPBAR_BOTTOM_PX + TOOLBAR_TOPBAR_CLEARANCE_PX;
export const SELECTION_TOOLBAR_GAP_PX = 14;
export const TOP_STACK_GAP_PX = 12;
export const FOLLOW_BANNER_H_PX = 48;
export const TIMER_DOCK_H_PX = 56;
export const TOP_STACK_ITEM_GAP_PX = 10;
export const DOCK_INSET_PX = 16;
export const DOCK_TILE_H_PX = 62;
export const DOCK_PADDING_PX = 8;
export const CHROME_BORDER_PX = 1.5;
export const DOCK_H_PX = DOCK_TILE_H_PX + 2 * (DOCK_PADDING_PX + CHROME_BORDER_PX);
export const TOAST_DOCK_GAP_PX = 12;
export const TOAST_BOTTOM_PX = DOCK_INSET_PX + DOCK_H_PX + TOAST_DOCK_GAP_PX;
export const ZOOM_BUTTON_H_PX = 30;
export const ZOOM_PADDING_PX = 4;
export const ZOOM_CONTROLS_H_PX = ZOOM_BUTTON_H_PX + 2 * (ZOOM_PADDING_PX + CHROME_BORDER_PX);
export const MINIMAP_W_PX = 220;
export const MINIMAP_H_PX = 132;
export const MINIMAP_PANEL_PADDING_TOTAL_PX = 16;
export const MINIMAP_GRID_PITCH_PX = 10;
export const MINIMAP_ZOOM_GAP_PX = 3;
export const MINIMAP_BOTTOM_PX = DOCK_INSET_PX + ZOOM_CONTROLS_H_PX + MINIMAP_ZOOM_GAP_PX;
export const CHROME_ICON_SIZE_PX = Object.freeze({ TOOL: 16, TIMER: 18, SMALL: 14 });
export const GRID_PITCH_PX = 24;
export const TOPBAR_ICON_SIZE_PX = Object.freeze({
  ACTION: 16, MENU: 15, CHIP: 12, TOGGLE: 14, BRAND: 18, CROWN: 9,
});

export function topStackHeightPx({ hasFollow, timerCount }) {
  const itemCount = Number(hasFollow) + timerCount;
  const gaps = Math.max(0, itemCount - 1);
  return Number(hasFollow) * FOLLOW_BANNER_H_PX + timerCount * TIMER_DOCK_H_PX
    + gaps * TOP_STACK_ITEM_GAP_PX;
}

export function toolbarAnchorY(rawY, stackHeightPx = 0) {
  const stackClearancePx = stackHeightPx > 0 ? TOP_STACK_GAP_PX + stackHeightPx : 0;
  const minimum = TOOLBAR_MIN_ANCHOR_PX + stackClearancePx;
  return Math.max(rawY, minimum);
}

export const Z = Object.freeze({
  GRID: 0,
  CANVAS: 1,
  SELECTION_OUTLINE: 24,
  SELECTION_HANDLE: 25,
  SELECTION_TOOLBAR: 30,
  TOOLBAR_POPOVER_BACKDROP: 31,
  TOOLBAR_POPOVER: 32,
  MARQUEE: 35,
  CURSOR_LAYER: 36,
  DOCK: 40,
  TOP_CENTER_STACK: 49,
  TOPBAR: 50,
  POPOVER_BACKDROP: 59,
  POPOVER: 60,
  MODAL: 100,
  MODAL_RAISED: 110,
  TOAST: 200,
  REMOTE_SELECTION_LABEL: 2147483644,
  REMOTE_EDITOR_BOX: 2147483645,
  REMOTE_EDITOR_LABEL: 2147483646,
});
