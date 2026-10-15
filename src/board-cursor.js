const PAN_INTERACTION = 'pan';
const CROSSHAIR_CREATION_MODES = new Set(['zone', 'select']);
const CANVAS_CURSOR = Object.freeze({ PANNING: 'grabbing', SPACE_HELD: 'grab', CREATION: 'crosshair', IDLE: 'default' });

export const canvasCursor = (interactionKind, spaceHeld, creationMode) => {
  if (interactionKind === PAN_INTERACTION) return CANVAS_CURSOR.PANNING;
  if (spaceHeld) return CANVAS_CURSOR.SPACE_HELD;
  return CROSSHAIR_CREATION_MODES.has(creationMode) ? CANVAS_CURSOR.CREATION : CANVAS_CURSOR.IDLE;
};
