import { BOARD_MODE } from './public-wall-contract.js';

export function boardEditingAllowed(mode, isPrivateAdmin, editingLocked) {
  return mode === BOARD_MODE.PUBLIC || isPrivateAdmin || !editingLocked;
}

export function boardManagementPermissions(mode, privateAdmin) {
  const isPrivateAdmin = mode !== BOARD_MODE.PUBLIC && Boolean(privateAdmin);
  return { canManage: mode === BOARD_MODE.PUBLIC || isPrivateAdmin, isPrivateAdmin };
}

export function runSharedBoardAction(mode, requirePrivateAdminPin, action) {
  return mode === BOARD_MODE.PUBLIC ? action() : requirePrivateAdminPin(action);
}
