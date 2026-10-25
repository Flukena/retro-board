// Closing first also covers denied authorization and synchronous cached PINs.
export function confirmThenPin(closeConfirm, requireAdminPin, action) {
  closeConfirm(false);
  return requireAdminPin(action);
}
