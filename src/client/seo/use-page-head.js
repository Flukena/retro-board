import { useEffect } from 'react';
import { t, useLang } from '../ui/i18n.js';

// Keeps <html lang> and, for content pages, the tab title in the chosen language.
// The pre-rendered HTML ships the English head; this updates it after load.
export function usePageHead(titleKey = null) {
  const [lang] = useLang();
  useEffect(() => {
    document.documentElement.lang = lang;
    if (titleKey) document.title = t(titleKey);
  }, [lang, titleKey]);
}
