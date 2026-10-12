import test from 'node:test';
import assert from 'node:assert/strict';
import { getTemplates } from './builtin-templates.js';
import { normalizeCustomTemplates } from './import-schema.js';
import { setLang, t } from './i18n.js';

test('built-ins retain keys/order, validate through the real decoder, and translate lazily', () => {
  for (const lang of ['th', 'en']) {
    setLang(lang);
    const entries = Object.entries(getTemplates());
    assert.deepEqual(entries.map(([key]) => key), ['retro3', 'ssc', 'fourLs', 'sailboat', 'retroLoop']);
    for (const [id, template] of entries) {
      const entry = { id, ...template, createdAt: 123 };
      assert.deepEqual(normalizeCustomTemplates([entry]), [entry]);
    }
    assert.equal(getTemplates().retro3.name, t('tmpl.retro3.name'));
    assert.equal(getTemplates().retro3.zones[0].title, t('tmpl.retro3.well'));
  }
});
