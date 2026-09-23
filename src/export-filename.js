const BOARD_PATH = /^\/b\/([A-Za-z0-9_-]{3,32})\/?$/;
const SAFE_BOARD_CODE = /^[A-Za-z0-9_-]{3,32}$/;

// Read the code at click time so an old React closure or restored browser tab
// can never label an export with a different room's code.
export const resolveExportBoardCode = (
  fallbackCode,
  pathname = typeof window !== 'undefined' ? window.location.pathname : '/',
) => {
  const routeCode = String(pathname || '').match(BOARD_PATH)?.[1];
  if (routeCode) return routeCode;
  return SAFE_BOARD_CODE.test(fallbackCode || '') ? fallbackCode : 'board';
};
