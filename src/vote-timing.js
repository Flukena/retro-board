export const voteTimerIsOpen = (timer, now) => (
  !!timer && (!timer.endsAt || timer.endsAt > now)
);

// This signature stays stable while clocks tick and changes only when a timer
// crosses its deadline. Card rendering can depend on it without rebuilding the
// entire board every second during a meeting.
export const voteTimerPhaseSignature = (items, now) => (
  items
    .filter((item) => item?.type === 'zone')
    .map((zone) => `${zone.id}:${zone.voteTimer ? (voteTimerIsOpen(zone.voteTimer, now) ? 'open' : 'expired') : 'none'}`)
    .sort()
    .join('|')
);
