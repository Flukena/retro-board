export function adminPillModel({ adminUserId, adminName, presence, onlineUsers, fallbackName }) {
  if (!adminUserId) return null;
  return {
    name: presence[adminUserId]?.name || adminName || fallbackName,
    isOnline: onlineUsers.some((user) => user.userId === adminUserId),
  };
}

export function playerRows({ onlineUsers, userId, adminUserId, followedUserId, votesUsedByUser, limit }) {
  return onlineUsers.map((user) => {
    const used = votesUsedByUser.get(user.userId) || 0;
    return { ...user, isMe: user.userId === userId, isAdmin: user.userId === adminUserId,
      isFollowing: user.userId === followedUserId, used, limit, isFull: limit != null && used >= limit };
  });
}

export function shareLinkModel(origin, code, token) {
  const manualCode = `${code}${token ? `#${token}` : ''}`;
  return { url: `${origin}/b/${manualCode}`, manualCode };
}

export function transferCandidates(players) {
  return players.filter((player) => !player.isMe);
}
