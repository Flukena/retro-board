// Convert a browser pointer position into the board's world coordinate space.
// The measured element sits at world (0, 0), so its rendered rect captures the
// complete browser transform: canvas offset, pan, board zoom, and CSS/browser
// zoom. Reading that result is more reliable than reconstructing the composed
// scale from viewport state and the fixed canvas's layout metrics.
export const clientPointToWorld = (clientX, clientY, worldMeasure) => {
  if (!worldMeasure) return null;
  const rect = worldMeasure.getBoundingClientRect();
  const scaleX = rect.width / worldMeasure.offsetWidth;
  const scaleY = rect.height / worldMeasure.offsetHeight;
  if (!(scaleX > 0) || !(scaleY > 0)) return null;
  return {
    x: (clientX - rect.left) / scaleX,
    y: (clientY - rect.top) / scaleY,
  };
};
