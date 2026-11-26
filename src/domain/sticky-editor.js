import { isSafeId } from './comment-schema.js';
import { DISPLAY_NAME_MAX_LENGTH } from './security-boundaries.js';

const STICKY_EDITOR_FIELD_COUNT = 2;

export function isStickyLastEditor(item, editor) {
  return item.type === 'sticky' && editor != null && typeof editor === 'object' && !Array.isArray(editor)
    && Object.hasOwn(editor, 'userId') && Object.hasOwn(editor, 'name') && Object.keys(editor).length === STICKY_EDITOR_FIELD_COUNT
    && isSafeId(editor.userId) && editor.userId !== item.authorId
    && typeof editor.name === 'string' && editor.name.length <= DISPLAY_NAME_MAX_LENGTH && editor.name.trim() !== '';
}

export function stickyTextEditPatch(item, patch, editor) {
  if (item.type !== 'sticky' || typeof patch.text !== 'string' || patch.text === (item.text ?? '')) return patch;
  const lastEditor = isStickyLastEditor(item, editor) ? editor : undefined;
  if (item.lastEditor?.userId === lastEditor?.userId && item.lastEditor?.name === lastEditor?.name) return patch;
  return { ...patch, lastEditor };
}
