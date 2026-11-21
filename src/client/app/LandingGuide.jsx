import React from 'react';
import { StickyNote, EyeOff, ThumbsUp, MessageSquare, Smartphone, Download, ArrowRight } from 'lucide-react';
import { t } from '../ui/i18n.js';
import { paletteStyleVars } from '../ui/palette.js';
import { TemplateThumbnail } from '../templates/TemplateThumbnail.jsx';
import { starterFormat, starterSlugs, starterTemplate } from '../templates/starter-formats.js';
import { AGILE_GUIDE_PATH } from '../seo/seo-pages.js';
import { pageHref } from '../seo/page-links.js';
import CreateBoardError from './CreateBoardError.jsx';

// Plain-language guide below the hero: what the board does, how to run a
// retrospective, the template guides and an FAQ. It renders without scripts,
// so it is also pre-rendered into the page HTML.

const FEATURE_ICON_SIZE_PX = 18;
// Indexes into PALETTE (src/client/ui/palette.js).
const PALETTE_INDEX = Object.freeze({ YELLOW: 0, RED: 1, GREEN: 2, BLUE: 3, PURPLE: 4, ORANGE: 5 });
const LINK_ICON_SIZE_PX = 14;
const GUIDE_FEATURES = Object.freeze([
  { key: 'notes', Icon: StickyNote, color: PALETTE_INDEX.YELLOW },
  { key: 'reveal', Icon: EyeOff, color: PALETTE_INDEX.PURPLE },
  { key: 'vote', Icon: ThumbsUp, color: PALETTE_INDEX.GREEN },
  { key: 'extras', Icon: MessageSquare, color: PALETTE_INDEX.BLUE },
  { key: 'devices', Icon: Smartphone, color: PALETTE_INDEX.RED },
  { key: 'export', Icon: Download, color: PALETTE_INDEX.ORANGE },
]);
const GUIDE_STEP_KEYS = Object.freeze(['create', 'share', 'run']);
const GUIDE_FAQ_KEYS = Object.freeze(['free', 'signup', 'access', 'keep', 'phone', 'lang']);

function GuideSection({ id, titleKey, children }) {
  return (
    <section className="rb-landing__section" id={id} aria-labelledby={`${id}-title`} tabIndex={-1}>
      <h2 id={`${id}-title`} className="rb-landing__section-title">{t(titleKey)}</h2>
      {children}
    </section>
  );
}

function TemplateCard({ slug, onStart, creating }) {
  const format = starterFormat(slug);
  const name = t(format.nameKey);
  return (
    <li className="rb-landing__template">
      <TemplateThumbnail zones={starterTemplate(slug).zones} />
      <h3>{t(format.headingKey)}</h3>
      <p>{t(format.ledeKey)}</p>
      <div className="rb-landing__template-actions">
        <a href={pageHref(format.path)}>{t('guide.templates.read')} <ArrowRight size={LINK_ICON_SIZE_PX} aria-hidden="true" /></a>
        <button type="button" className="rb-btn rb-landing__template-start" disabled={creating}
          aria-label={t('tpl.start', { name })} onClick={() => onStart?.(slug)}>
          {t('guide.templates.start')}
        </button>
      </div>
    </li>
  );
}

export default function LandingGuide({ onStartFormat, creating = false, createError = null }) {
  return (
    <div className="rb-landing__guide">
      <GuideSection id="landing-guide-intro" titleKey="guide.intro.title">
        <p className="rb-landing__lede">{t('guide.intro.body')}</p>
      </GuideSection>
      <GuideSection id="landing-guide-features" titleKey="guide.features.title">
        <ul className="rb-landing__features">
          {GUIDE_FEATURES.map(({ key, Icon, color }) => (
            <li key={key} className="rb-landing__feature">
              <span className="rb-landing__feature-icon" style={paletteStyleVars(color, 'rb-feature')}><Icon size={FEATURE_ICON_SIZE_PX} aria-hidden="true" /></span>
              <h3>{t(`guide.features.${key}.title`)}</h3>
              <p>{t(`guide.features.${key}`)}</p>
            </li>
          ))}
        </ul>
      </GuideSection>
      <GuideSection id="landing-guide-steps" titleKey="guide.steps.title">
        <ol className="rb-landing__steps">
          {GUIDE_STEP_KEYS.map((key) => <li key={key}>{t(`guide.steps.${key}`)}</li>)}
        </ol>
        <a className="rb-landing__more" href={pageHref(AGILE_GUIDE_PATH)}>
          {t('agileGuide.brand')} <ArrowRight size={LINK_ICON_SIZE_PX} aria-hidden="true" />
        </a>
      </GuideSection>
      <GuideSection id="landing-guide-templates" titleKey="guide.templates.title">
        <p className="rb-landing__lede">{t('guide.templates.body')}</p>
        <ul className="rb-landing__templates">
          {starterSlugs().map((slug) => <TemplateCard key={slug} slug={slug} onStart={onStartFormat} creating={creating} />)}
        </ul>
        <CreateBoardError error={createError} />
      </GuideSection>
      <GuideSection id="landing-guide-faq" titleKey="guide.faq.title">
        <div className="rb-landing__faqs">
          {GUIDE_FAQ_KEYS.map((key, index) => (
            <details key={key} className="rb-landing__faq" open={index === 0}>
              <summary>{t(`guide.faq.${key}.q`)}</summary>
              <p>{t(`guide.faq.${key}.a`)}</p>
            </details>
          ))}
        </div>
      </GuideSection>
    </div>
  );
}
