import React from 'react';
import { t } from '../ui/i18n.js';
import { Surface } from '../ui/UiPrimitives.jsx';
import { SURFACE_KIND } from '../ui/ui-variants.js';
import { starterFormat, starterSlugs } from '../templates/starter-formats.js';

// Plain-language guide below the room cards: what the board does, how to run a
// retrospective, links to the template guides and an FAQ. It is static content,
// so it is also pre-rendered into the page HTML.

export const GUIDE_FEATURE_KEYS = Object.freeze(['notes', 'reveal', 'vote', 'extras', 'devices', 'export']);
export const GUIDE_STEP_KEYS = Object.freeze(['create', 'share', 'run']);
export const GUIDE_FAQ_KEYS = Object.freeze(['free', 'signup', 'access', 'keep', 'phone', 'lang']);

function GuideSection({ id, titleKey, children }) {
  return (
    <Surface kind={SURFACE_KIND.CARD} className="rb-landing__card rb-landing__guide" role="region" aria-labelledby={id}>
      <h2 id={id} className="rb-landing__section-head">{t(titleKey)}</h2>
      {children}
    </Surface>
  );
}

export default function LandingGuide() {
  return (
    <>
      <GuideSection id="landing-guide-intro" titleKey="guide.intro.title">
        <p className="rb-landing__guide-text">{t('guide.intro.body')}</p>
        <h3 className="rb-landing__guide-subhead">{t('guide.features.title')}</h3>
        <ul className="rb-landing__guide-list">
          {GUIDE_FEATURE_KEYS.map((key) => <li key={key}>{t(`guide.features.${key}`)}</li>)}
        </ul>
      </GuideSection>
      <GuideSection id="landing-guide-steps" titleKey="guide.steps.title">
        <ol className="rb-landing__guide-list">
          {GUIDE_STEP_KEYS.map((key) => <li key={key}>{t(`guide.steps.${key}`)}</li>)}
        </ol>
      </GuideSection>
      <GuideSection id="landing-guide-templates" titleKey="guide.templates.title">
        <p className="rb-landing__guide-text">{t('guide.templates.body')}</p>
        <ul className="rb-landing__guide-links">
          {starterSlugs().map((slug) => {
            const format = starterFormat(slug);
            return <li key={slug}><a href={format.path}>{t(format.headingKey)}</a></li>;
          })}
        </ul>
      </GuideSection>
      <GuideSection id="landing-guide-faq" titleKey="guide.faq.title">
        {GUIDE_FAQ_KEYS.map((key) => (
          <div key={key} className="rb-landing__faq">
            <h3 className="rb-landing__guide-subhead">{t(`guide.faq.${key}.q`)}</h3>
            <p className="rb-landing__guide-text">{t(`guide.faq.${key}.a`)}</p>
          </div>
        ))}
      </GuideSection>
    </>
  );
}
