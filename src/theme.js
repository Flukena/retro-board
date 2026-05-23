// Theme: applies CSS variables on <html data-theme="…"> so any inline style
// can reference `var(--bg)` etc. Tri-state preference: 'light' | 'dark' | 'auto'.
// 'auto' follows prefers-color-scheme and updates live.

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'rb_theme';

const TOKENS = {
  light: {
    '--bg': '#f8f7f4',
    '--bg-panel': '#ffffff',
    '--bg-panel-2': '#f3f4f6',
    '--bg-elev': '#ffffff',
    '--bg-overlay': 'rgba(255,255,255,0.92)',
    '--bg-modal-veil': 'rgba(0,0,0,0.4)',
    '--text': '#111827',
    '--text-mid': '#374151',
    '--text-muted': '#6b7280',
    '--text-faint': '#9ca3af',
    '--border': '#d1d5db',
    '--border-soft': 'rgba(0,0,0,0.06)',
    '--border-strong': 'rgba(0,0,0,0.1)',
    '--accent': '#0ea5e9',
    '--accent-strong': '#0284c7',
    '--accent-bg': '#e0f2fe',
    '--accent-text': '#0369a1',
    '--danger': '#ef4444',
    '--warn-bg': '#fef3c7',
    '--warn-text': '#b45309',
    '--toast-bg': '#111827',
    '--toast-warn-bg': '#b91c1c',
    '--toast-text': '#ffffff',
    '--grid-dot': 'rgba(0,0,0,0.13)',
    '--shadow-card': '0 4px 12px rgba(0,0,0,0.06)',
    '--shadow-pop': '0 8px 20px rgba(0,0,0,0.18)',
    '--shadow-modal': '0 20px 60px rgba(0,0,0,0.3)',
  },
  dark: {
    '--bg': '#0f172a',
    '--bg-panel': '#1e293b',
    '--bg-panel-2': '#334155',
    '--bg-elev': '#1e293b',
    '--bg-overlay': 'rgba(15,23,42,0.92)',
    '--bg-modal-veil': 'rgba(0,0,0,0.6)',
    '--text': '#f1f5f9',
    '--text-mid': '#cbd5e1',
    '--text-muted': '#94a3b8',
    '--text-faint': '#64748b',
    '--border': '#475569',
    '--border-soft': 'rgba(255,255,255,0.08)',
    '--border-strong': 'rgba(255,255,255,0.15)',
    '--accent': '#38bdf8',
    '--accent-strong': '#0ea5e9',
    '--accent-bg': 'rgba(56,189,248,0.16)',
    '--accent-text': '#7dd3fc',
    '--danger': '#f87171',
    '--warn-bg': 'rgba(251,191,36,0.18)',
    '--warn-text': '#fbbf24',
    '--toast-bg': '#0f172a',
    '--toast-warn-bg': '#7f1d1d',
    '--toast-text': '#f1f5f9',
    '--grid-dot': 'rgba(255,255,255,0.10)',
    '--shadow-card': '0 4px 12px rgba(0,0,0,0.4)',
    '--shadow-pop': '0 8px 20px rgba(0,0,0,0.5)',
    '--shadow-modal': '0 20px 60px rgba(0,0,0,0.6)',
  },
};

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
