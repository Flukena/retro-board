import { useEffect } from 'react';
import { t, useLang } from '../ui/i18n.js';

const KEEP_TITLE = (title) => title;

// Keeps <html lang> and, for content pages, the tab title in the chosen language.
// The pre-rendered HTML ships the English head; this updates it after load.
// `formatTitle` shapes the translated title; pass a module-level function so the effect stays stable.
export function usePageHead(titleKey = null, formatTitle = KEEP_TITLE) {
  const [lang] = useLang();
  useEffect(() => {
    document.documentElement.lang = lang;
    if (titleKey) document.title = formatTitle(t(titleKey));
  }, [lang, titleKey, formatTitle]);
}
