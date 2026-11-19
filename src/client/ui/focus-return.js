/**
 * Moves focus to `targetRef` when the focused element sits inside `rootRef`. Call it before closing a popup:
 * closing unmounts the focused item, which would otherwise drop focus to the page.
 */
export function focusIfInside(rootRef, targetRef) {
  const root = rootRef.current;
  if (root?.contains(root.ownerDocument.activeElement)) targetRef.current?.focus();
}
