import React from 'react';
import { ArrowLeft, Languages } from 'lucide-react';
import { Button } from '../ui/UiPrimitives.jsx';
import { t, useLang } from '../ui/i18n.js';
import {
  LEGAL_CONTACT_EMAIL, LEGAL_EFFECTIVE_DATE_ISO, LEGAL_PATH, legalSections, otherLegalPage,
} from './legal-content.js';
import './legal.css';

const ICON_SIZE_PX = 16;
const OTHER_LANG = Object.freeze({ th: 'en', en: 'th' });

const paragraphs = (text) => text.split('\n').filter(Boolean);

export default function LegalPage({ page }) {
  const [lang, setLang] = useLang();
  const other = otherLegalPage(page);
  const params = { date: LEGAL_EFFECTIVE_DATE_ISO, email: LEGAL_CONTACT_EMAIL };
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
      <main className="rb-legal__doc" aria-labelledby="legal-title">
        <h1 id="legal-title" className="rb-legal__title">{t(`legal.${page}.title`)}</h1>
        <p className="rb-legal__date">{t('legal.effective', params)}</p>
        {legalSections(page).map((section) => (
          <section key={section.id} className="rb-legal__section" aria-labelledby={`legal-${section.id}`}>
            <h2 id={`legal-${section.id}`}>{t(section.titleKey)}</h2>
            {paragraphs(t(section.bodyKey, params)).map((line) => <p key={line}>{line}</p>)}
          </section>
        ))}
        <p className="rb-legal__other">
          <a href={LEGAL_PATH[other]}>{t(`legal.${other}.title`)}</a>
        </p>
      </main>
    </div>
  );
}
