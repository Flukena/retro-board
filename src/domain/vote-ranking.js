export const RESULT_TOP_SIZE = 3;
export const compareStableText = (a, b) => (a < b ? -1 : Number(a > b));
export const compareVoteRank = (aVotes, bVotes, aId, bId) => (
  bVotes - aVotes || compareStableText(aId, bId)
);
