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

test('the home guide renders feature cards, step cards, template cards and a collapsible FAQ in both languages', async () => {
  await withChromeModule('/src/client/app/LandingGuide.jsx', ({ default: LandingGuide }, { setLang, t }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const markup = renderToStaticMarkup(React.createElement(LandingGuide));
      assert.doesNotMatch(markup, UNTRANSLATED, lang);
      assert.equal((markup.match(/<h2/g) || []).length, 5, lang);
      assert.equal((markup.match(/class="rb-landing__feature"/g) || []).length, 6, `${lang}: feature cards`);
      for (const key of ['notes', 'reveal', 'vote', 'extras', 'devices', 'export']) assert.ok(markup.includes(t(`guide.features.${key}.title`)));
      assert.equal((markup.match(/class="rb-landing__template"/g) || []).length, 4, `${lang}: template cards`);
      for (const [path, name] of [['/templates/retro-loop', 'Retro Loop'], ['/templates/start-stop-continue', 'Start Stop Continue'], ['/templates/mad-sad-glad', 'Mad Sad Glad'], ['/templates/4ls-retrospective', '4Ls']]) {
        assert.match(markup, new RegExp(`href="${path}"`), `${lang} ${path}`);
        assert.ok(markup.includes(`aria-label="${t('tpl.start', { name })}"`), `${lang}: start ${name}`);
      }
      assert.equal((markup.match(/<details/g) || []).length, 6, `${lang}: FAQ items`);
      assert.equal((markup.match(/<details[^>]* open=""/g) || []).length, 1, `${lang}: only the first answer starts open`);
      for (const key of ['free', 'signup', 'access', 'keep', 'phone', 'lang']) assert.ok(markup.includes(t(`guide.faq.${key}.a`)), `${lang}: answer ${key} is in the HTML`);
    }
  });
});

test('a template card Start button hands its format to the page', async () => {
  await withChromeModule('/src/client/app/LandingGuide.jsx', ({ default: LandingGuide }) => {
    const started = [];
    const tree = LandingGuide({ onStartFormat: (slug) => started.push(slug) });
    const find = (node, match) => {
      if (!node || typeof node !== 'object') return null;
      if (Array.isArray(node)) return node.map((child) => find(child, match)).find(Boolean) ?? null;
      if (match(node)) return node;
      if (typeof node.type === 'function') return find(node.type(node.props), match);
      return find(node.props?.children, match);
    };
    const card = find(tree, (node) => node.props?.slug === 'mad-sad-glad');
    const button = find(card, (node) => node.type === 'button');
    button.props.onClick();
    assert.deepEqual(started, ['mad-sad-glad']);
  });
});

test('template guides and the not-found page render fully translated in both languages', async () => {
  for (const slug of ['retro-loop', 'start-stop-continue', 'mad-sad-glad', '4ls-retrospective']) {
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
