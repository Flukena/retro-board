import test from 'node:test';
import assert from 'node:assert/strict';
import { getTemplates } from './builtin-templates.js';
import { normalizeCustomTemplates } from '../../domain/import-schema.js';
import { getLang, setLang, t } from '../ui/i18n.js';

const TEMPLATE_CREATED_AT_MS = 123;
const LOOP_ZONE_TITLE_KEYS = [
  'tmpl.loop.wrapper', 'tmpl.loop.prev', 'tmpl.loop.good',
  'tmpl.loop.bad', 'tmpl.loop.try', 'tmpl.loop.next',
];

test('Retro Loop is the only built-in, validates through the real decoder, and translates lazily', (context) => {
  const originalLang = getLang();
  context.after(() => setLang(originalLang));
  for (const lang of ['th', 'en']) {
    setLang(lang);
    const entries = Object.entries(getTemplates());
    assert.deepEqual(entries.map(([key]) => key), ['retroLoop']);
    const [id, template] = entries[0];
    const entry = { id, ...template, createdAt: TEMPLATE_CREATED_AT_MS };
    assert.deepEqual(normalizeCustomTemplates([entry]), [entry]);
    assert.equal(template.name, t('tmpl.loop.name'));
    assert.notEqual(template.name, 'tmpl.loop.name');
    assert.deepEqual(template.zones.map(({ title }) => title), LOOP_ZONE_TITLE_KEYS.map((key) => t(key)));
    for (const key of LOOP_ZONE_TITLE_KEYS) {
      assert.notEqual(t(key), key);
    }
  }
});
