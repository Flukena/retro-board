import { BOARD_TITLE_MAX_LENGTH } from './security-boundaries.js';

// A board title is stored in room meta as a trimmed, non-empty bounded string.
export const isBoardTitle = (value) => typeof value === 'string'
  && value.length > 0 && value.length <= BOARD_TITLE_MAX_LENGTH && value === value.trim();

export const normalizeBoardTitle = (raw) => {
  if (typeof raw !== 'string') return null;
  const title = raw.trim().slice(0, BOARD_TITLE_MAX_LENGTH).trim();
  return title || null;
};

// The creator's browser names the room once, only while the room has never had a title.
export const boardTitleToSeed = ({ storedTitle, pendingTitle }) => (
  storedTitle === undefined ? normalizeBoardTitle(pendingTitle) : null
);
