export const VIEWPORT_ZOOM_MIN = 0.05;
export const VIEWPORT_ZOOM_MAX = 3;
export const GRID_DOTS_MIN_ZOOM = 0.15;
// At this scale a default sticky is under 56px wide; keep tiny chrome out of the paint tree.
export const CARD_OVERVIEW_ZOOM_MAX = 0.2;
export const CARD_OVERVIEW_MAX_EDGE_PX = 400;
export const CARD_OVERVIEW_TEXT_MAX_LENGTH = 200;
export const CARD_OVERVIEW_FOOTER_HEIGHT_PX = 48;

export function cardOverviewAtZoom(zoom) {
  return zoom < CARD_OVERVIEW_ZOOM_MAX;
}

export function settledCardRenderState(viewport) {
  return { viewport, compact: cardOverviewAtZoom(viewport.zoom) };
}
