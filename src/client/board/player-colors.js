export const PLAYER_ACCENT_SATURATION_PERCENT = 72;
export const PLAYER_ACCENT_LIGHTNESS_PERCENT = 46;

const PLAYER_HUE_HASH_MULTIPLIER = 31;
const HUE_CIRCLE_DEGREES = 360;
const UNKNOWN_INITIAL = '?';

export function hueFromId(id) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * PLAYER_HUE_HASH_MULTIPLIER + id.charCodeAt(index)) >>> 0;
  }
  return hash % HUE_CIRCLE_DEGREES;
}

export function avatarInitial(name) {
  return (name || UNKNOWN_INITIAL).trim().charAt(0).toUpperCase() || UNKNOWN_INITIAL;
}

export function playerAccentColor(hue, alpha) {
  const channels = `${hue} ${PLAYER_ACCENT_SATURATION_PERCENT}% ${PLAYER_ACCENT_LIGHTNESS_PERCENT}%`;
  return `hsl(${channels}${alpha == null ? '' : ` / ${alpha}`})`;
}
