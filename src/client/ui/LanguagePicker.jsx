import React from 'react';
import { ChevronDown, Languages } from 'lucide-react';
import { t, useLang } from './i18n.js';
import { LANGUAGE_OPTIONS } from './language-options.js';
import './ui.css';
import './language-picker.css';

const ICON_SIZE_PX = 16;
const CHEVRON_SIZE_PX = 14;

// The one language control used by every page: a pill-shaped native select,
// so it works with keyboards, screen readers and phone pickers.
export function LanguagePicker() {
  const [lang, setLang] = useLang();
  const label = t('settings.lang');
  return (
    <label className="rb-btn rb-btn--pill rb-lang-picker" title={label}>
      <Languages size={ICON_SIZE_PX} aria-hidden="true" />
      <select className="rb-lang-picker__select" aria-label={label} value={lang} onChange={(event) => setLang(event.target.value)}>
        {LANGUAGE_OPTIONS.map(({ code, name }) => <option key={code} value={code} lang={code}>{name}</option>)}
      </select>
      <ChevronDown size={CHEVRON_SIZE_PX} aria-hidden="true" className="rb-lang-picker__chevron" />
    </label>
  );
}
