import { useCallback, useMemo, useState } from 'react';
import { actionItemsOf, openActionCount } from '../../domain/action-item.js';

/** Action-item rows for this viewer plus the open/closed state of their dialog. */
export function useActionItems({ items, userId, allRevealed }) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => actionItemsOf(items, { userId, allRevealed }), [items, userId, allRevealed]);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  return { rows, openCount: openActionCount(rows), open, show, hide };
}
