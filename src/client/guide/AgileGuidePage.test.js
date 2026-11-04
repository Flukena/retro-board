import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const THAI_TEXT = /[฀-๿]/;
const SECTION_COUNT = 9;

test('the guide page has one h1, its nine sections plus more links, and in-page links that land on sections', async () => {
  await withChromeModule('/src/client/guide/AgileGuidePage.jsx', ({ default: AgileGuidePage }, { setLang, t }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const html = renderToStaticMarkup(React.createElement(AgileGuidePage));
      assert.equal(html.match(/<h1\b/g)?.length, 1, lang);
      assert.ok(html.includes(t('agileGuide.heading')), lang);
      assert.equal(html.match(/<h2\b/g)?.length, SECTION_COUNT + 1, `${lang}: sections + more`);
      assert.match(html, /<a class="rb-landing__identity" href="\/agile-scrum">/);
      const navTargets = [...html.matchAll(/<a href="#([^"]+)">/g)].map((match) => match[1]);
      assert.equal(navTargets.length, 3);
      for (const target of navTargets) assert.match(html, new RegExp(`id="${target}"`), `#${target}`);
      assert.match(html, /<a class="rb-btn rb-btn--primary rb-btn--pill" href="\/">/, 'start a retro board');
      assert.match(html, /href="\/planning-poker"/);
      assert.doesNotMatch(html, /<a href="\/agile-scrum">/, 'no link to itself in More');
    }
    setLang('th');
    assert.match(renderToStaticMarkup(React.createElement(AgileGuidePage)), new RegExp(`<h1[^>]*>[^<]*${THAI_TEXT.source}`));
    setLang('en');
  });
});

test('tables carry column and row headers and the sources are real links', async () => {
  await withChromeModule('/src/client/guide/AgileGuidePage.jsx', ({ default: AgileGuidePage }) => {
    const html = renderToStaticMarkup(React.createElement(AgileGuidePage));
    const tables = html.match(/<table>[\s\S]*?<\/table>/g);
    assert.equal(tables.length, 7);
    for (const table of tables) {
      assert.match(table, /<thead><tr><th scope="col">/);
      assert.match(table, /<tbody><tr><th scope="row">/);
    }
    for (const href of ['https://scrumguides.org/scrum-guide.html', 'https://agilemanifesto.org/', 'https://agilemanifesto.org/principles.html']) {
      assert.ok(html.includes(`<a href="${href}">`), href);
    }
    assert.match(html, /<a href="\/templates\/start-stop-continue">/);
  });
});
