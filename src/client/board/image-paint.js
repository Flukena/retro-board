// Explicit promotion helps small filtered images during board-wide panning.
// Large layers cost more raster work in Chrome; leave their scheduling to the browser.
export function imageFitsPaintLayer({ w, h }, zoom, viewportSize) {
  return w > 0 && h > 0 && zoom > 0 && viewportSize?.w > 0 && viewportSize.h > 0
    && w * h * zoom ** 2 <= viewportSize.w * viewportSize.h;
}
