import { TIMER_URGENT_MS, clampToRange, countdownLabel } from './countdown.js';

export const voteTimerIsOpen = (timer, now) => (
  !!timer && (!timer.endsAt || timer.endsAt > now)
);

export const boardVoteIsOpen = (items, now) => (
  items.some((item) => item?.type === 'zone' && voteTimerIsOpen(item.voteTimer, now))
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

export function timerDockModel(zone, now) {
  const { endsAt, voteLimit } = zone.voteTimer;
  const remainingMs = endsAt ? Math.max(0, endsAt - now) : null;
  return {
    zoneId: zone.id,
    title: zone.title,
    voteLimit,
    remainingMs,
    urgent: remainingMs != null && remainingMs < TIMER_URGENT_MS,
    label: remainingMs == null ? null : countdownLabel(remainingMs),
  };
}

export const TIMER_PRESETS = Object.freeze([1, 3, 5, 10]);
export const VOTE_LIMIT_PRESETS = Object.freeze([1, 3, 5, 10]);
export const VOTE_LIMIT_MIN_VOTES = 1;
export const VOTE_LIMIT_MAX_VOTES = 50;
export const TIMER_DEFAULT_MINUTES = 3;
export const VOTE_LIMIT_DEFAULT_VOTES = 3;

export function clampVoteLimit(value) {
  return clampToRange(value, VOTE_LIMIT_MIN_VOTES, VOTE_LIMIT_MAX_VOTES);
}
export function timerSetupArguments({ minutes, votes, noTimeLimit, unlimitedVotes, hideResults, showNonVoters }) {
  return [noTimeLimit ? 0 : minutes, unlimitedVotes ? null : votes, hideResults, showNonVoters];
}
