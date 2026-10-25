import { parseColor } from './color-contrast.js';

const HEX_COLOR = /^#[\da-f]{6}$/i;

function validateHexColor(color, label) {
  if (typeof color !== 'string' || !HEX_COLOR.test(color)) {
    throw new Error(`Palette ${label} must be #rrggbb`);
  }
}

export function paletteColor({ name, bg, border, zoneBg, ink }) {
  if (typeof name !== 'string' || !/^[a-z]+$/.test(name)) {
    throw new Error('Palette name must be non-empty lowercase letters');
  }
  validateHexColor(bg, 'bg');
  validateHexColor(border, 'border');
  validateHexColor(ink, 'ink');
  if (typeof zoneBg !== 'string' || !zoneBg.trim().startsWith('rgba(')) {
    throw new Error('Palette zoneBg must be rgba(r,g,b,a)');
  }
  parseColor(bg);
  const { r, g, b } = parseColor(border);
  parseColor(zoneBg);
  return Object.freeze({ name, bg, border, zoneBg, rgb: `${r},${g},${b}`, ink });
}

export const PALETTE = Object.freeze([
  paletteColor({
    name: 'yellow', bg: '#fef3c7', border: '#f59e0b', ink: '#92400e', zoneBg: 'rgba(251,191,36,0.12)',
  }),
  paletteColor({
    name: 'red', bg: '#fecaca', border: '#ef4444', ink: '#991b1b', zoneBg: 'rgba(239,68,68,0.10)',
  }),
  paletteColor({
    name: 'green', bg: '#bbf7d0', border: '#22c55e', ink: '#166534', zoneBg: 'rgba(34,197,94,0.10)',
  }),
  paletteColor({
    name: 'blue', bg: '#bae6fd', border: '#0ea5e9', ink: '#075985', zoneBg: 'rgba(14,165,233,0.10)',
  }),
  paletteColor({
    name: 'purple', bg: '#e9d5ff', border: '#a855f7', ink: '#6b21a8', zoneBg: 'rgba(168,85,247,0.10)',
  }),
  paletteColor({
    name: 'orange', bg: '#fed7aa', border: '#f97316', ink: '#9a3412', zoneBg: 'rgba(249,115,22,0.10)',
  }),
]);

export function paletteIndexByName(name) {
  const index = PALETTE.findIndex((entry) => entry.name === name);
  if (index < 0) throw new Error(`Unknown palette name: ${String(name)}`);
  return index;
}

export const DOCK_TILE_NAME = Object.freeze({
  templates: 'purple', select: 'orange', text: 'yellow', zone: 'green', image: 'blue', draw: 'purple',
});
export const DOCK_TILE_INDEX = Object.freeze(Object.fromEntries(
  Object.entries(DOCK_TILE_NAME).map(([tool, name]) => [tool, paletteIndexByName(name)]),
));

// Font-color presets shown in the toolbar swatch popover. `null` = auto/default.
export const FONT_COLORS = Object.freeze([
  { value: null,      label: 'auto',  swatch: 'linear-gradient(135deg,#111 50%,#fff 50%)' },
  { value: '#111827', label: 'black', swatch: '#111827' },
  { value: '#6b7280', label: 'gray',  swatch: '#6b7280' },
  { value: '#ffffff', label: 'white', swatch: '#ffffff' },
  { value: '#dc2626', label: 'red',   swatch: '#dc2626' },
  { value: '#f97316', label: 'orange',swatch: '#f97316' },
  { value: '#16a34a', label: 'green', swatch: '#16a34a' },
  { value: '#2563eb', label: 'blue',  swatch: '#2563eb' },
  { value: '#9333ea', label: 'purple',swatch: '#9333ea' },
].map(Object.freeze));

// Sticky note backgrounds (PALETTE above) are fixed pastels that never follow
// the app theme, unlike var(--text) — pin "auto" sticky text to the
// light-theme text colors instead, since the card's own background is
// always light regardless of dark mode.
export const STICKY_AUTO_TEXT = '#111827';

export const MEDAL_COLORS = Object.freeze({
  1: Object.freeze({ bg: '#f5b301', fg: '#3d2a00' }),
  2: Object.freeze({ bg: '#d4dae2', fg: '#1f2937' }),
  3: Object.freeze({ bg: '#e0965c', fg: '#3b1d06' }),
});
