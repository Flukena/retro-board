import { isEncryptedRoom } from '../room-provider.js';
import { attachE2ERoom } from '../e2e-room.js';
import { getRoomKey } from '../../room-lock/lock-session.js';
import { repairOldEpochImages } from '../../room-lock/e2e-image-repair.js';
import { createDrawingPreviews } from '../drawing-previews.js';
import { createReactionChannel } from '../../reactions/reaction-channel.js';
import { createWritingTimerStore } from '../../writing-timer/writing-timer-store.js';

export function attachRoomEncryption({ provider, ydoc, roomKey, roomHandle, undoManager, images }) {
  if (provider && isEncryptedRoom(roomKey, roomHandle)) {
    const e2eRoom = attachE2ERoom({
      provider, ydoc, eventTarget: window, getRoomKey, clearUndo: () => undoManager?.clear(),
      repairImages: () => repairOldEpochImages({ storage: images }),
    });
    return { rotationSource: e2eRoom.rotationSource };
  }
  return {};
}

export function attachRoomCollaboration({ provider, ydoc, routeKind }) {
  const services = {};
  if (provider) {
    const previews = createDrawingPreviews(ydoc, provider.awareness);
    services.drawingPreviews = previews;
    ydoc.on('destroy', () => previews.destroy());
  }

  // Emoji reactions and the card-writing timer are for retro boards only: the Public Wall gets neither.
  if (provider && routeKind === 'board') {
    const reactions = createReactionChannel(provider.awareness);
    services.boardReactions = reactions;
    ydoc.on('destroy', () => reactions.destroy());
    const writingTimer = createWritingTimerStore({ doc: ydoc, isLive: () => provider.synced });
    services.writingTimer = writingTimer;
    ydoc.on('destroy', () => writingTimer.destroy());
  }
  return services;
}
