import React from 'react';
import { t, useLang } from '../ui/i18n.js';
import SitePage, { SiteLinks } from './SitePage.jsx';

export default function NotFoundPage() {
  useLang();
  return (
    <SitePage labelledBy="not-found-title">
      <h1 id="not-found-title" className="rb-legal__title">{t('notFound.title')}</h1>
      <p className="rb-template__lede">{t('notFound.body')}</p>
      <SiteLinks />
    </SitePage>
  );
}
