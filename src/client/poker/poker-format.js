// Display helpers shared by the poker components.
import { POKER_CARD_BREAK, POKER_CARD_UNKNOWN, cardInDeck } from '../../domain/poker-deck.js';
import { POKER_AVERAGE_DECIMALS } from '../../domain/poker-round.js';

const SPECIAL_CARD_LABEL_KEY = Object.freeze({
  [POKER_CARD_UNKNOWN]: 'poker.card.unknown',
  [POKER_CARD_BREAK]: 'poker.card.break',
});
const NO_VALUE = '–';

export const cardLabel = (deck, cardId) => cardInDeck(deck, cardId)?.label ?? NO_VALUE;

// Spoken name of a card: "Not sure" for "?", the label itself for numbers.
export const cardTitle = (card, translate) => (
  SPECIAL_CARD_LABEL_KEY[card.id] ? translate(SPECIAL_CARD_LABEL_KEY[card.id]) : card.label
);

export const formatStat = (value) => (value === null ? NO_VALUE : String(Number(value.toFixed(POKER_AVERAGE_DECIMALS))));

export const deckNameKey = (deckId) => `poker.deck.${deckId}`;
