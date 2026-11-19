import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { t, useLang } from '../ui/i18n.js';
import { LanguagePicker } from '../ui/LanguagePicker.jsx';
import { LEGAL_PAGE, LEGAL_PATH } from '../legal/legal-content.js';
import { starterFormat, starterSlugs } from '../templates/starter-formats.js';
import { AGILE_GUIDE_PATH } from '../seo/seo-pages.js';
import { pageHref } from '../seo/page-links.js';
import '../legal/legal.css';
import '../templates/template-page.css';

// Shared frame for the plain content pages (legal, template guides, not found):
// a bar with the home link and language switch, then the page's document.

const ICON_SIZE_PX = 16;
const HOME_PATH = '/';

export function SiteLinks({ current = null }) {
  return (
    <nav className="rb-template__links" aria-label={t('tpl.linksNav')}>
      <a href={pageHref(HOME_PATH)}>{t('tpl.homeLink')}</a>
      {starterSlugs().filter((slug) => slug !== current).map((slug) => {
        const format = starterFormat(slug);
        return <a key={slug} href={pageHref(format.path)}>{t(format.headingKey)}</a>;
      })}
      {current !== AGILE_GUIDE_PATH && <a href={pageHref(AGILE_GUIDE_PATH)}>{t('agileGuide.brand')}</a>}
      <a href={pageHref(LEGAL_PATH[LEGAL_PAGE.PRIVACY])}>{t('legal.footer.privacy')}</a>
      <a href={pageHref(LEGAL_PATH[LEGAL_PAGE.TERMS])}>{t('legal.footer.terms')}</a>
    </nav>
  );
}

export default function SitePage({ labelledBy, className = '', homeLink = true, children }) {
  useLang();
  return (
    <div className="rb-legal">
      <header className="rb-legal__bar">
        {homeLink && (
          <a className="rb-legal__home" href={pageHref(HOME_PATH)}>
            <ArrowLeft size={ICON_SIZE_PX} aria-hidden="true" />{t('legal.home')}
          </a>
        )}
        <LanguagePicker />
      </header>
      <main className={`rb-legal__doc ${className}`.trim()} aria-labelledby={labelledBy}>{children}</main>
    </div>
  );
}
