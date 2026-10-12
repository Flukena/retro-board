const ZOOM_PERCENT_SCALE = 100;

export const minimapZoomPercent = (zoom) => Math.round(zoom * ZOOM_PERCENT_SCALE);

const finite = (value, fallback = 0) => (
  Number.isFinite(Number(value)) ? Number(value) : fallback
);

const positive = (value, fallback) => {
  const n = finite(value, fallback);
  return n > 0 ? n : fallback;
};

export const viewportWorldRect = (viewport, viewportSize) => {
  const zoom = positive(viewport?.zoom, 1);
  return {
    x: -finite(viewport?.x) / zoom,
    y: -finite(viewport?.y) / zoom,
    w: positive(viewportSize?.w, 1) / zoom,
    h: positive(viewportSize?.h, 1) / zoom,
  };
};

const itemWorldRect = (item) => {
  if (!item || !Number.isFinite(item.x) || !Number.isFinite(item.y)) return null;
  const defaultW = item.type === 'text' ? 400 : 200;
  const defaultH = item.type === 'sticky' ? 180 : item.type === 'text' ? 80 : 200;
  return {
    id: item.id,
    type: item.type,
    color: item.color,
    x: item.x,
    y: item.y,
    w: positive(item.w, defaultW),
    h: positive(item.h, defaultH),
  };
};

const mapWorldRect = (worldRect, model) => ({
  x: model.offsetX + (worldRect.x - model.bounds.x) * model.scale,
  y: model.offsetY + (worldRect.y - model.bounds.y) * model.scale,
  w: worldRect.w * model.scale,
  h: worldRect.h * model.scale,
});

export const minimapViewportRect = (viewport, viewportSize, model) => (
  mapWorldRect(viewportWorldRect(viewport, viewportSize), model)
);

export const buildMinimapModel = ({
  items = [],
  viewport,
  viewportSize,
  width = 220,
  height = 132,
  padding = 8,
}) => {
  const surfaceWidth = positive(width, 220);
  const surfaceHeight = positive(height, 132);
  const safePadding = Math.max(0, Math.min(finite(padding, 8), surfaceWidth / 4, surfaceHeight / 4));
  const view = viewportWorldRect(viewport, viewportSize);
  const itemRects = items.map(itemWorldRect).filter(Boolean);
  const allRects = [...itemRects, view];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  allRects.forEach((rect) => {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  });

  const spanW = Math.max(1, maxX - minX);
  const spanH = Math.max(1, maxY - minY);
  // Keep navigation space around the visible area so the viewport frame does
  // not stick to an edge and short drags can move beyond current content.
  const worldPadX = Math.max(80, view.w * 0.12, spanW * 0.04);
  const worldPadY = Math.max(80, view.h * 0.12, spanH * 0.04);
  const bounds = {
    x: minX - worldPadX,
    y: minY - worldPadY,
    w: spanW + worldPadX * 2,
    h: spanH + worldPadY * 2,
  };
  const innerW = Math.max(1, surfaceWidth - safePadding * 2);
  const innerH = Math.max(1, surfaceHeight - safePadding * 2);
  const scale = Math.min(innerW / bounds.w, innerH / bounds.h);
  const drawnW = bounds.w * scale;
  const drawnH = bounds.h * scale;
  const model = {
    width: surfaceWidth,
    height: surfaceHeight,
    viewportSize: {
      w: positive(viewportSize?.w, 1),
      h: positive(viewportSize?.h, 1),
    },
    bounds,
    scale,
    offsetX: (surfaceWidth - drawnW) / 2,
    offsetY: (surfaceHeight - drawnH) / 2,
  };

  return {
    ...model,
    items: itemRects.map((item) => ({ ...item, ...mapWorldRect(item, model) })),
    viewport: minimapViewportRect(viewport, viewportSize, model),
  };
};

export const minimapPointToWorld = (point, surfaceRect, model) => {
  const rectWidth = positive(surfaceRect?.width, model.width);
  const rectHeight = positive(surfaceRect?.height, model.height);
  const localX = (finite(point?.clientX) - finite(surfaceRect?.left)) * (model.width / rectWidth);
  const localY = (finite(point?.clientY) - finite(surfaceRect?.top)) * (model.height / rectHeight);
  const drawnRight = model.offsetX + model.bounds.w * model.scale;
  const drawnBottom = model.offsetY + model.bounds.h * model.scale;
  const clampedX = Math.max(model.offsetX, Math.min(drawnRight, localX));
  const clampedY = Math.max(model.offsetY, Math.min(drawnBottom, localY));
  return {
    x: model.bounds.x + (clampedX - model.offsetX) / model.scale,
    y: model.bounds.y + (clampedY - model.offsetY) / model.scale,
  };
};

export const centerViewportOnWorld = (viewport, viewportSize, worldPoint) => {
  const zoom = positive(viewport?.zoom, 1);
  return {
    x: positive(viewportSize?.w, 1) / 2 - finite(worldPoint?.x) * zoom,
    y: positive(viewportSize?.h, 1) / 2 - finite(worldPoint?.y) * zoom,
    zoom,
  };
};
