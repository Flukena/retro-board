import { RESULT_TOP_SIZE, compareVoteRank } from './vote-ranking.js';

// Derive the medal ranks displayed after a vote session finishes. Callers
// provide the board's ownership helpers so this stays deterministic and easy
// to exercise without mounting the collaborative React component.
export const buildTopVotedRanks = ({
  items,
  voteCountOf,
  groupIdsForZone,
  ownerZoneForItem,
  zoneHasActiveGovernor,
}) => {
  const finishedRoots = items.filter((item) => (
    item.type === 'zone' && item.lastResultsAt && !item.voteTimer
  ));
  const stickies = items.filter((item) => item.type === 'sticky');
  const result = new Map();

  finishedRoots.forEach((root) => {
    const groupZoneIds = new Set([...groupIdsForZone(root, items)]
      .filter((id) => {
        const zone = items.find((item) => item.id === id);
        return zone?.type === 'zone' && !zoneHasActiveGovernor(zone, items);
      }));

    // The zone that owns the finished session is the scoring boundary. Pool
    // every directly/nested-owned sticky, then award exactly one #1/#2/#3
    // across that largest group instead of restarting ranks in each child.
    const ranked = stickies
      .filter((sticky) => groupZoneIds.has(ownerZoneForItem(sticky, items)?.id))
      .filter((sticky) => voteCountOf(sticky.id) > 0)
      .sort((a, b) => compareVoteRank(voteCountOf(a.id), voteCountOf(b.id), a.id, b.id))
      .slice(0, RESULT_TOP_SIZE);
    ranked.forEach((sticky, index) => result.set(sticky.id, index + 1));
  });

  return result;
};
