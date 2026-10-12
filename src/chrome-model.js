import { DEFAULT_PLAYER_NAME } from './player-cursors.js';

export function templateRows(builtins, customTemplates) {
  return {
    builtin: Object.entries(builtins).map(([id, template]) => ({ id, name: template.name })),
    custom: customTemplates.map(({ id, name, zones }) => ({ id, name, zoneCount: zones.length })),
  };
}

export function followBannerModel(hue, player, cachedPresence, waiting) {
  return {
    name: player?.name || cachedPresence?.name || DEFAULT_PLAYER_NAME,
    hue,
    waiting,
  };
}
