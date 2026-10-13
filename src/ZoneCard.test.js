import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';
import { TOKENS } from './theme.js';
import { ZONE_HEADER_MENU_BREAKPOINT_PX } from './zone-title.js';

const AUTO_ITEM_TITLE_FONT_PX = 20;

const ITEM = { id: 'zone-a', type: 'zone', title: 'Ideas', x: 10, y: 20, w: 300, h: 200, color: 0 };
function Editor({ value, className }) {
  return React.createElement('input', { value, className, readOnly: true });
}
function cardTree(ZoneCard, props = {}) {
  let tree;
  function InspectCard() { tree = ZoneCard.type({ item: ITEM, childCount: 3, TextEditor: Editor, ...props }); return tree; }
  renderToStaticMarkup(React.createElement(InspectCard));
  return tree;
}
function header(tree) { return tree.props.children[0]; }
function chip(tree) { return header(tree).props.children[0]; }

test('four zone edges dispatch the chip drag action and stop double click without title focus', async () => {
  await withChromeModule('/src/ZoneCard.jsx', ({ ZoneCard }) => {
    for (const locked of [false, true]) {
      const item = { ...ITEM, locked };
      const calls = [];
      const tree = cardTree(ZoneCard, {
        item,
        onStartZoneDrag: (...args) => calls.push(['drag', ...args]),
        onBeginFocus: (...args) => calls.push(['focus', ...args]),
      });
      const edges = React.Children.toArray(tree.props.children)
        .filter((child) => child.props.className?.split(' ').includes('rb-zone__edge'));
      assert.deepEqual(edges.map((edge) => edge.props['data-edge']).sort(), ['bottom', 'left', 'right', 'top']);
      assert.equal((renderToStaticMarkup(tree).match(/class="rb-zone__edge"/g) || []).length, edges.length);
      for (const edge of edges) {
        assert.equal(edge.props['data-locked'], locked);
        const event = { stopPropagation: () => calls.push(['stop']) };
        edge.props.onMouseDown(event);
        assert.deepEqual(calls, [['drag', event, item]]);
        calls.length = 0;
        edge.props.onDoubleClick(event);
        assert.deepEqual(calls, [['stop']]);
        calls.length = 0;
      }
    }
  });
});

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
      assert.equal(header(tree).props.style.fontSize, fontSize ?? AUTO_ITEM_TITLE_FONT_PX);
      assert.equal(header(tree).props.style['--rb-zone-title-size'], `${fontSize ?? AUTO_ITEM_TITLE_FONT_PX}px`);
      assert.equal(header(tree).props.style['--zone-icon-size'], TOKENS.light['--zone-icon-size']);
      assert.equal(header(tree).props.style.top, undefined);
      for (const [field, expected] of [['left', ITEM.x], ['top', ITEM.y], ['width', ITEM.w], ['height', ITEM.h]]) {
        assert.equal(tree.props.style[field], expected);
      }
    }
  });
});

test('auto headers bind scaling tokens locally for each effective title size', async () => {
  await withChromeModule('/src/ZoneCard.jsx', ({ ZoneCard }) => {
    for (const [w, h, expectedFontPx] of [[300, 400, 20], [600, 400, 24], [960, 220, 22], [960, 400, 32]]) {
      const style = header(cardTree(ZoneCard, { item: { ...ITEM, w, h } })).props.style;
      assert.equal(style.fontSize, expectedFontPx);
      assert.equal(style['--rb-zone-title-size'], `${expectedFontPx}px`);
      for (const key of ['--zone-icon-button-size', '--zone-icon-size', '--zone-strip-swatch-size',
        '--zone-font-value-width', '--zone-icon-gap', '--zone-chip-min-width', '--zone-chip-gap']) {
        assert.equal(style[key], TOKENS.light[key]);
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

test('zone edges form a hollow world-space band with pass-through interior and unchanged stacking', () => {
  const css = readFileSync(new URL('./board-cards.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const edge = declarations(css, '.rb-zone__edge');
  assert.equal(edge.position, 'absolute');
  assert.equal(edge['pointer-events'], 'auto');
  assert.equal(edge.cursor, 'grab');
  assert.equal(declarations(css, '.rb-zone__edge[data-locked="true"]').cursor, 'not-allowed');
  // Absolute children originate inside the transparent body border. Subtract
  // that border and half the hit width to reach 8px outside the zone geometry.
  for (const tokens of Object.values(TOKENS)) {
    assert.equal(tokens['--zone-edge-hit-offset'], 'calc(-1 * (2px + var(--zone-edge-hit-width) / 2))');
  }
  const horizontal = declarations(css, '.rb-zone__edge[data-edge="top"],\n.rb-zone__edge[data-edge="bottom"]');
  const vertical = declarations(css, '.rb-zone__edge[data-edge="left"],\n.rb-zone__edge[data-edge="right"]');
  assert.equal(horizontal.height, 'var(--zone-edge-hit-width)');
  assert.equal(horizontal.width, undefined);
  assert.equal(vertical.width, 'var(--zone-edge-hit-width)');
  assert.equal(vertical.height, undefined);
  for (const side of ['left', 'right']) assert.equal(horizontal[side], 'var(--zone-edge-hit-offset)');
  for (const side of ['top', 'bottom']) assert.equal(vertical[side], 'var(--zone-edge-hit-offset)');
  for (const side of ['top', 'bottom', 'left', 'right']) {
    assert.equal(declarations(css, `.rb-zone__edge[data-edge="${side}"]`)[side], 'var(--zone-edge-hit-offset)');
  }
  for (const rule of [edge, horizontal, vertical]) {
    for (const property of ['z-index', 'background', 'border', 'box-shadow', 'inset']) assert.equal(rule[property], undefined);
    assert.doesNotMatch(Object.values(rule).join(' '), /--rb-zoom\b/);
  }
  assert.equal(declarations(css, '.rb-zone')['pointer-events'], 'none');
  assert.equal(declarations(css, '.rb-zone__surface')['pointer-events'], 'none');
  assert.equal(declarations(css, '.rb-zone__title')['z-index'], 'var(--z-zone-header)');
});

test('tab appearance uses tokens, an auto-width chip and a fully rounded body', () => {
  const css = readFileSync(new URL('./board-cards.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const row = declarations(css, '.rb-zone__title');
  const tab = declarations(css, '.rb-zone__chip');
  const body = declarations(css, '.rb-zone');
  const label = declarations(css, '.rb-zone__label');
  const count = declarations(css, '.rb-zone__count');
  assert.equal(row.background, 'transparent');
  assert.equal(row.transform, undefined);
  assert.equal(row['transform-origin'], undefined);
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

test('zone header owns its local menu, admin icons and timer setup in th/en', async () => {
  await withChromeModule('/src/ZoneCard.jsx', ({ ZoneHeader }, { setLang, t }) => {
    for (const language of ['th', 'en']) {
      setLang(language);
      for (const menuOpen of [false, true]) {
        const html = renderToStaticMarkup(React.createElement(ZoneHeader, {
          item: ITEM, menuOpen, isAdmin: false, canEdit: false, canDelete: false, actions: {},
        }));
        assert.ok(html.includes(`aria-expanded="${menuOpen}"`));
        assert.equal(html.includes('rb-zone__tool-strip'), menuOpen);
        assert.ok(html.includes(t(menuOpen ? 'zone.closeOptions' : 'zone.options')));
        assert.equal(html.includes('rb-zone__tool-popup'), menuOpen);
        assert.doesNotMatch(html, /lucide-eye|lucide-thumbs-up|rb-timer-setup/);
      }
      for (const timerSetupOpen of [false, true]) {
        const html = renderToStaticMarkup(React.createElement(ZoneHeader, {
          item: ITEM, isAdmin: true, timerSetupOpen, nestedZoneCount: 2, actions: {},
        }));
        assert.match(html, /lucide-eye-off/);
        assert.match(html, /lucide-thumbs-up/);
        assert.equal(html.includes('rb-timer-setup__header'), timerSetupOpen);
        assert.equal(html.includes('data-board-shortcuts="off"'), timerSetupOpen);
      }
    }
  });
});

test('header width, inset, icon sizing and narrow breakpoints use world coordinates', () => {
  const css = readFileSync(new URL('./board-cards.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const row = declarations(css, '.rb-zone__title');
  assert.doesNotMatch(Object.values(row).join(' '), /--rb-zoom\b/);
  assert.equal(row.left, 'calc(var(--zone-header-inset) - var(--rb-zone-border-w))');
  assert.equal(row.top, 'calc(var(--zone-header-inset) - var(--rb-zone-border-w))');
  assert.equal(row.width, 'max(0px, calc(var(--rb-zone-width) - 2 * var(--zone-header-inset)))');
  assert.equal(row['container-type'], 'inline-size');
  assert.equal(row['overflow-x'], undefined);
  assert.ok(css.includes(`@container rb-zone-header (max-width: ${ZONE_HEADER_MENU_BREAKPOINT_PX}px)`));
  assert.match(css, /\.rb-zone__actions\s*\{[^}]*flex-wrap: nowrap;[^}]*justify-content: flex-end;/);
  const button = declarations(css, '.rb-zone__icon');
  assert.equal(button['pointer-events'], 'auto');
  assert.equal(button.color, 'var(--text-muted)');
  for (const tokens of Object.values(TOKENS)) {
    for (const [key, value] of Object.entries({ '--zone-header-inset': '14px', '--zone-title-line-height': '1.35',
      '--zone-icon-button-size': 'calc(var(--rb-zone-title-size) * 1.125)',
      '--zone-icon-size': 'calc(var(--rb-zone-title-size) * 0.75)',
      '--zone-icon-gap': 'calc(var(--rb-zone-title-size) * 0.0625)',
      '--radius-zone-icon': '10px', '--z-zone-header': '4' })) assert.equal(tokens[key], value);
  }
});

test('zone header keeps inline tools on one row without a panel', () => {
  const css = readFileSync(new URL('./board-cards.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const strip = declarations(css, '.rb-zone__tool-strip');
  assert.equal(strip['flex-wrap'], 'nowrap');
  assert.equal(strip['max-width'], '100%');
  assert.equal(strip['box-sizing'], 'border-box');
  assert.equal(strip.display, 'inline-flex');
  assert.equal(strip.gap, 'var(--zone-icon-gap)');
  assert.equal(strip['align-items'], 'center');
  for (const field of ['padding', 'border', 'border-radius', 'background', 'box-shadow']) {
    assert.equal(strip[field], undefined, field + ' must not create a panel');
  }
  const row = declarations(css, '.rb-zone__title');
  const chip = declarations(css, '.rb-zone__chip');
  const actions = declarations(css, '.rb-zone__actions');
  assert.equal(row['flex-wrap'], 'nowrap');
  assert.equal(chip['min-width'], 'min(var(--zone-chip-min-width), 50%)');
  assert.equal(chip['flex-shrink'], '1');
  assert.equal(actions['flex-shrink'], '0');
  assert.equal(actions['max-width'], 'calc(100% - min(var(--zone-chip-min-width), 50%) - var(--zone-chip-gap))');
  // Narrow headers switch to the popup instead of wrapping tools.
  assert.equal(actions['flex-wrap'], 'nowrap');
  assert.equal(actions['justify-content'], 'flex-end');
  assert.equal(actions['margin-left'], 'auto');
  assert.equal(actions['align-items'], 'center');
  assert.equal(declarations(css, '.rb-zone__count')['flex-shrink'], '0');
  const swatches = declarations(css, '.rb-zone__tools .rb-selection-toolbar__swatches');
  assert.equal(swatches['align-items'], 'center');
  assert.equal(swatches.gap, 'var(--zone-icon-gap)');
  const font = declarations(css, '.rb-zone__tools .rb-selection-toolbar__font-size');
  assert.equal(font['border-left'], 'none');
  assert.equal(font['padding-left'], '0');
  assert.equal(font['margin-left'], '0');
  assert.equal(font.gap, 'var(--zone-icon-gap)');
  const button = declarations(css, '.rb-zone__tools .rb-icon-btn');
  assert.equal(button.width, 'var(--zone-icon-button-size)');
  assert.equal(button.height, 'var(--zone-icon-button-size)');
  assert.equal(button.padding, '0');
  assert.equal(button.background, 'transparent');
  assert.equal(button.color, 'var(--text-muted)');
  assert.equal(button['font-size'], 'var(--zone-icon-size)');
  assert.equal(declarations(css, '.rb-zone__tools .rb-icon-btn:hover:not(:disabled)').background, 'var(--zone-icon-hover-bg)');
  const menu = css.match(/@container rb-zone-header \(max-width: 72px\)\s*\{([^}]+)\}/)[1];
  assert.match(menu, /\.rb-zone__menu/);
});

test('header isolates events, closes vote menu and anchors timer at the header right edge', async () => {
  await withChromeModule('/src/ZoneCard.jsx', ({ ZoneHeader }, { t }) => {
    const calls = [];
    const tree = ZoneHeader({ item: ITEM, isAdmin: true, menuOpen: true, timerSetupOpen: true,
      actions: { toggleReveal: (id) => calls.push(['reveal', id]), vote: (id) => calls.push(['vote', id]),
        closeTimerSetup: () => calls.push(['closeTimer']), startTimer: (...args) => calls.push(['start', ...args]) },
      onCloseMenu: () => calls.push(['closeMenu']), onToggleMenu: () => calls.push(['menu']) });
    const event = { stopPropagation: () => calls.push(['stop']) };
    const children = React.Children.toArray(tree.props.children);
    const admin = children.filter((child) => child.props.className === 'rb-zone__admin-action');
    assert.equal(admin.length, 2);
    admin[0].props.children.props.onClick(event);
    admin[1].props.children.props.onClick(event);
    const timer = children.find((child) => child.props.className === 'rb-zone__popover-anchor');
    assert.ok(timer, 'timer must be a direct header child, independent of hidden admin icons');
    timer.props.children.props.onClose();
    timer.props.children.props.onStart(5, 3, true, false);
    const menu = children.find((child) => child.props.className?.includes('rb-zone__menu'));
    assert.equal(menu.props['aria-label'], t('zone.closeOptions'));
    menu.props.onClick(event);
    assert.deepEqual(calls, [['stop'], ['reveal', ITEM.id], ['stop'], ['closeMenu'], ['vote', ITEM.id],
      ['closeTimer'], ['start', ITEM.id, 5, 3, true, false], ['stop'], ['menu']]);
  });
});

test('presence retains both menu structures during exit while the toggle is closed', async () => {
  await withChromeModule('/src/ZoneCard.jsx', ({ ZoneHeader }, { t }) => {
    const html = renderToStaticMarkup(React.createElement(ZoneHeader, {
      item: ITEM, actions: {}, menuOpen: false, presence: { mounted: true, state: 'exit' },
    }));
    assert.ok(html.includes(t('zone.options')));
    assert.match(html, /aria-expanded="false"/);
    assert.equal((html.match(/data-state="exit"/g) || []).length, 2);
    assert.equal((html.match(/inert=""/g) || []).length, 2);
  });
});

test('labelled popup row glyphs retain their compact size', () => {
  const css = readFileSync(new URL('./board-cards.css', import.meta.url), 'utf8');
  const glyph = declarations(css, '.rb-zone__tool-popup .rb-zone__icon svg');
  assert.equal(glyph.width, 'var(--zone-popup-icon-size)');
  assert.equal(glyph.height, 'var(--zone-popup-icon-size)');
  for (const tokens of Object.values(TOKENS)) {
    assert.equal(tokens['--zone-popup-icon-size'], '14px');
  }
});
