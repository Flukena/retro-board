import test from 'node:test';
import assert from 'node:assert/strict';
import { LEGAL_PAGE, LEGAL_PATH, legalPageForPath, legalSections, otherLegalPage } from './legal-content.js';

test('legal paths resolve to their page with or without a trailing slash', () => {
  assert.equal(legalPageForPath('/privacy'), LEGAL_PAGE.PRIVACY);
  assert.equal(legalPageForPath('/terms/'), LEGAL_PAGE.TERMS);
  assert.equal(legalPageForPath('/'), null);
  assert.equal(legalPageForPath('/b/privacy'), null);
  assert.equal(legalPageForPath('/privacyx'), null);
});

test('each page links to the other and lists sections ending with contact', () => {
  for (const page of Object.values(LEGAL_PAGE)) {
    assert.notEqual(otherLegalPage(page), page);
    assert.ok(LEGAL_PATH[otherLegalPage(page)]);
    const sections = legalSections(page);
    assert.equal(sections.at(-1).id, 'contact');
    assert.equal(new Set(sections.map((section) => section.id)).size, sections.length);
  }
  assert.deepEqual(legalSections('unknown'), []);
});
