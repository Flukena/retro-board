import { MEDAL_COLORS } from './palette.js';

export const COMMENT_CAROUSEL_MS = 3600;
export const COMMENT_CAROUSEL_STYLE = `
  .rb-sticky__comment-slide {
    animation: rb-sticky__comment-slide ${COMMENT_CAROUSEL_MS}ms ease-in-out both;
  }
`;

// The header's negative side offsets align its row with the body's outer edges.
export const ZONE_BORDER_W_PX = 2;

export function stickyShadowClass({ remoteSelected, winner, dense }) {
  if (remoteSelected) return '';
  if (winner) return 'rb-sticky--shadow-winner';
  return dense ? 'rb-sticky--shadow-flat' : 'rb-sticky--shadow-default';
}

export function stickyClassName({ selected, remoteSelected, winner, dense }) {
  return [
    'rb-sticky',
    selected && 'rb-sticky--selected',
    remoteSelected && 'rb-remote-selected-card',
    stickyShadowClass({ remoteSelected, winner, dense }),
  ].filter(Boolean).join(' ');
}

export function stickyCardVars(paletteEntry) {
  return {
    '--rb-card-bg': paletteEntry.bg,
    '--rb-card-ink': paletteEntry.ink,
  };
}

export function zoneCardVars(paletteEntry) {
  return {
    '--rb-zone-bg': paletteEntry.bg,
    '--rb-zone-ink': paletteEntry.ink,
    '--rb-zone-rgb': paletteEntry.rgb,
    '--rb-zone-border-w': `${ZONE_BORDER_W_PX}px`,
  };
}

export function medalLook(rank) {
  if (!Number.isInteger(rank) || !Object.hasOwn(MEDAL_COLORS, rank)) return null;
  const { bg, fg } = MEDAL_COLORS[rank];
  return { '--rb-medal-bg': bg, '--rb-medal-fg': fg };
}

export function stickyVoteClassName(baseClass, voted, votingAllowedNow) {
  return [baseClass, voted && `${baseClass}--voted`,
    votingAllowedNow && !voted && 'rb-sticky-vote--open'].filter(Boolean).join(' ');
}
