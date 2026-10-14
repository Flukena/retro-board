const summarizeRemoteParticipants = (editingItems) => {
  const summaries = new Map();
  if (!(editingItems instanceof Map)) return summaries;

  editingItems.forEach((owners, itemId) => {
    if (typeof itemId !== 'string' || !(owners instanceof Map) || owners.size === 0) return;
    const unique = new Map();
    Array.from(owners.entries())
      .sort(([a], [b]) => String(a).localeCompare(String(b), undefined, { numeric: true }))
      .forEach(([clientId, user]) => {
        const userId = typeof user?.userId === 'string' && user.userId
          ? user.userId
          : `client-${clientId}`;
        if (unique.has(userId)) return;
        unique.set(userId, {
          userId,
          name: typeof user?.name === 'string' && user.name.trim() ? user.name.trim() : 'Guest',
        });
      });
    const editors = Array.from(unique.values());
    if (!editors.length) return;
    summaries.set(itemId, {
      ...editors[0],
      extraCount: Math.max(0, editors.length - 1),
    });
  });

  return summaries;
};

export const summarizeRemoteEditors = summarizeRemoteParticipants;
// Selection reveals where someone is looking, so it is hidden while a vote is open.
export const summarizeRemoteSelectors = (selectedItems, voteOpen = false) => (
  voteOpen ? new Map() : summarizeRemoteParticipants(selectedItems)
);
