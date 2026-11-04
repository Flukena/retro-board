// schema.org JSON-LD for pre-rendered pages, so search engines and their AI
// answers can read what a page is about, who publishes it and what it cites.

const SCHEMA_CONTEXT = 'https://schema.org';
const PUBLISHER_NAME = 'RetroRoom';

// First publication of the Agile & Scrum guide; bump `modified` with content changes.
export const AGILE_GUIDE_DATES = Object.freeze({ published: '2026-11-04', modified: '2026-11-04' });

// Topics the guide covers, tied to their Wikipedia entries so the subject is unambiguous.
export const AGILE_GUIDE_TOPICS = Object.freeze([
  { name: 'Agile software development', sameAs: 'https://en.wikipedia.org/wiki/Agile_software_development' },
  { name: 'Scrum', sameAs: 'https://en.wikipedia.org/wiki/Scrum_(software_development)' },
  { name: 'Retrospective', sameAs: 'https://en.wikipedia.org/wiki/Retrospective' },
]);

const publisher = (siteUrl) => ({ '@type': 'Organization', name: PUBLISHER_NAME, url: siteUrl });

/** An Article for one language version of a guide page. */
export function articleStructuredData({ lang, url, siteUrl, headline, description, imageUrl, dates, citations, topics }) {
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'Article',
    headline,
    description,
    inLanguage: lang,
    url,
    mainEntityOfPage: url,
    image: imageUrl,
    datePublished: dates.published,
    dateModified: dates.modified,
    author: publisher(siteUrl),
    publisher: publisher(siteUrl),
    citation: citations,
    about: topics.map((topic) => ({ '@type': 'Thing', ...topic })),
  };
}
