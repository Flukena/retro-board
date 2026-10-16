import { RESULT_TOP_SIZE, compareStableText, compareVoteRank } from './vote-ranking.js';
import { isSafeId } from './comment-schema.js';
import { DISPLAY_NAME_MAX_LENGTH } from './security-boundaries.js';

export const VOTE_RESULTS_VERSION = 1;
// Production room connection cap (DEPLOYMENT.md capacity profile).
export const MAX_RESULT_PARTICIPANTS = 32;
export { RESULT_TOP_SIZE } from './vote-ranking.js';
export const RESULT_GUEST_NAME = 'Guest';
// ECMAScript Date range, so valid remote timestamps are always renderable.
const MAX_RESULT_TIMESTAMP_MS = 8_640_000_000_000_000;
const nonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const resultTimestamp = (value) => nonnegativeInteger(value) && value <= MAX_RESULT_TIMESTAMP_MS;
const positiveInteger = (value) => nonnegativeInteger(value) && value > 0;
const participantName = (value) => (
  typeof value === 'string' && value.trim()
    ? value.trim().slice(0, DISPLAY_NAME_MAX_LENGTH) : RESULT_GUEST_NAME
);

export function normalizeResultParticipants(participants) {
  const names = new Map();
  for (const participant of participants) {
    if (!isSafeId(participant?.userId)) continue;
    const name = participantName(participant.name);
    const previous = names.get(participant.userId);
    if (previous === undefined || compareStableText(name, previous) < 0) names.set(participant.userId, name);
  }
  return names;
}

function countResultVotes(items, votesByItem) {
  const counts = new Map();
  const top = [];
  let totalVotes = 0;
  for (const item of items) {
    const voters = [...(votesByItem.get(item.id) || [])];
    totalVotes += voters.length;
    for (const userId of voters) counts.set(userId, (counts.get(userId) || 0) + 1);
    if (voters.length) top.push({ itemId: item.id, votes: voters.length });
  }
  top.sort((a, b) => compareVoteRank(a.votes, b.votes, a.itemId, b.itemId));
  return { counts, top: top.slice(0, RESULT_TOP_SIZE), totalVotes };
}

function resultRoster(names, counts) {
  const ids = new Set([...names.keys(), ...counts.keys()]);
  const roster = [...ids].filter(isSafeId).map((userId) => ({
    userId, name: names.get(userId) || RESULT_GUEST_NAME, votes: counts.get(userId) || 0,
  }));
  roster.sort((a, b) => a.votes - b.votes || compareStableText(a.name, b.name) || compareStableText(a.userId, b.userId));
  return { participants: roster.slice(0, MAX_RESULT_PARTICIPANTS), omittedCount: Math.max(0, roster.length - MAX_RESULT_PARTICIPANTS) };
}

export function buildVoteResults(root, items, votesByItem, participants, finalizedAt) {
  const timer = root.voteTimer;
  const names = normalizeResultParticipants(participants);
  const { counts, top, totalVotes } = countResultVotes(items, votesByItem);
  const showNonVoters = !!timer.showNonVoters;
  return {
    v: VOTE_RESULTS_VERSION, resultId: `${root.id}:${timer.startedAt ?? 0}`,
    finalizedAt, scheduledEndsAt: timer.endsAt ?? null,
    totalVotes, voterCount: counts.size, presentCount: names.size,
    voteLimit: timer.voteLimit ?? null, top, showNonVoters,
    ...(showNonVoters ? resultRoster(names, counts) : { omittedCount: 0 }),
  };
}

const validTop = (top) => Array.isArray(top) && top.length <= RESULT_TOP_SIZE
  && top.every((row) => isSafeId(row?.itemId) && positiveInteger(row.votes))
  && new Set(top.map((row) => row.itemId)).size === top.length;
const validParticipant = (row) => isSafeId(row?.userId) && typeof row.name === 'string'
  && row.name.length > 0 && row.name.length <= DISPLAY_NAME_MAX_LENGTH && nonnegativeInteger(row.votes);
function validRoster(result) {
  if (!result.showNonVoters) return !Object.hasOwn(result, 'participants') && result.omittedCount === 0;
  return Array.isArray(result.participants) && result.participants.length <= MAX_RESULT_PARTICIPANTS
    && result.participants.every(validParticipant)
    && new Set(result.participants.map((row) => row.userId)).size === result.participants.length;
}
function validResultId(resultId, zoneId) {
  if (typeof resultId !== 'string') return false;
  const [id, startedAt, extra] = resultId.split(':');
  return id === zoneId && isSafeId(id) && extra === undefined
    && /^\d+$/.test(startedAt) && nonnegativeInteger(Number(startedAt));
}
export function isVoteResults(result, zoneId) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const counts = ['totalVotes', 'voterCount', 'presentCount', 'omittedCount'];
  return result.v === VOTE_RESULTS_VERSION && validResultId(result.resultId, zoneId)
    && resultTimestamp(result.finalizedAt)
    && counts.every((key) => nonnegativeInteger(result[key]))
    && (result.scheduledEndsAt === null || resultTimestamp(result.scheduledEndsAt))
    && (result.voteLimit === null || positiveInteger(result.voteLimit))
    && typeof result.showNonVoters === 'boolean' && validTop(result.top) && validRoster(result) && consistentResultCounts(result);
}

function consistentResultCounts(result) {
  if (result.voterCount > result.totalVotes) return false;
  if (result.top.reduce((sum, row) => sum + row.votes, 0) > result.totalVotes) return false;
  if (!result.showNonVoters) return true;
  const rosterCount = result.participants.length + result.omittedCount;
  return rosterCount <= result.presentCount + result.voterCount
    && result.participants.every((row) => row.votes <= result.totalVotes);
}
