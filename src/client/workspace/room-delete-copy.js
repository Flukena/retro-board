import { ROOM_KIND } from '../../domain/room-ownership.js';

// Delete copy names what is being deleted, from the card menu entry to the dialog: a board or a Planning Poker room.
export const DELETE_COPY_KEYS = Object.freeze({
  [ROOM_KIND.BOARD]: Object.freeze({
    menu: 'workspace.card.delete', title: 'myBoards.deleteTitle', body: 'myBoards.deleteBody', prompt: 'myBoards.deletePrompt',
  }),
  [ROOM_KIND.POKER]: Object.freeze({
    menu: 'workspace.card.deletePoker', title: 'myBoards.deleteTitlePoker', body: 'myBoards.deleteBodyPoker',
    prompt: 'myBoards.deletePromptPoker',
  }),
});
