import * as Y from 'yjs';

export const isCollaborativeTextField = (field) => field === 'text' || field === 'title';

export const collaborativeTextToString = (value) => (
  value instanceof Y.Text ? value.toString() : value
);

export const createCollaborativeText = (value = '') => {
  const sharedText = new Y.Text();
  const text = String(value ?? '');
  if (text) sharedText.insert(0, text);
  return sharedText;
};

// Describe one minimal contiguous replacement. Keeping the unchanged prefix
// and suffix intact is what lets Y.Text merge simultaneous typing instead of
// treating every keystroke as a whole-field overwrite.
export const describeTextReplacement = (previousValue, nextValue) => {
  const previous = String(previousValue ?? '');
  const next = String(nextValue ?? '');
  let index = 0;
  const prefixLimit = Math.min(previous.length, next.length);
  while (index < prefixLimit && previous[index] === next[index]) index += 1;

  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (
    previousEnd > index
    && nextEnd > index
    && previous[previousEnd - 1] === next[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  return {
    index,
    deleteCount: previousEnd - index,
    insertText: next.slice(index, nextEnd),
  };
};

export const replaceCollaborativeText = (sharedText, nextValue) => {
  if (!(sharedText instanceof Y.Text)) return false;
  const next = String(nextValue ?? '');
  const previous = sharedText.toString();
  if (previous === next) return false;
  const change = describeTextReplacement(previous, next);
  if (change.deleteCount > 0) sharedText.delete(change.index, change.deleteCount);
  if (change.insertText) sharedText.insert(change.index, change.insertText);
  return true;
};

// A newly created item map is populated before it is attached to the document.
// Yjs permits writes to a detached type, but reading it emits an "Invalid
// access" warning. Only inspect an existing field after the parent map is
// integrated; detached item maps are empty at the production call sites.
export const setCollaborativeTextField = (parentMap, field, value) => {
  if (!(parentMap instanceof Y.Map) || typeof field !== 'string') return false;
  const current = parentMap.doc ? parentMap.get(field) : undefined;
  if (current instanceof Y.Text) return replaceCollaborativeText(current, value);
  parentMap.set(field, createCollaborativeText(value));
  return true;
};

export const mapSelectionIndexThroughReplacement = (position, change) => {
  const index = Number.isFinite(position) ? Math.max(0, position) : 0;
  const changeStart = change?.index ?? 0;
  const removedEnd = changeStart + (change?.deleteCount ?? 0);
  const insertedLength = change?.insertText?.length ?? 0;
  if (index < changeStart) return index;
  if (index >= removedEnd) return index + insertedLength - (change?.deleteCount ?? 0);
  return changeStart + insertedLength;
};
