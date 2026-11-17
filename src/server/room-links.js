import { roomPath } from '../domain/room-ownership.js';

// The canonical docName of a tokenized room: yjs/board-<code>-<token>. Generated codes never contain '-'.
const ROOM_DOCUMENT_RE = /^yjs\/board-([A-Za-z0-9_-]{3,32}?)-([A-Za-z0-9_-]{8,64})$/;

const capabilityOf = (docName) => {
  const match = ROOM_DOCUMENT_RE.exec(docName);
  return match ? { code: match[1], token: match[2] } : null;
};

/** The room code of a tokenized docName, or null. */
export const roomCodeOf = (docName) => capabilityOf(docName)?.code ?? null;

/** Site-relative link that opens the room in the app of its kind (/b/ board, /p/ Poker), or null. */
export function roomLink(docName, kind) {
  const capability = capabilityOf(docName);
  return capability && roomPath(capability.code, capability.token, kind);
}
