// Round statistics for Planning Poker. Pure: callers pass the votes of one
// story as Map<userId, cardId> plus the room deck.
import { cardInDeck, rankedCards } from './poker-deck.js';

export const POKER_SPREAD = Object.freeze({ NONE: 'none', CLOSE: 'close', WIDE: 'wide' });
// Votes more than one ranked card apart need a discussion.
const CLOSE_SPREAD_MAX_STEPS = 1;
const MIN_VOTES_FOR_SPREAD = 2;
// Averages are shown and exported with one decimal place.
export const POKER_AVERAGE_DECIMALS = 1;

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : mean([sorted[middle - 1], sorted[middle]]);
}

function validVotes(votes, deckEntry) {
  const cards = [];
  for (const [userId, cardId] of votes) {
    const card = cardInDeck(deckEntry, cardId);
    if (card) cards.push({ userId, card });
  }
  return cards;
}

function distributionOf(cards, deckEntry) {
  const counts = new Map();
  for (const { card } of cards) counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
  return deckEntry.cards
    .filter((card) => counts.has(card.id))
    .map((card) => ({ cardId: card.id, label: card.label, count: counts.get(card.id) }));
}

const sortedIds = (entries) => entries.map(({ userId }) => userId).sort();

function spreadOf(rankedVotes) {
  if (rankedVotes.length < MIN_VOTES_FOR_SPREAD) return { spread: POKER_SPREAD.NONE, lowVoterIds: [], highVoterIds: [] };
  const ranks = rankedVotes.map(({ rank }) => rank);
  const low = Math.min(...ranks);
  const high = Math.max(...ranks);
  if (high - low <= CLOSE_SPREAD_MAX_STEPS) return { spread: POKER_SPREAD.CLOSE, lowVoterIds: [], highVoterIds: [] };
  return {
    spread: POKER_SPREAD.WIDE,
    lowVoterIds: sortedIds(rankedVotes.filter(({ rank }) => rank === low)),
    highVoterIds: sortedIds(rankedVotes.filter(({ rank }) => rank === high)),
  };
}

// The card most voters picked; on a tie the larger card wins because
// under-estimates hurt planning more than over-estimates. ? and coffee are not ranked.
function mostPickedCard(ranked, rankedVotes) {
  const counts = new Map();
  for (const { card } of rankedVotes) counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
  let best = null;
  for (const card of ranked) {
    const count = counts.get(card.id) ?? 0;
    if (count && (!best || count >= best.count)) best = { id: card.id, count };
  }
  return best?.id ?? null;
}

export function summarizeRound(votes, deckEntry) {
  const cards = validVotes(votes, deckEntry);
  const ranked = rankedCards(deckEntry);
  const rankedVotes = cards
    .filter(({ card }) => card.ranked)
    .map((vote) => ({ ...vote, rank: ranked.indexOf(vote.card) }));
  const numbers = cards.map(({ card }) => card.value).filter((value) => value !== null);
  const average = numbers.length ? mean(numbers) : null;
  const pickedIds = new Set(cards.map(({ card }) => card.id));
  return {
    voterCount: cards.length,
    numericCount: numbers.length,
    average,
    median: median(numbers),
    distribution: distributionOf(cards, deckEntry),
    consensus: pickedIds.size === 1 && rankedVotes.length === cards.length,
    ...spreadOf(rankedVotes),
    suggestedCardId: mostPickedCard(ranked, rankedVotes),
  };
}

// Seats at the table: everyone online plus anyone who voted and then left.
// `names` is Map<userId, name> of online participants.
export function pokerTableSeats(names, votes, { revealed, viewerId, fallbackName }) {
  const visible = visibleVotes(votes, { revealed, viewerId });
  const ids = new Set([...names.keys(), ...votes.keys()]);
  return [...ids]
    .map((userId) => ({
      userId,
      name: names.get(userId) ?? fallbackName,
      online: names.has(userId),
      voted: votes.has(userId),
      cardId: visible.get(userId) ?? null,
      isViewer: userId === viewerId,
    }))
    .sort((a, b) => Number(b.isViewer) - Number(a.isViewer) || a.name.localeCompare(b.name) || (a.userId < b.userId ? -1 : 1));
}

// What one participant may see on the table: before the reveal every other
// card is face down (null), even though the document holds the value.
export function visibleVotes(votes, { revealed, viewerId }) {
  const visible = new Map();
  for (const [userId, cardId] of votes) visible.set(userId, revealed || userId === viewerId ? cardId : null);
  return visible;
}
