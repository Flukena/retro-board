// CSV of a poker room's stories for Jira/Sheets. Votes of unrevealed rounds
// are never exported: only the count of revealed votes and their average.
import { csvDocument, csvRow } from './csv-writer.js';
import { cardInDeck } from './poker-deck.js';
import { POKER_AVERAGE_DECIMALS, summarizeRound } from './poker-round.js';

const EMPTY_VOTES = new Map();

export function pokerCsv(room, labels) {
  const rows = [csvRow([labels.story, labels.estimate, labels.votes, labels.average])];
  for (const story of room.stories) {
    const revealed = story.revealedAt !== null;
    const summary = summarizeRound(revealed ? room.votesByStory.get(story.id) ?? EMPTY_VOTES : EMPTY_VOTES, room.deck);
    rows.push(csvRow([
      story.title,
      story.finalEstimate === null ? '' : cardInDeck(room.deck, story.finalEstimate).label,
      revealed ? summary.voterCount : '',
      summary.average === null ? '' : summary.average.toFixed(POKER_AVERAGE_DECIMALS),
    ]));
  }
  return csvDocument(rows);
}
