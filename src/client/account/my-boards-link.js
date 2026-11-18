import { isLandingPath } from '../app/router.js';
import { ACCOUNT_STATUS } from './account-api.js';

// My boards is the signed-in home page.
export const MY_BOARDS_PATH = '/';

/** The account menu's My boards link: home, unless the page already is My boards. Null leaves the item out. */
export function myBoardsHrefFor(status, pathname) {
  if (status !== ACCOUNT_STATUS.SIGNED_IN || isLandingPath(pathname)) return null;
  return MY_BOARDS_PATH;
}
