import React from 'react';
import { t, useLang } from '../ui/i18n.js';
import SitePage from '../app/SitePage.jsx';
import {
  LEGAL_CONTACT_EMAIL, LEGAL_EFFECTIVE_DATE_ISO, LEGAL_PATH, legalSections, otherLegalPage,
} from './legal-content.js';

const paragraphs = (text) => text.split('\n').filter(Boolean);

export default function LegalPage({ page }) {
  useLang();
  const other = otherLegalPage(page);
  const params = { date: LEGAL_EFFECTIVE_DATE_ISO, email: LEGAL_CONTACT_EMAIL };
  return (
    <SitePage labelledBy="legal-title">
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
    </SitePage>
  );
}
