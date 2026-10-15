import { effectiveRevealed } from './zone-actions.js';

// One privacy predicate for every non-owner view (card chrome, modal, copy,
// and exports), using shared nested-zone reveal inheritance.
export const isStickyHiddenForUser = (item, allItems, boardAllRevealed, userId) => (
  item?.type === 'sticky'
  && item.private
  && item.authorId !== userId
  && !effectiveRevealed(item, allItems, boardAllRevealed)
);
