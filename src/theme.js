// Theme: applies CSS variables on <html data-theme="…"> so any inline style
// can reference `var(--bg)` etc. Tri-state preference: 'light' | 'dark' | 'auto'.
// 'auto' follows prefers-color-scheme and updates live.

import { useEffect, useState } from 'react';

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
  '--radius-sm': '10px',
  '--radius-md': '12px',
  '--font-ui': '"Sarabun", system-ui, -apple-system, "Segoe UI", sans-serif',
  '--font-display': '"Mitr", "Sarabun", sans-serif',
  '--font-mono': '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
});
const LIGHT_RAISED_SHADOW = '0 2px 0 #e2d5bf, 0 12px 24px -14px rgba(110,80,40,0.35)';
const DARK_RAISED_SHADOW = '0 2px 0 #0f0d0a, 0 14px 28px -14px rgba(0,0,0,0.7)';

export const TOKENS = defineTokens({
    '--bg': '#f5efe4',
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
