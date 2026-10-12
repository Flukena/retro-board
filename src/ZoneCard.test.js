import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';
import { TOKENS } from './theme.js';

const ITEM = { id: 'zone-a', title: 'Ideas', x: 10, y: 20, w: 300, h: 200, color: 0 };
const LARGE_TITLE_FONT_SIZE_PX = 64;
function Editor({ value, className }) {
  return React.createElement('input', { value, className, readOnly: true });
}
function cardTree(ZoneCard, props = {}) {
  return ZoneCard.type({ item: ITEM, childCount: 3, TextEditor: Editor, ...props });
}
function header(tree) { return tree.props.children[0]; }
function chip(tree) { return header(tree).props.children; }

test('chip contains title and localized count for one and three cards in both languages', async () => {
  await withChromeModule('/src/ZoneCard.jsx', ({ ZoneCard }, { getLang, setLang }) => {
    const previous = getLang();
    try {
      for (const [language, counts] of [['th', ['1 การ์ด', '3 การ์ด']], ['en', ['1 card', '3 cards']]]) {
        setLang(language);
        for (const [index, childCount] of [1, 3].entries()) {
          const tree = cardTree(ZoneCard, { childCount, lang: language });
          const html = renderToStaticMarkup(tree);
          assert.match(html, /rb-zone__chip/);
          assert.ok(html.includes('Ideas'));
          assert.ok(html.includes(counts[index]));
          assert.doesNotMatch(html, /<button/);
        }
      }
    } finally { setLang(previous); }
  });
});

test('lock icon is present only for locked zones', async () => {
  await withChromeModule('/src/ZoneCard.jsx', ({ ZoneCard }) => {
    for (const locked of [false, true]) {
      const html = renderToStaticMarkup(cardTree(ZoneCard, { item: { ...ITEM, locked } }));
      assert.equal(html.includes('<svg'), locked);
    }
  });
});

test('editing shows the editor without the label and preserves all edit events', async () => {
  await withChromeModule('/src/ZoneCard.jsx', ({ ZoneCard }) => {
    const events = [];
    const editorRef = { current: null };
    const tree = cardTree(ZoneCard, {
      isEditingTitle: true, editAreaRef: editorRef,
      onTextChange: (...args) => events.push(args),
      onTextKeyDown: (...args) => events.push(args),
      onTextBlur: (...args) => events.push(args),
    });
    const html = renderToStaticMarkup(tree);
    assert.match(html, /<input/);
    assert.doesNotMatch(html, /rb-zone__label/);
    const editor = chip(tree).props.children;
    assert.equal(editor.type, Editor);
    assert.equal(editor.props.editorRef, editorRef);
    assert.equal(editor.props.kind, 'input');
    editor.props.onValueChange('Updated');
    const keyEvent = { key: 'Enter' };
    editor.props.onKeyDown(keyEvent);
    editor.props.onBlur();
    let stopped = false;
    editor.props.onMouseDown({ stopPropagation: () => { stopped = true; } });
    assert.ok(stopped);
    assert.deepEqual(events, [[ITEM.id, { title: 'Updated' }], [keyEvent, { singleLine: true }], [ITEM.id]]);
  });
});

test('whole header dispatches drag except while editing and double click begins title focus', async () => {
  await withChromeModule('/src/ZoneCard.jsx', ({ ZoneCard }) => {
    for (const [isEditingTitle, locked, cursor] of [[false, false, 'grab'], [false, true, 'not-allowed'], [true, false, 'text']]) {
      const item = { ...ITEM, locked };
      const calls = [];
      const row = header(cardTree(ZoneCard, {
        item, isEditingTitle,
        onStartZoneDrag: (...args) => calls.push(['drag', ...args]),
        onBeginFocus: (...args) => calls.push(['focus', ...args]),
      }));
      const event = { stopPropagation: () => calls.push(['stop']) };
      row.props.onMouseDown(event);
      assert.deepEqual(calls, isEditingTitle ? [] : [['drag', event, item]]);
      calls.length = 0;
      row.props.onDoubleClick(event);
      assert.deepEqual(calls, [['stop'], ['focus', item, 'title']]);
      assert.equal(row.props.style.cursor, cursor);
    }
  });
});

test('header geometry remains directly above the unchanged body for default and large titles', async () => {
  await withChromeModule('/src/ZoneCard.jsx', ({ ZoneCard }) => {
    for (const [fontSize, height] of [[undefined, 40], [LARGE_TITLE_FONT_SIZE_PX, 82]]) {
      const tree = cardTree(ZoneCard, { item: { ...ITEM, fontSize } });
      assert.equal(header(tree).props.style.top, -height);
      assert.equal(header(tree).props.style.height, height);
      for (const [field, expected] of [['left', ITEM.x], ['top', ITEM.y], ['width', ITEM.w], ['height', ITEM.h]]) {
        assert.equal(tree.props.style[field], expected);
      }
    }
  });
});

function declarations(css, selector) {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => match[1].trim() === selector);
  assert.equal(rules.length, 1, selector + ' must have one authoritative rule');
  return Object.fromEntries(rules[0][2].split(';').filter((entry) => entry.includes(':')).map((entry) => {
    const separator = entry.indexOf(':');
    return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
  }));
}

test('tab appearance uses tokens, an auto-width chip and a fully rounded body', () => {
  const css = readFileSync(new URL('./board-cards.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const row = declarations(css, '.rb-zone__title');
  const tab = declarations(css, '.rb-zone__chip');
  const body = declarations(css, '.rb-zone');
  const label = declarations(css, '.rb-zone__label');
  const count = declarations(css, '.rb-zone__count');
  assert.equal(row.background, 'transparent');
  assert.equal(row.padding, 'var(--zone-header-padding)');
  assert.equal(row['align-items'], 'flex-end');
  assert.equal(row['box-sizing'], 'border-box');
  assert.equal(tab.background, 'var(--rb-zone-bg)');
  assert.equal(tab.color, 'var(--rb-zone-ink)');
  assert.equal(tab.padding, 'var(--zone-chip-padding)');
  assert.equal(tab['border-radius'], 'var(--radius-zone-chip)');
  assert.equal(tab['box-shadow'], 'var(--zone-title-shadow)');
  assert.equal(tab['font-family'], 'var(--font-display)');
  assert.equal(tab['font-weight'], 'var(--zone-title-font-weight)');
  assert.equal(tab['max-width'], '100%');
  assert.equal(tab['box-sizing'], 'border-box');
  assert.equal(tab['flex-shrink'], '1');
  assert.equal(label['min-width'], '0');
  assert.equal(label['text-overflow'], 'ellipsis');
  assert.equal(body['border-radius'], 'var(--radius-zone)');
  assert.equal(count.background, undefined);
  assert.equal(count['font-size'], 'var(--zone-count-font-size)');
  assert.equal(count.color, 'inherit');
  for (const tokens of Object.values(TOKENS)) {
    assert.equal(tokens['--zone-header-padding'], '0 14px 6px');
    assert.equal(tokens['--zone-chip-padding'], '6px 14px');
    assert.equal(tokens['--radius-zone-chip'], '12px');
    assert.equal(tokens['--zone-title-font-weight'], '500');
    assert.equal(tokens['--zone-count-font-size'], '0.6875em');
  }
});
