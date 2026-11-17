import { renameTitleFrom } from '../../domain/board-title.js';

/**
 * Requests to the open board about its title, for dialogs mounted outside it (the locked-room owner menu).
 * Each request is a synchronous event; the board answers it on the event, so nothing stores the board's callbacks.
 */
const REQUEST = Object.freeze({ READ: 'retroroom:board-title-read', RENAME: 'retroroom:board-title-rename' });

class BoardTitleRequest extends Event {
  answer = null;

  constructor(type, title = null) {
    super(type);
    this.title = title;
  }
}

/** The channel the page's one open board listens on. */
export const boardTitleEvents = new EventTarget();

const ask = (events, request) => {
  events.dispatchEvent(request);
  return request.answer;
};

/** The open board's title, or null when no board answers or it has none. */
export const readBoardTitle = (events = boardTitleEvents) => ask(events, new BoardTitleRequest(REQUEST.READ));

/** Asks the open board to rename itself; true only when the title was within bounds and the board wrote it. */
export function requestBoardRename(raw, events = boardTitleEvents) {
  const title = renameTitleFrom(raw);
  return title !== null && ask(events, new BoardTitleRequest(REQUEST.RENAME, title)) === true;
}

/**
 * Answers title requests for the open board until the returned stop is called. A rename is an ordinary
 * (not silent) meta patch, so it is a local edit that undo and redo cover.
 */
export function serveBoardTitle(events, { title, patchMeta }) {
  const onRead = (request) => { request.answer = title; };
  const onRename = (request) => { request.answer = patchMeta({ title: request.title }) !== false; };
  events.addEventListener(REQUEST.READ, onRead);
  events.addEventListener(REQUEST.RENAME, onRename);
  return () => {
    events.removeEventListener(REQUEST.READ, onRead);
    events.removeEventListener(REQUEST.RENAME, onRename);
  };
}
