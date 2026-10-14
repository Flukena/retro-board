export const VIEWPORT_ZOOM_MIN = 0.05;
export const VIEWPORT_ZOOM_MAX = 3;
export const GRID_DOTS_MIN_ZOOM = 0.15;
export const CARD_OVERVIEW_ZOOM_MAX = 0.075;

export function cardOverviewAtZoom(zoom) {
  return zoom < CARD_OVERVIEW_ZOOM_MAX;
}
