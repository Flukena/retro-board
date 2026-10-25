const FONT_WARMUP_SIZE_PX = 16;
const FONT_WARMUP_TEXT = 'Agกข0123456789';
const BOARD_FONT_TOKENS = [
  { family: '--font-ui', weight: 'normal' },
  { family: '--font-display', weightToken: '--sticky-vote-font-weight' },
];

export async function warmBoardFonts(document) {
  if (!document.fonts?.load || !document.defaultView?.getComputedStyle) return [];
  // A font query before the external stylesheet arrives resolves with no faces.
  if (document.readyState && document.readyState !== 'complete') {
    await new Promise(resolve => document.defaultView.addEventListener('load', resolve, { once: true }));
  }
  const style = document.defaultView.getComputedStyle(document.documentElement);
  const fonts = new Set();
  for (const token of BOARD_FONT_TOKENS) {
    const family = style.getPropertyValue(token.family).split(',')[0].trim();
    const weight = token.weight || style.getPropertyValue(token.weightToken).trim();
    if (family && weight) fonts.add(`${weight} ${FONT_WARMUP_SIZE_PX}px ${family}`);
  }
  return Promise.allSettled([...fonts].map(font => document.fonts.load(font, FONT_WARMUP_TEXT)));
}
