// Theme: applies CSS variables on <html data-theme="…"> so any inline style
// can reference `var(--bg)` etc. Tri-state preference: 'light' | 'dark' | 'auto'.
// 'auto' follows prefers-color-scheme and updates live.

import { useEffect, useState } from 'react';
import { GRID_PITCH_PX, MINIMAP_GRID_PITCH_PX, Z } from './chrome-layout.js';
import {
  ZONE_TITLE_DEFAULT_FONT_PX, ZONE_COUNT_FONT_PX, ZONE_TITLE_LINE_HEIGHT_RATIO, ZONE_CHIP_PADDING_VERTICAL_PX,
  ZONE_CHIP_PADDING_HORIZONTAL_PX, ZONE_HEADER_INSET_PX, ZONE_HEADER_Z_INDEX,
} from './zone-title.js';

const STORAGE_KEY = 'rb_theme';

function tokenKeys(mode, label) {
  if (mode === null || typeof mode !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(mode))) {
    throw new Error(`${label} tokens must be a plain object`);
  }
  const keys = Reflect.ownKeys(mode);
  if (keys.some((key) => typeof key !== 'string' || !key.startsWith('--'))) {
    throw new Error(`${label} token keys must start with --`);
  }
  return keys;
}

export function defineTokens(light, dark) {
  const lightKeys = tokenKeys(light, 'Light');
  const darkKeys = tokenKeys(dark, 'Dark');
  const missing = lightKeys.filter((key) => !darkKeys.includes(key));
  const extra = darkKeys.filter((key) => !lightKeys.includes(key));
  if (missing.length || extra.length) {
    throw new Error(`Dark tokens missing keys: ${missing.join(', ')}; extra keys: ${extra.join(', ')}`);
  }
  return Object.freeze({ light: Object.freeze({ ...light }), dark: Object.freeze({ ...dark }) });
}

const MODE_INDEPENDENT_TOKENS = Object.freeze({
  '--minimap-grid-pitch': `${MINIMAP_GRID_PITCH_PX}px`,
  '--radius-dock-tile': '14px',
  '--dock-label-gap': '4px',
  '--radius-minimap-viewport': '4px',
  '--grid-pitch': `${GRID_PITCH_PX}px`,
  '--landing-corner-layer': String(Z.TOPBAR),
  '--landing-page-padding': '95px 16px 56px',
  '--landing-max-width': '580px',
  '--landing-gap': '16px',
  '--landing-hero-gap': '14px',
  '--landing-hero-margin': '0 0 8px',
  '--landing-logo-size': '52px',
  '--landing-title-font-size': '34px',
  '--landing-title-font-weight': '500',
  '--landing-title-line-height': '1.2',
  '--landing-subtitle-margin': '2px 0 0',
  '--landing-body-font-size': '13px',
  '--landing-card-padding': '20px',
  '--landing-line-width': '1.5px',
  '--landing-heading-font-size': '15px',
  '--landing-heading-font-weight': '700',
  '--landing-heading-margin': '0 0 14px',
  '--landing-create-heading-margin': '0 0 4px',
  '--landing-description-margin': '0 0 14px',
  '--landing-form-gap': '8px',
  '--landing-input-basis': '240px',
  '--landing-control-height': '42px',
  '--landing-input-padding': '0 12px',
  '--landing-control-font-size': '14px',
  '--landing-action-padding': '0 18px',
  '--landing-error-margin': '10px 0 0',
  '--landing-recents-padding': '16px 20px 8px',
  '--landing-recents-heading-margin': '0 0 6px',
  '--landing-recent-gap': '12px',
  '--landing-recent-padding': '10px 0',
  '--landing-recent-detail-gap': '2px',
  '--landing-recent-font-weight': '600',
  '--landing-small-font-size': '12px',
  '--landing-remove-size': '32px',
  '--landing-footer-margin': '4px 0 0',
  '--landing-footer-line-height': '1.6',
  '--landing-hover-transition': 'background 0.1s',
  '--sticky-ink': '#2b2118',
  '--sticky-vote-idle-bg': 'rgba(43,33,24,0.08)',
  '--sticky-vote-idle-text': '#374151',
  '--sticky-placeholder': '#9ca3af',
  '--zone-border-alpha': '0.5',
  '--selection': '#2563eb',
  '--radius-sticky': '3px',
  '--sticky-padding': '14px',
  '--sticky-line-height': '1.5',
  '--sticky-chip-height': '22px',
  '--comment-chip-padding': '0 7px',
  '--comment-chip-font-size': '11px',
  '--comment-chip-font-weight': '600',
  '--comment-chip-text': '#374151',
  '--comment-count-text': '#ffffff',
  '--sticky-vote-min-width': '32px',
  '--sticky-vote-padding': '0 9px',
  '--sticky-vote-gap': '4px',
  '--sticky-vote-font-size': '12px',
  '--sticky-vote-font-weight': '700',
  '--sticky-vote-icon-size': '12px',
  '--sticky-vote-open-ring': '0 0 0 1.5px var(--accent)',
  '--sticky-medal-size': '28px',
  '--sticky-medal-offset': '-13px',
  '--sticky-medal-font-size': '13px',
  '--sticky-medal-font-weight': '700',
  '--sticky-hidden-icon-size': '18px',
  '--sticky-hidden-title-size': '13px',
  '--sticky-hidden-title-weight': '600',
  '--sticky-hidden-author-size': '11px',
  '--sticky-hidden-author-weight': '500',
  '--sticky-hidden-text': '#4b5563',
  '--sticky-author-font-size': '11px',
  '--radius-zone': '24px',
  '--zone-header-inset': `${ZONE_HEADER_INSET_PX}px`,
  '--z-zone-header': String(ZONE_HEADER_Z_INDEX),
  '--zone-icon-button-size': '26px',
  '--zone-icon-size': '14px',
  '--zone-icon-gap': '2px',
  '--zone-tool-disabled-opacity': '0.4',
  '--zone-strip-swatch-size': '18px',
  '--radius-zone-icon': '10px',
  '--zone-icon-hover-bg': 'color-mix(in srgb, var(--text-muted) 12%, transparent)',
  '--zone-chip-padding': `${ZONE_CHIP_PADDING_VERTICAL_PX}px ${ZONE_CHIP_PADDING_HORIZONTAL_PX}px`,
  '--radius-zone-chip': '12px',
  '--zone-title-font-size': `${ZONE_TITLE_DEFAULT_FONT_PX}px`,
  '--zone-title-font-weight': '500',
  '--zone-title-line-height': String(ZONE_TITLE_LINE_HEIGHT_RATIO),
  '--zone-count-font-size': `${ZONE_COUNT_FONT_PX}px`,
  '--zone-chip-gap': '8px',
  '--zone-chip-min-width': '80px',
  '--zone-lock-size': '0.8125em',
  '--zone-title-shadow': '0 2px 0 rgba(0,0,0,0.08)',
  '--shadow-winner': '0 0 0 3px #fbbf24, 0 16px 22px -12px rgba(194,120,3,0.65)',
  '--shadow-winner-peak': '0 0 0 3px #fbbf24, 0 16px 22px -12px rgba(194,120,3,0.9)',
  '--shadow-medal': '0 0 0 2px #fffcf6, 0 4px 10px rgba(0,0,0,0.18)',
  '--comment-chip-bg': 'rgba(255,255,255,0.65)',
  '--comment-chip-shadow': '0 2px 6px rgba(0,0,0,0.08)',
  '--hidden-sticky-bg': 'rgba(255,255,255,0.35)',
  '--vote-float-shadow': '0 1px 2px rgba(0,0,0,0.2)',
  '--radius-xl': '22px',
  '--radius-icon-tile': '9px',
  '--radius-banner': '18px',
  '--tile-ink': '#2b2118',
  '--radius-bar': '20px',
  '--radius-lg': '16px',
  '--radius-tile': '11px',
  '--radius-round': '50%',
  '--radius-pill': '999px',
  '--brand-tile-bg': '#fed7aa',
  '--brand-tile-fg': '#7c2d12',
  '--avatar-fg': '#fff',
  '--avatar-crown-bg': '#facc15',
  '--avatar-ring-shadow': '0 0 0 2px var(--bg-panel), 0 0 0 3px var(--border-soft)',
  '--avatar-saturation': '65%',
  '--avatar-lightness': '55%',
  '--minimap-viewport-bg': 'rgba(14,165,233,0.13)',
  '--zone-preview-bg': 'rgba(14,165,233,0.10)',
  '--shadow-toast': '0 8px 24px rgba(0,0,0,0.25)',
  '--radius-sm': '10px',
  '--radius-md': '12px',
  '--font-ui': '"Sarabun", system-ui, -apple-system, "Segoe UI", sans-serif',
  '--font-display': '"Mitr", "Sarabun", sans-serif',
  '--font-mono': '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
});
const LIGHT_RAISED_SHADOW = '0 2px 0 #e2d5bf, 0 12px 24px -14px rgba(110,80,40,0.35)';
const DARK_RAISED_SHADOW = '0 2px 0 #0f0d0a, 0 14px 28px -14px rgba(0,0,0,0.7)';

export const TOKENS = defineTokens({
    '--minimap-viewport-highlight': '0 0 0 1px rgba(255,255,255,0.5) inset',
    '--sticky-vote-bg': '#2b2118',
    '--sticky-vote-text': '#ffffff',
    '--zone-fill-alpha': '0.13',
    '--shadow-sticky': '0 1px 1px rgba(110,80,40,0.12), 0 16px 18px -14px rgba(110,80,40,0.55)',
    '--shadow-sticky-flat': '0 1px 0 rgba(110,80,40,0.22)',
    '--bg': '#ffffff',
    '--bg-panel': '#fffcf6',
    '--bg-panel-2': '#f6eee1',
    '--bg-elev': '#fffcf6',
    '--bg-overlay': 'rgba(255,252,246,0.92)',
    '--bg-modal-veil': 'rgba(43,33,24,0.35)',
    '--text': '#2b2118',
    '--text-mid': '#4d4033',
    '--text-muted': '#74634f',
    '--text-faint': '#a8987f',
    '--border': '#e6dccb',
    '--border-soft': 'rgba(110,80,40,0.10)',
    '--border-strong': 'rgba(110,80,40,0.18)',
    '--btn-primary-bg': '#2b2118',
    '--btn-primary-fg': '#fffcf6',
    '--btn-primary-border': '#2b2118',
    '--btn-primary-hover': '#4d4033',
    '--accent': '#c2410c',
    '--accent-strong': '#9a3412',
    '--accent-bg': '#ffedd5',
    '--accent-text': '#9a3412',
    '--danger': '#b91c1c',
    '--warn-border': '#f3d27a',
    '--shadow-press': '0 2px 0 #e6dccb',
    '--warn-bg': '#fff0c2',
    '--warn-text': '#7a4b00',
    '--toast-bg': '#2b2118',
    '--toast-warn-bg': '#b91c1c',
    '--toast-text': '#fffcf6',
    '--grid-dot': 'rgba(110,80,40,0.16)',
    '--shadow-card': LIGHT_RAISED_SHADOW,
    '--shadow-pop': LIGHT_RAISED_SHADOW,
    '--shadow-modal': '0 2px 0 #e2d5bf, 0 24px 60px -20px rgba(110,80,40,0.45)',
    '--accent-fg': '#ffffff',
    '--danger-fg': '#ffffff',
    '--ok-bg': '#dcfce7',
    '--ok-text': '#166534',
    ...MODE_INDEPENDENT_TOKENS,
  }, {
    '--minimap-viewport-highlight': '0 0 0 1px rgba(255,236,210,0.18) inset',
    '--sticky-vote-bg': '#f3ebdf',
    '--sticky-vote-text': '#1b1814',
    '--zone-fill-alpha': '0.10',
    '--shadow-sticky': '0 1px 1px rgba(0,0,0,0.4), 0 18px 20px -14px rgba(0,0,0,0.9)',
    '--shadow-sticky-flat': '0 1px 0 rgba(0,0,0,0.5)',
    '--bg': '#1b1814',
    '--bg-panel': '#26211b',
    '--bg-panel-2': '#312a22',
    '--bg-elev': '#26211b',
    '--bg-overlay': 'rgba(38,33,27,0.92)',
    '--bg-modal-veil': 'rgba(0,0,0,0.6)',
    '--text': '#f3ebdf',
    '--text-mid': '#d8cbb8',
    '--text-muted': '#a99883',
    '--text-faint': '#776a5a',
    '--border': '#3f372d',
    '--border-soft': 'rgba(255,236,210,0.08)',
    '--border-strong': 'rgba(255,236,210,0.16)',
    '--btn-primary-bg': '#f3ebdf',
    '--btn-primary-fg': '#1b1814',
    '--btn-primary-border': '#f3ebdf',
    '--btn-primary-hover': '#d8cbb8',
    '--accent': '#fb923c',
    '--accent-strong': '#fdba74',
    '--accent-bg': '#483320',
    '--accent-text': '#fdba74',
    '--danger': '#f87171',
    '--warn-border': 'rgba(250,204,21,0.35)',
    '--shadow-press': '0 2px 0 #0f0d0a',
    '--warn-bg': '#44391a',
    '--warn-text': '#fcd34d',
    '--toast-bg': '#3a332a',
    '--toast-warn-bg': '#7f1d1d',
    '--toast-text': '#f3ebdf',
    '--grid-dot': 'rgba(255,230,200,0.07)',
    '--shadow-card': DARK_RAISED_SHADOW,
    '--shadow-pop': DARK_RAISED_SHADOW,
    '--shadow-modal': '0 2px 0 #0f0d0a, 0 24px 60px -20px rgba(0,0,0,0.8)',
    '--accent-fg': '#1b1814',
    '--danger-fg': '#1b1814',
    '--ok-bg': '#253b26',
    '--ok-text': '#86efac',
    ...MODE_INDEPENDENT_TOKENS,
  });

function resolveMode(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  // 'auto'
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

function applyTokens(mode) {
  const tokens = TOKENS[mode];
  if (!tokens) return;
  const root = document.documentElement;
  Object.keys(tokens).forEach((k) => root.style.setProperty(k, tokens[k]));
  root.setAttribute('data-theme', mode);
  document.body.style.background = tokens['--bg'];
  document.body.style.color = tokens['--text'];
}

function readPref() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'auto') return saved;
  } catch { /* swallow */ }
  return 'auto';
}

let currentPref = readPref();
const listeners = new Set();

// Apply immediately on first import.
if (typeof document !== 'undefined') {
  applyTokens(resolveMode(currentPref));
}

// React to OS theme changes when preference is 'auto'.
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => {
    if (currentPref === 'auto') {
      applyTokens(resolveMode('auto'));
      listeners.forEach((fn) => fn(currentPref));
    }
  });
}

export function getThemePref() { return currentPref; }

export function setThemePref(next) {
  if (!['light', 'dark', 'auto'].includes(next)) return;
  currentPref = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* swallow */ }
  applyTokens(resolveMode(next));
  listeners.forEach((fn) => fn(next));
}

export function useTheme() {
  const [pref, setPrefState] = useState(currentPref);
  useEffect(() => {
    const fn = (next) => setPrefState(next);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  const resolved = resolveMode(pref);
  return { pref, resolved, setThemePref };
}

// Convenience helper to cycle auto → light → dark → auto.
export function nextThemePref(cur) {
  if (cur === 'auto') return 'light';
  if (cur === 'light') return 'dark';
  return 'auto';
}
