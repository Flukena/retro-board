// Tiny i18n: a `t(key, params)` lookup with localStorage persistence and
// an English default. No external dependency.

import { useEffect, useState } from 'react';
import th from './locales/th.js';
import en from './locales/en.js';

const STORAGE_KEY = 'rb_lang';
const DEFAULT_LANG = 'en';

const dict = { th, en };

// Thai and English ship in the main bundle; the other languages load on
// demand, one chunk each, the first time someone picks them.
export const LOCALE_LOADERS = Object.freeze({
  zh: () => import('./locales/zh.js'),
  ja: () => import('./locales/ja.js'),
  ko: () => import('./locales/ko.js'),
  es: () => import('./locales/es.js'),
  pt: () => import('./locales/pt.js'),
  de: () => import('./locales/de.js'),
  fr: () => import('./locales/fr.js'),
  vi: () => import('./locales/vi.js'),
  id: () => import('./locales/id.js'),
});

// Shown in each language's own name, so anyone can find theirs.
export const LANGUAGE_OPTIONS = Object.freeze([
  { code: 'en', name: 'English' },
  { code: 'th', name: 'ไทย' },
  { code: 'zh', name: '简体中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'es', name: 'Español' },
  { code: 'pt', name: 'Português' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'id', name: 'Bahasa Indonesia' },
].map(Object.freeze));

const isSupported = (code) => Object.hasOwn(dict, code) || Object.hasOwn(LOCALE_LOADERS, code);

// English is the product default; only an explicit saved choice changes the first paint.
export function initialLanguage(saved) {
  return saved && isSupported(saved) ? saved : DEFAULT_LANG;
}

function savedLanguage() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

let currentLang = DEFAULT_LANG;
let requestedLang = DEFAULT_LANG;
const listeners = new Set();

export function getLang() { return currentLang; }

function applyLang(next) {
  if (next === currentLang) return;
  currentLang = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* swallow */ }
  listeners.forEach((fn) => fn(next));
}

// Switches at once for a loaded language; otherwise loads its chunk first.
// The last request wins if several loads overlap. A chunk that fails to load
// leaves the current language in place.
export function setLang(next) {
  requestedLang = next;
  if (Object.hasOwn(dict, next)) {
    applyLang(next);
    return Promise.resolve();
  }
  const load = LOCALE_LOADERS[next];
  if (!load) return Promise.resolve();
  return load().then((module) => {
    dict[next] = module.default;
    if (requestedLang === next) applyLang(next);
  }, () => undefined);
}

// Resolves when the saved language is ready, so the first paint uses it.
export const languageReady = setLang(initialLanguage(savedLanguage()));

export function t(key, params) {
  const table = dict[currentLang] || dict.en;
  let s = table[key] ?? dict.en[key] ?? key;
  if (params && typeof s === 'string') {
    Object.keys(params).forEach((p) => {
      s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(params[p]));
    });
  }
  return s;
}

export function useLang() {
  const [lang, setLangState] = useState(currentLang);
  useEffect(() => {
    const fn = (next) => setLangState(next);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return [lang, setLang];
}
