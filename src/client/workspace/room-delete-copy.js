import { ROOM_KIND } from '../../domain/room-ownership.js';

// Delete copy names what is being deleted: a board or a Planning Poker room.
export const DELETE_COPY_KEYS = Object.freeze({
  [ROOM_KIND.BOARD]: Object.freeze({ title: 'myBoards.deleteTitle', body: 'myBoards.deleteBody', prompt: 'myBoards.deletePrompt' }),
  [ROOM_KIND.POKER]: Object.freeze({ title: 'myBoards.deleteTitlePoker', body: 'myBoards.deleteBodyPoker', prompt: 'myBoards.deletePromptPoker' }),
});
