const PAN_INTERACTION = 'pan';
const CROSSHAIR_CREATION_MODES = new Set(['zone', 'select', 'draw']);
const TEXT_CREATION_MODE = 'text';
const CANVAS_CURSOR = Object.freeze({ PANNING: 'grabbing', SPACE_HELD: 'grab', CREATION: 'crosshair', TEXT: 'text', IDLE: 'default' });

export const canvasCursor = (interactionKind, spaceHeld, creationMode) => {
  if (interactionKind === PAN_INTERACTION) return CANVAS_CURSOR.PANNING;
  if (spaceHeld) return CANVAS_CURSOR.SPACE_HELD;
  if (creationMode === TEXT_CREATION_MODE) return CANVAS_CURSOR.TEXT;
  return CROSSHAIR_CREATION_MODES.has(creationMode) ? CANVAS_CURSOR.CREATION : CANVAS_CURSOR.IDLE;
};
