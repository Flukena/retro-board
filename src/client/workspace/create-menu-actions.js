import { ROOM_KIND } from '../app/router.js';

/** The request each create-menu entry sends to `createBoard`. */
export function createMenuActions(createBoard) {
  return {
    blank: (name) => createBoard({ name }),
    template: (starter) => createBoard({ starter }),
    poker: () => createBoard({ kind: ROOM_KIND.POKER }),
    locked: ({ name, lock }) => createBoard({ name, lock }),
  };
}
