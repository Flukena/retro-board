// Privacy policy and terms pages: routes and section structure.
// The wording lives in i18n.js under `legal.*` so both languages stay in sync.

export const LEGAL_PAGE = Object.freeze({ PRIVACY: 'privacy', TERMS: 'terms' });

export const LEGAL_PATH = Object.freeze({
  [LEGAL_PAGE.PRIVACY]: '/privacy',
  [LEGAL_PAGE.TERMS]: '/terms',
});

// Shown on both pages; update together with any change to the wording.
export const LEGAL_EFFECTIVE_DATE_ISO = '2026-10-25';

// Owner-provided address people can write to about their data or these terms.
export const LEGAL_CONTACT_EMAIL = 's.theerasuwanajak@gmail.com';

const SECTION_IDS = Object.freeze({
  [LEGAL_PAGE.PRIVACY]: ['intro', 'collect', 'browser', 'use', 'share', 'retention', 'security', 'rights', 'changes', 'contact'],
  [LEGAL_PAGE.TERMS]: ['accept', 'service', 'links', 'content', 'conduct', 'removal', 'warranty', 'liability', 'law', 'changes', 'contact'],
});

export const legalSections = (page) => (SECTION_IDS[page] || []).map((id) => ({
  id,
  titleKey: `legal.${page}.${id}.title`,
  bodyKey: `legal.${page}.${id}.body`,
}));

export const legalPageForPath = (path) => {
  const trimmed = path.length > 1 ? path.replace(/\/$/, '') : path;
  return Object.values(LEGAL_PAGE).find((page) => LEGAL_PATH[page] === trimmed) ?? null;
};

export const otherLegalPage = (page) => (page === LEGAL_PAGE.PRIVACY ? LEGAL_PAGE.TERMS : LEGAL_PAGE.PRIVACY);
