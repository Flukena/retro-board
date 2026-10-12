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

export const TIMER_EXTEND_MINUTES = Object.freeze([1, 2, 5]);
export const TIMER_URGENT_MS = 30_000;
const SECOND_MS = 1000;
const MINUTE_SECONDS = 60;
const CLOCK_DIGITS = 2;
const CLOCK_PAD = '0';

function timerLabel(remainingMs) {
  const seconds = Math.ceil(remainingMs / SECOND_MS);
  const minutes = Math.floor(seconds / MINUTE_SECONDS);
  const remainder = seconds % MINUTE_SECONDS;
  return `${String(minutes).padStart(CLOCK_DIGITS, CLOCK_PAD)}:${String(remainder).padStart(CLOCK_DIGITS, CLOCK_PAD)}`;
}

export function timerDockModel(zone, now) {
  const { endsAt, voteLimit } = zone.voteTimer;
  const remainingMs = endsAt ? Math.max(0, endsAt - now) : null;
  return {
    zoneId: zone.id,
    title: zone.title,
    voteLimit,
    remainingMs,
    urgent: remainingMs != null && remainingMs < TIMER_URGENT_MS,
    label: remainingMs == null ? null : timerLabel(remainingMs),
  };
}
