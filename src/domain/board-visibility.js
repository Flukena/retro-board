import { effectiveRevealed } from './zone-actions.js';

export const stickyEffectiveRevealed = (sticky, items, allRevealed) => (
  sticky.revealed === false ? false : effectiveRevealed(sticky, items, allRevealed)
);

// One privacy predicate for every non-owner view (card chrome, modal, copy,
// and exports), using shared nested-zone reveal inheritance.
export const isStickyHiddenForUser = (item, allItems, boardAllRevealed, userId) => (
  item?.type === 'sticky'
  && item.private
  && item.authorId !== userId
  && !stickyEffectiveRevealed(item, allItems, boardAllRevealed)
);

export const stickyCloneRevealOverride = (item, items, allRevealed) => (
  item.type === 'sticky' && item.private && !stickyEffectiveRevealed(item, items, allRevealed)
    ? { revealed: false } : {}
);
