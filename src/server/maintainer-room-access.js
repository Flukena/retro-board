import { ROOM_HANDLE_RE } from './relay-config.js';
import { PUBLIC_PATH } from '../domain/public-wall-contract.js';

const PRIVATE_DOCUMENT_RE = /^yjs\/board-([A-Za-z0-9_-]{3,32}?)-([A-Za-z0-9_-]{8,64})$/;

export function createMaintainerRoomLinks({ registry, boardOrigin, publicWall = false } = {}) {
  return handle => {
    if (!registry || !boardOrigin || !ROOM_HANDLE_RE.test(handle)) return null;
    const docName = registry.registeredRoomsByHandle.get(handle);
    if (!docName) return null;
    if (publicWall) return new URL(PUBLIC_PATH, boardOrigin).href;
    const match = PRIVATE_DOCUMENT_RE.exec(docName);
    if (!match) return null;
    const [, code, token] = match;
    const url = new URL(`/b/${code}`, boardOrigin);
    url.hash = token;
    return url.href;
  };
}
