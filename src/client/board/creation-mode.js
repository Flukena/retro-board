// Tools that wait for a click/tap on the board before they create anything.
export const CREATION_MODE = Object.freeze({ TEXT: 'text', ZONE: 'zone' });
const CENTER_DIVISOR = 2;

export const toggleCreationMode = (current, mode) => (current === mode ? null : mode);

export const textPlacementAt = (point, size) => ({
  x: point.x - size.w / CENTER_DIVISOR,
  y: point.y - size.h / CENTER_DIVISOR,
});
