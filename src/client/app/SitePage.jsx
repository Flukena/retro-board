import React from 'react';
import { ArrowLeft, Languages } from 'lucide-react';
import { Button } from '../ui/UiPrimitives.jsx';
import { t, useLang } from '../ui/i18n.js';
import { LEGAL_PAGE, LEGAL_PATH } from '../legal/legal-content.js';
import { starterFormat, starterSlugs } from '../templates/starter-formats.js';
import '../legal/legal.css';
import '../templates/template-page.css';

// Shared frame for the plain content pages (legal, template guides, not found):
// a bar with the home link and language switch, then the page's document.

const ICON_SIZE_PX = 16;
const OTHER_LANG = Object.freeze({ th: 'en', en: 'th' });

export function SiteLinks({ current = null }) {
  return (
    <nav className="rb-template__links" aria-label={t('tpl.linksNav')}>
      <a href="/">{t('tpl.homeLink')}</a>
      {starterSlugs().filter((slug) => slug !== current).map((slug) => {
        const format = starterFormat(slug);
        return <a key={slug} href={format.path}>{t(format.headingKey)}</a>;
      })}
      <a href={LEGAL_PATH[LEGAL_PAGE.PRIVACY]}>{t('legal.footer.privacy')}</a>
      <a href={LEGAL_PATH[LEGAL_PAGE.TERMS]}>{t('legal.footer.terms')}</a>
    </nav>
  );
}

export default function SitePage({ labelledBy, className = '', children }) {
  const [lang, setLang] = useLang();
  return (
    <div className="rb-legal">
      <header className="rb-legal__bar">
        <a className="rb-legal__home" href="/">
          <ArrowLeft size={ICON_SIZE_PX} aria-hidden="true" />{t('legal.home')}
        </a>
        <Button className="rb-btn--pill" onClick={() => setLang(OTHER_LANG[lang])} title={t('settings.lang')}>
          <Languages size={ICON_SIZE_PX} aria-hidden="true" />
          {t(`settings.lang.${lang}`)}
        </Button>
      </header>
      <main className={`rb-legal__doc ${className}`.trim()} aria-labelledby={labelledBy}>{children}</main>
    </div>
  );
}
