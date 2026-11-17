import { ROOM_HANDLE_RE } from './relay-config.js';
import { PUBLIC_PATH } from '../domain/public-wall-contract.js';
import { ROOM_KIND } from '../domain/room-ownership.js';
import { roomLink } from './room-links.js';

export function createMaintainerRoomLinks({ registry, boardOrigin, publicWall = false } = {}) {
  return handle => {
    if (!registry || !boardOrigin || !ROOM_HANDLE_RE.test(handle)) return null;
    const docName = registry.registeredRoomsByHandle.get(handle);
    if (!docName || registry.isLocked(docName)) return null;
    if (publicWall) return new URL(PUBLIC_PATH, boardOrigin).href;
    const link = roomLink(docName, registry.ownershipOf(docName)?.kind ?? ROOM_KIND.BOARD);
    return link && new URL(link, boardOrigin).href;
  };
}
