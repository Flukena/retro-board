import React from 'react';
import { BookOpen, Spade, Sparkles } from 'lucide-react';
import { t, useLang } from '../ui/i18n.js';
import { SiteLinks } from '../app/SitePage.jsx';
import SiteMasthead from '../app/SiteMasthead.jsx';
import { Surface } from '../ui/UiPrimitives.jsx';
import { SURFACE_KIND } from '../ui/ui-variants.js';
import { AGILE_GUIDE_PATH, PLANNING_POKER_PATH } from '../seo/seo-pages.js';
import { AGILE_GUIDE_SECTIONS, AGILE_SECTION, GUIDE_BLOCK } from './agile-guide-content.js';
import '../legal/legal.css';
import '../templates/template-page.css';
import './guide.css';

const RETRO_HOME_PATH = '/';
const CTA_ICON_SIZE_PX = 16;
const MORE_SECTION_ID = 'agile-guide-more';
const sectionHref = (id) => `#${AGILE_GUIDE_SECTIONS.find((section) => section.id === id).anchorId}`;
const GUIDE_LINKS = Object.freeze([
  { href: sectionHref(AGILE_SECTION.AGILE), labelKey: 'agileGuide.nav.agile' },
  { href: sectionHref(AGILE_SECTION.SCRUM), labelKey: 'agileGuide.nav.scrum' },
  { href: sectionHref(AGILE_SECTION.RETRO), labelKey: 'agileGuide.nav.retro' },
]);

function RowHeader({ row }) {
  const [nameKey] = row.cellKeys;
  return <th scope="row">{row.href ? <a href={row.href}>{t(nameKey)}</a> : t(nameKey)}</th>;
}

function GuideTable({ block }) {
  return (
    <div className="rb-guide-table">
      <table>
        <thead>
          <tr>{block.columnKeys.map((columnKey) => <th key={columnKey} scope="col">{t(columnKey)}</th>)}</tr>
        </thead>
        <tbody>
          {block.rows.map((row) => (
            <tr key={row.id}>
              <RowHeader row={row} />
              {row.cellKeys.slice(1).map((cellKey) => <td key={cellKey}>{t(cellKey)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const itemsOf = (block) => block.keys.map((itemKey) => <li key={itemKey}>{t(itemKey)}</li>);

const BLOCK_VIEWS = Object.freeze({
  [GUIDE_BLOCK.PARAGRAPH]: (block) => <p>{t(block.key)}</p>,
  [GUIDE_BLOCK.SUBHEADING]: (block) => <h3>{t(block.key)}</h3>,
  [GUIDE_BLOCK.ORDERED]: (block) => <ol className="rb-template__list">{itemsOf(block)}</ol>,
  [GUIDE_BLOCK.BULLETS]: (block) => <ul className="rb-template__list">{itemsOf(block)}</ul>,
  [GUIDE_BLOCK.TABLE]: (block) => <GuideTable block={block} />,
  [GUIDE_BLOCK.LINKS]: (block) => (
    <ul className="rb-template__list rb-guide-home__sources">
      {block.links.map((link) => <li key={link.href}><a href={link.href}>{t(link.key)}</a></li>)}
    </ul>
  ),
});

function GuideSection({ section }) {
  return (
    <section className="rb-legal__section" aria-labelledby={section.anchorId}>
      <h2 id={section.anchorId}>{t(section.titleKey)}</h2>
      {section.blocks.map((block, index) => (
        // Blocks are a fixed list from the content module, so their position is a stable key.
        <React.Fragment key={`${section.id}-${index}`}>{BLOCK_VIEWS[block.kind](block)}</React.Fragment>
      ))}
    </section>
  );
}

function GuideCallToAction() {
  return (
    <Surface kind={SURFACE_KIND.CARD} className="rb-landing__card rb-guide-home__cta">
      <p className="rb-guide-home__cta-title">{t('agileGuide.cta.title')}</p>
      <a className="rb-btn rb-btn--primary rb-btn--pill" href={RETRO_HOME_PATH}>
        <Sparkles size={CTA_ICON_SIZE_PX} aria-hidden="true" />{t('agileGuide.cta.retro')}
      </a>
      <a className="rb-btn rb-btn--pill" href={PLANNING_POKER_PATH}>
        <Spade size={CTA_ICON_SIZE_PX} aria-hidden="true" />{t('agileGuide.cta.poker')}
      </a>
    </Surface>
  );
}

// Public reader guide to Agile and Scrum, pre-rendered in English and Thai.
export default function AgileGuidePage() {
  useLang();
  return (
    <div className="rb-landing__page">
      <div className="rb-landing__content rb-guide-home">
        <SiteMasthead homeHref={AGILE_GUIDE_PATH} BrandIcon={BookOpen} titleKey="agileGuide.brand" links={GUIDE_LINKS} />
        <main className="rb-guide-home__main" aria-labelledby="agile-guide-title">
          <h1 id="agile-guide-title" className="rb-guide-home__title">{t('agileGuide.heading')}</h1>
          <p className="rb-guide-home__lede">{t('agileGuide.lede')}</p>
          <GuideCallToAction />
          <Surface kind={SURFACE_KIND.CARD} className="rb-landing__card rb-guide-home__article">
            {AGILE_GUIDE_SECTIONS.map((section) => <GuideSection key={section.id} section={section} />)}
            <section className="rb-legal__section" aria-labelledby={MORE_SECTION_ID}>
              <h2 id={MORE_SECTION_ID}>{t('tpl.section.more')}</h2>
              <SiteLinks current={AGILE_GUIDE_PATH} />
            </section>
          </Surface>
        </main>
      </div>
    </div>
  );
}
