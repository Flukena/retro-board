import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const UNTRANSLATED = /\b(guide|tpl|notFound|seo)\.[a-z0-9.]+/;

const renderBoth = (path, props, check) => withChromeModule(path, (module, { setLang }) => {
  for (const lang of ['th', 'en']) {
    setLang(lang);
    check(renderToStaticMarkup(React.createElement(module.default, props)), lang);
  }
});

test('the home guide renders every section, question and template link in both languages', async () => {
  await renderBoth('/src/client/app/LandingGuide.jsx', {}, (markup, lang) => {
    assert.doesNotMatch(markup, UNTRANSLATED, lang);
    assert.equal((markup.match(/<h2/g) || []).length, 4, lang);
    assert.equal((markup.match(/rb-landing__faq/g) || []).length, 6, lang);
    for (const path of ['/templates/start-stop-continue', '/templates/mad-sad-glad', '/templates/4ls-retrospective']) {
      assert.match(markup, new RegExp(`href="${path}"`), `${lang} ${path}`);
    }
  });
});

test('template guides and the not-found page render fully translated in both languages', async () => {
  for (const slug of ['start-stop-continue', 'mad-sad-glad', '4ls-retrospective']) {
    await renderBoth('/src/client/templates/TemplatePage.jsx', { slug }, (markup, lang) => {
      assert.doesNotMatch(markup, UNTRANSLATED, `${lang} ${slug}`);
      assert.match(markup, /<button[^>]*class="[^"]*rb-btn--primary/, `${lang} ${slug}: start button`);
      assert.doesNotMatch(markup, new RegExp(`href="/templates/${slug}"`), 'no link to itself');
    });
  }
  await renderBoth('/src/client/app/NotFoundPage.jsx', {}, (markup, lang) => {
    assert.doesNotMatch(markup, UNTRANSLATED, lang);
    assert.match(markup, /href="\/"/);
  });
});
