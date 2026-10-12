import { parseColor } from './color-contrast.js';

const HEX_COLOR = /^#[\da-f]{6}$/i;

export function paletteColor({ name, bg, border, zoneBg }) {
  if (typeof name !== 'string' || !/^[a-z]+$/.test(name)) {
    throw new Error('Palette name must be non-empty lowercase letters');
  }
  if (typeof bg !== 'string' || typeof border !== 'string'
    || !HEX_COLOR.test(bg) || !HEX_COLOR.test(border)) {
    throw new Error('Palette bg and border must be #rrggbb');
  }
  if (typeof zoneBg !== 'string' || !zoneBg.trim().startsWith('rgba(')) {
    throw new Error('Palette zoneBg must be rgba(r,g,b,a)');
  }
  parseColor(bg);
  parseColor(border);
  parseColor(zoneBg);
  return Object.freeze({ name, bg, border, zoneBg });
}

export const PALETTE = Object.freeze([
  paletteColor({ name: 'yellow', bg: '#fef3c7', border: '#f59e0b', zoneBg: 'rgba(251,191,36,0.12)' }),
  paletteColor({ name: 'red', bg: '#fecaca', border: '#ef4444', zoneBg: 'rgba(239,68,68,0.10)'  }),
  paletteColor({ name: 'green', bg: '#bbf7d0', border: '#22c55e', zoneBg: 'rgba(34,197,94,0.10)'  }),
  paletteColor({ name: 'blue', bg: '#bae6fd', border: '#0ea5e9', zoneBg: 'rgba(14,165,233,0.10)' }),
  paletteColor({ name: 'purple', bg: '#e9d5ff', border: '#a855f7', zoneBg: 'rgba(168,85,247,0.10)' }),
  paletteColor({ name: 'orange', bg: '#fed7aa', border: '#f97316', zoneBg: 'rgba(249,115,22,0.10)' }),
]);

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
export const STICKY_AUTO_TEXT_FAINT = '#9ca3af';

