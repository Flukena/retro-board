import { MY_BOARDS_ERROR } from '../account/my-boards-controller.js';

// What a refused room list, rename or delete tells the person.
export const ROOM_ERROR_KEYS = Object.freeze({
  [MY_BOARDS_ERROR.SIGN_IN]: 'myBoards.error.signIn',
  [MY_BOARDS_ERROR.GONE]: 'myBoards.error.gone',
  [MY_BOARDS_ERROR.LOCKED]: 'myBoards.error.locked',
  [MY_BOARDS_ERROR.RATE_LIMITED]: 'myBoards.error.rateLimited',
  [MY_BOARDS_ERROR.UNAVAILABLE]: 'account.failed',
});
