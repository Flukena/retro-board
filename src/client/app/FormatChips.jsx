import React from 'react';
import { t } from '../ui/i18n.js';
import { TemplateThumbnail } from '../templates/TemplateThumbnail.jsx';
import { starterFormat, starterSlugs, starterTemplate } from '../templates/starter-formats.js';

// One button per starter format. Pressing one creates a room with that layout.
export default function FormatChips({ onStart, disabled = false }) {
  return (
    <ul className="rb-landing__chips">
      {starterSlugs().map((slug) => {
        const name = t(starterFormat(slug).nameKey);
        return (
          <li key={slug}>
            <button type="button" className="rb-landing__chip" disabled={disabled}
              aria-label={t('tpl.start', { name })} onClick={() => onStart?.(slug)}>
              <TemplateThumbnail zones={starterTemplate(slug).zones} />
              {name}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
