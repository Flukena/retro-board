// Estimation decks for Planning Poker rooms.
// A card id is what the room document stores; `value` is null for cards that
// are not numbers (T-shirt sizes, "?" and the break card) and `ranked` cards
// have an order that spread calculations can compare.

export const POKER_CARD_UNKNOWN = '?';
export const POKER_CARD_BREAK = 'coffee';

export const POKER_DECK_ID = Object.freeze({
  FIBONACCI: 'fibonacci',
  MODIFIED_FIBONACCI: 'modified-fibonacci',
  TSHIRT: 'tshirt',
  POWERS_OF_TWO: 'powers-of-two',
});

export const DEFAULT_POKER_DECK_ID = POKER_DECK_ID.FIBONACCI;

const numberCard = (value, label = String(value)) => ({ id: label, label, value, ranked: true });
const sizeCard = (label) => ({ id: label, label, value: null, ranked: true });
const SPECIAL_CARDS = [
  { id: POKER_CARD_UNKNOWN, label: POKER_CARD_UNKNOWN, value: null, ranked: false },
  { id: POKER_CARD_BREAK, label: '☕', value: null, ranked: false },
];
const HALF_POINT = 0.5;

const deck = (id, cards) => Object.freeze({
  id,
  cards: Object.freeze([...cards, ...SPECIAL_CARDS].map((card) => Object.freeze(card))),
});

const DECKS = [
  deck(POKER_DECK_ID.FIBONACCI, [0, 1, 2, 3, 5, 8, 13, 21].map((value) => numberCard(value))),
  deck(POKER_DECK_ID.MODIFIED_FIBONACCI, [
    numberCard(0), numberCard(HALF_POINT, '½'),
    ...[1, 2, 3, 5, 8, 13, 20, 40, 100].map((value) => numberCard(value)),
  ]),
  deck(POKER_DECK_ID.TSHIRT, ['XS', 'S', 'M', 'L', 'XL', 'XXL'].map(sizeCard)),
  deck(POKER_DECK_ID.POWERS_OF_TWO, [0, 1, 2, 4, 8, 16, 32, 64].map((value) => numberCard(value))),
];
const DECKS_BY_ID = new Map(DECKS.map((entry) => [entry.id, entry]));

export const POKER_DECKS = Object.freeze(DECKS);

export const isPokerDeckId = (value) => DECKS_BY_ID.has(value);

export const deckById = (deckId) => DECKS_BY_ID.get(deckId) ?? DECKS_BY_ID.get(DEFAULT_POKER_DECK_ID);

export const cardInDeck = (deckEntry, cardId) => deckEntry.cards.find((card) => card.id === cardId) ?? null;

export const isCardInDeck = (deckEntry, cardId) => cardInDeck(deckEntry, cardId) !== null;

export const rankedCards = (deckEntry) => deckEntry.cards.filter((card) => card.ranked);
