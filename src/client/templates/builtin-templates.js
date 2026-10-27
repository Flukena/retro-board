import { STARTER_FORMAT, starterSlugs, starterTemplate } from './starter-formats.js';

// Both entry points evaluate the same layouts lazily in the current language.
export const getTemplates = () => Object.fromEntries(starterSlugs().map(slug => [
  slug === STARTER_FORMAT.RETRO_LOOP ? 'retroLoop' : slug, starterTemplate(slug),
]));
