export const DEFAULT_BOARD = {
  items: [],
  adminUserId: null,
  editingLocked: false,
  // In-session pause for voting. Voting requires an active timer session AND
  // votingLocked === false. Default unlocked so starting a timer enables voting
  // right away; an admin can flip this to pause voting mid-session.
  votingLocked: false,
  allRevealed: false,
  // timer: { startedAt, endsAt: number|null, voteLimit: number|null, hideResults: boolean }
  // - endsAt=null   → no time limit, admin must stop manually
  // - voteLimit=null → unlimited votes per user
  timer: null,
  lastResultsAt: null,
  // Room name chosen at creation; null when the room was never named.
  title: null,
  // SHA-256(boardCode + ':' + pin) — required before destructive admin
  // actions (Clear / Reset votes / Transfer admin). null until the first
  // admin sets one; if still null, the actions just prompt the admin to set
  // a PIN inline rather than blocking access.
  adminPinHash: null,
  // Viewer everyone follows while presenting; a live-session value that import resets.
  presenterUserId: null,
  // Current meeting phase { id, startedAt } (retro-phase.js); also reset by import.
  phase: null,
  // Mood check round { id, startedAt, open } (mood-check.js); kept in backups, closed on import.
  moodCheck: null,
};
