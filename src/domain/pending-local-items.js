export const RECENT_LOCAL_ITEM_WINDOW_MS = 8000;

/**
 * @param {{id:string, authorId?:string, createdAt?:number}|undefined} item
 * @param {{isUndoRedo:boolean, deletedItemIds:Set<string>, userId:string, nowMs:number}} context
 */
export const shouldPreserveRecentLocalItem = (item, { isUndoRedo, deletedItemIds, userId, nowMs }) => (
  !isUndoRedo && !!item && item.authorId === userId
  && !deletedItemIds.has(item.id)
  && (item.createdAt || 0) > nowMs - RECENT_LOCAL_ITEM_WINDOW_MS
);
