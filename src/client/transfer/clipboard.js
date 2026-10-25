export const copyTextToClipboard = async (clipboard, value) => {
  if (!clipboard || typeof clipboard.writeText !== 'function') return false;
  try {
    await clipboard.writeText(String(value ?? ''));
    return true;
  } catch {
    return false;
  }
};
