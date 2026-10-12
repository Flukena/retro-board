import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';
import { TOKENS } from './theme.js';
import { ZONE_HEADER_ICONS_BREAKPOINT_PX } from './zone-title.js';

const ITEM = { id: 'zone-a', title: 'Ideas', x: 10, y: 20, w: 300, h: 200, color: 0 };
function Editor({ value, className }) {
  return React.createElement('input', { value, className, readOnly: true });
}
function cardTree(ZoneCard, props = {}) {
  return ZoneCard.type({ item: ITEM, childCount: 3, TextEditor: Editor, ...props });
}
function header(tree) { return tree.props.children[0]; }
function chip(tree) { return header(tree).props.children[0]; }

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
          assert.equal((html.match(/<button/g) || []).length, 1);
        }
      }
    } finally { setLang(previous); }
  });
});

test('lock icon is present only for locked zones', async () => {
  await withChromeModule('/src/ZoneCard.jsx', ({ ZoneCard }) => {
    for (const locked of [false, true]) {
      const html = renderToStaticMarkup(cardTree(ZoneCard, { item: { ...ITEM, locked } }));
      assert.equal(html.includes('rb-zone__lock'), locked);
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

test('chip dispatches drag except while editing and double click begins title focus', async () => {
  await withChromeModule('/src/ZoneCard.jsx', ({ ZoneCard }) => {
    for (const [isEditingTitle, locked, cursor] of [[false, false, 'grab'], [false, true, 'not-allowed'], [true, false, 'text']]) {
      const item = { ...ITEM, locked };
      const calls = [];
      const row = chip(cardTree(ZoneCard, {
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

test('header is inside the unchanged body for default and large titles', async () => {
  await withChromeModule('/src/ZoneCard.jsx', ({ ZoneCard }) => {
    for (const fontSize of [undefined, 10, 16, 24, 48, 96]) {
      const item = { ...ITEM, fontSize };
      const tree = cardTree(ZoneCard, { item });
      assert.equal(header(tree).props.style.fontSize, fontSize || 16);
      assert.equal(header(tree).props.style.top, undefined);
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
  assert.equal(row.transform, 'scale(calc(1 / var(--rb-zoom)))');
  assert.equal(row['transform-origin'], 'top left');
  assert.equal(row['z-index'], 'var(--z-zone-header)');
  assert.equal(row['pointer-events'], 'none');
  assert.equal(body.animation, undefined);
  assert.equal(declarations(css, '.rb-zone__surface').animation, 'rb-appear 0.28s ease-out');
  assert.equal(tab['pointer-events'], 'auto');
  assert.equal(row['align-items'], 'flex-start');
  assert.equal(row['box-sizing'], 'border-box');
  assert.equal(tab.background, 'var(--rb-zone-bg)');
  assert.equal(tab.color, 'var(--rb-zone-ink)');
  assert.equal(tab.padding, 'var(--zone-chip-padding)');
  assert.equal(tab['border-radius'], 'var(--radius-zone-chip)');
  assert.equal(tab['box-shadow'], 'var(--zone-title-shadow)');
  assert.equal(tab['font-family'], 'var(--font-display)');
  assert.equal(tab['font-weight'], 'var(--zone-title-font-weight)');
  assert.equal(tab['line-height'], 'var(--zone-title-line-height)');
  const editor = declarations(css, '.rb-zone__editor');
  assert.equal(editor['line-height'], 'inherit');
  assert.equal(editor.padding, '0');
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
    assert.equal(tokens['--zone-chip-padding'], '6px 14px');
    assert.equal(tokens['--radius-zone-chip'], '12px');
    assert.equal(tokens['--zone-title-font-weight'], '500');
    assert.equal(tokens['--zone-count-font-size'], '11px');
  }
});

function assertAdminIcons(ZoneCard, language, revealed) {
  const calls = [];
  const tree = cardTree(ZoneCard, { isAdmin: true, revealed, hasVoteTimer: true,
    onStartZoneDrag: () => calls.push('drag'), onBeginFocus: () => calls.push('focus'),
    onToggleReveal: (id) => calls.push(id), onVote: (id) => calls.push(id), onOptions: (id) => calls.push(id) });
  const buttons = header(tree).props.children[1].props.children.filter(Boolean);
  assert.equal(buttons.length, 3);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /lucide-square/);
  const optionsLabel = language === 'th' ? 'ตัวเลือกโซน' : 'Zone options';
  const revealLabels = language === 'th' ? ['เปิดการ์ด', 'ซ่อนการ์ด'] : ['Reveal cards', 'Hide cards'];
  assert.ok(html.includes(optionsLabel));
  assert.ok(html.includes(revealLabels[Number(revealed)]));
  for (const button of buttons) {
    const event = { stopPropagation: () => calls.push('stop') };
    button.props.onMouseDown(event);
    button.props.onDoubleClick(event);
    button.props.onClick(event);
  }
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ['stop', 'stop', 'stop', ITEM.id]).flat());
}

test('admin icons have localized labels, own timer state and isolated events', async () => {
  await withChromeModule('/src/ZoneCard.jsx', ({ ZoneCard }, { getLang, setLang }) => {
    const previous = getLang();
    try {
      for (const language of ['th', 'en']) {
        setLang(language);
        for (const revealed of [false, true]) assertAdminIcons(ZoneCard, language, revealed);
      }
      const html = renderToStaticMarkup(cardTree(ZoneCard, { isAdmin: true }));
      assert.match(html, /lucide-thumbs-up/);
    } finally { setLang(previous); }
  });
});

test('header width, inset, icon sizing and narrow breakpoint use screen coordinates', () => {
  const css = readFileSync(new URL('./board-cards.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const row = declarations(css, '.rb-zone__title');
  assert.equal(row.left, 'calc(var(--zone-header-inset) / var(--rb-zoom) - var(--rb-zone-border-w))');
  assert.equal(row.top, 'calc(var(--zone-header-inset) / var(--rb-zoom) - var(--rb-zone-border-w))');
  assert.equal(row.width, 'max(0px, calc(var(--rb-zone-width) * var(--rb-zoom) - 2 * var(--zone-header-inset)))');
  assert.equal(row['container-type'], 'inline-size');
  assert.equal(row['overflow-x'], 'clip');
  assert.ok(css.includes(`@container rb-zone-header (max-width: ${ZONE_HEADER_ICONS_BREAKPOINT_PX}px)`));
  const button = declarations(css, '.rb-zone__icon');
  assert.equal(button['pointer-events'], 'auto');
  assert.equal(button.color, 'var(--text-muted)');
  for (const tokens of Object.values(TOKENS)) {
    for (const [key, value] of Object.entries({ '--zone-header-inset': '14px', '--zone-title-line-height': '1.35',
      '--zone-icon-button-size': '26px', '--zone-icon-size': '14px', '--zone-icon-gap': '2px',
      '--radius-zone-icon': '10px', '--z-zone-header': '4' })) assert.equal(tokens[key], value);
  }
});
