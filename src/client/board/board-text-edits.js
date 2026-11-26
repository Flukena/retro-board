import { BOARD_TEXT_MAX_LENGTH, ZONE_TITLE_MAX_LENGTH } from '../../domain/security-boundaries.js';
import { stickyTextEditPatch } from '../../domain/sticky-editor.js';

export function boundBoardTextPatch(patch) {
  const bounded = { ...patch };
  if (typeof bounded.text === 'string') bounded.text = bounded.text.slice(0, BOARD_TEXT_MAX_LENGTH);
  if (typeof bounded.title === 'string') bounded.title = bounded.title.slice(0, ZONE_TITLE_MAX_LENGTH);
  return bounded;
}

export function applyOptimisticItemPatch(item, patch, editor) {
  const edited = { ...item, ...stickyTextEditPatch(item, patch, editor) };
  if (edited.lastEditor === undefined) delete edited.lastEditor;
  return edited;
}
