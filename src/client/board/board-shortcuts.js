// Physical key codes keep letter shortcuts usable with Thai and other layouts.
const plain = (...codes) => codes.map(code => ({ code }));
const primary = (...codes) => codes.map(code => ({ code, primary: true }));
const shifted = (...codes) => codes.map(code => ({ code, shiftKey: true }));
const item = (action, display, bindings) => ({ action, display, labelKey: `shortcut.${action}`, bindings });

export const BOARD_SHORTCUTS = Object.freeze([
  item('selectTool', 'V', plain('KeyV')),
  item('stickyTool', 'S', plain('KeyS')),
  item('textTool', 'T', plain('KeyT')),
  item('zoneTool', 'Z', plain('KeyZ')),
  item('drawTool', 'P', plain('KeyP')),
  item('imageTool', 'I', plain('KeyI')),
  item('pan', 'Space', plain('Space')),
  item('cancel', 'Esc', plain('Escape')),
  item('delete', 'Delete / Backspace', plain('Delete', 'Backspace')),
  item('undo', 'Ctrl / ⌘ + Z', primary('KeyZ')),
  item('redo', 'Ctrl / ⌘ + Shift + Z / Ctrl / ⌘ + Y', [...primary('KeyY'), { code: 'KeyZ', primary: true, shiftKey: true }]),
  item('copy', 'Ctrl / ⌘ + C', primary('KeyC')),
  item('cut', 'Ctrl / ⌘ + X', primary('KeyX')),
  item('paste', 'Ctrl / ⌘ + V', primary('KeyV')),
  item('duplicate', 'Ctrl / ⌘ + D', primary('KeyD')),
  item('selectAll', 'Ctrl / ⌘ + A', primary('KeyA')),
  item('fitContent', 'Shift + 1', shifted('Digit1')),
  item('fitSelection', 'Shift + 2', shifted('Digit2')),
  item('zoomIn', 'Ctrl / ⌘ + +', [{ code: 'Equal', primary: true }, { code: 'Equal', primary: true, shiftKey: true }, ...primary('NumpadAdd')]),
  item('zoomOut', 'Ctrl / ⌘ + −', primary('Minus', 'NumpadSubtract')),
  item('zoomReset', 'Ctrl / ⌘ + 0', primary('Digit0', 'Numpad0')),
  item('front', ']', plain('BracketRight')),
  item('back', '[', plain('BracketLeft')),
  item('forward', 'Ctrl / ⌘ + ]', primary('BracketRight')),
  item('backward', 'Ctrl / ⌘ + [', primary('BracketLeft')),
]);

export function resolveBoardShortcut(event) {
  if (event.altKey) return null;
  const hasPrimary = Boolean(event.primary || event.ctrlKey || event.metaKey);
  const code = event.code || (/^[a-z]$/i.test(event.key ?? '') ? `Key${event.key.toUpperCase()}` : event.key);
  const bindingMatches = binding => binding.code === code
    && Boolean(binding.primary) === hasPrimary
    && Boolean(binding.shiftKey) === Boolean(event.shiftKey);
  return BOARD_SHORTCUTS.find(shortcut => shortcut.bindings.some(bindingMatches))?.action ?? null;
}
