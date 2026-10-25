import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync } from 'node:fs';
import { TOKENS } from '../ui/theme.js';
import { Z } from './chrome-layout.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('ToolDock preserves presentation and event contracts', async () => {
  await withChromeModule('/src/client/chrome/ToolDock.jsx', async ({ ToolDock, ToolTile, TOOL_ID }) => {
    const props = { creationMode: 'zone', templatesOpen: false, rows: { builtin: [], custom: [] } };
    const markup = renderToStaticMarkup(React.createElement(ToolDock, props));
    assert.match(markup, /data-tool="zone"[^>]*aria-pressed="true"/);
    assert.doesNotMatch(markup, /data-board-shortcuts/);
    const open = renderToStaticMarkup(React.createElement(ToolDock, { ...props, templatesOpen: true }));
    assert.match(open, /data-board-shortcuts="off"/);
    const received = [];
    for (const toolId of Object.values(TOOL_ID)) {
      const tile = ToolTile({ toolId, active: false, onTool: (id) => received.push(id) });
      tile.props.onClick();
    }
    assert.deepEqual(received, Object.values(TOOL_ID));
    assert.ok(Object.isFrozen(TOOL_ID));
  });
});

test('template save menu requires selected zones and explains the disabled state in both languages', async () => {
  await withChromeModule('/src/client/chrome/ToolDock.jsx', ({ TemplatePopover }, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      for (const selectedZoneCount of [0, 1]) {
        let saves = 0;
        const popover = TemplatePopover({ rows: { builtin: [], custom: [] }, selectedZoneCount,
          onSaveTemplate: () => { saves += 1; } });
        const children = popover.props.children[1].props.children;
        const save = children.find((child) => child?.props?.label === t('tmpl.saveSelection'));
        assert.equal(save.props.disabled, selectedZoneCount === 0);
        if (selectedZoneCount) save.props.onClick();
        assert.equal(saves, selectedZoneCount);
        const markup = renderToStaticMarkup(popover);
        assert.ok(markup.includes(t('tmpl.saveSelection')));
        assert.equal(markup.includes(t('tmpl.selectZonesHint')), selectedZoneCount === 0);
        assert.notEqual(t('tmpl.selectZonesHint'), 'tmpl.selectZonesHint');
      }
    }
  });
});


test('each template row has a thumbnail; custom rename emits its id with localized accessible labels', async () => {
  await withChromeModule('/src/client/chrome/ToolDock.jsx', ({ TemplatePopover }, { t, setLang }) => {
    const zones = [{ x: 0, y: 0, w: 100, h: 80, color: 2 }];
    const rows = { builtin: [{ id: 'loop', name: 'Loop', zones }],
      custom: [{ id: 'mine', name: 'Mine', zones, zoneCount: 1 }] };
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const renamed = [];
      const tree = TemplatePopover({ rows, onRenameCustomTemplate: (id) => renamed.push(id) });
      const html = renderToStaticMarkup(tree);
      assert.equal((html.match(/class="rb-template-thumbnail"/g) || []).length, 2);
      const buttons = tree.props.children[1].props.children[3][0].props.children;
      const rename = buttons.find((child) => child.props['aria-label'] === t('tmpl.rename'));
      assert.ok(rename);
      assert.equal(rename.props.title, t('tmpl.rename'));
      assert.notEqual(t('tmpl.rename'), 'tmpl.rename');
      rename.props.onClick();
      assert.deepEqual(renamed, ['mine']);
      assert.ok(html.includes(`aria-label="${t('tmpl.rename')}"`));
    }
  });
});

const dockButton = (markup, toolId) => markup.match(new RegExp(`<button[^>]*data-tool="${toolId}"[^>]*>[\\s\\S]*?</button>`))?.[0];

test('Select is pressed at rest with its normal label and icon; creation tools retain placeholder semantics', async () => {
  await withChromeModule('/src/client/chrome/ToolDock.jsx', ({ ToolDock, TOOL_ID }, { t, getLang, setLang }) => {
    const originalLang = getLang();
    try {
      for (const language of ['th', 'en']) {
        setLang(language);
        const resting = renderToStaticMarkup(React.createElement(ToolDock, { creationMode: null }));
        const select = dockButton(resting, TOOL_ID.SELECT);
        assert.match(select, /aria-pressed="true"/);
        assert.ok(select.includes(`>${t('tool.select')}</span>`));
        assert.ok(select.includes(`title="${t('tool.select.title')}"`));
        assert.match(select, /lucide-mouse-pointer2/);
        const selecting = renderToStaticMarkup(React.createElement(ToolDock, { creationMode: TOOL_ID.SELECT }));
        const explicitSelect = dockButton(selecting, TOOL_ID.SELECT);
        assert.match(explicitSelect, /aria-pressed="true"/);
        assert.ok(explicitSelect.includes(`>${t('tool.select')}</span>`));
        assert.ok(explicitSelect.includes(`title="${t('tool.select.title')}"`));
        for (const toolId of [TOOL_ID.TEXT, TOOL_ID.ZONE, TOOL_ID.IMAGE]) {
          assert.match(dockButton(resting, toolId), /aria-pressed="false"/);
          const creating = renderToStaticMarkup(React.createElement(ToolDock, { creationMode: toolId }));
          assert.match(dockButton(creating, TOOL_ID.SELECT), /aria-pressed="false"/);
          const active = dockButton(creating, toolId);
          assert.match(active, /aria-pressed="true"/);
          assert.ok(active.includes(t(`tool.${toolId}.placeholder`)));
          assert.match(active, /lucide-mouse-pointer2/);
        }
      }
    } finally {
      setLang(originalLang);
    }
  });
});

test('Templates places a decorative chevron after its label and reflects popover state', async () => {
  await withChromeModule('/src/client/chrome/ToolDock.jsx', ({ ToolDock }) => {
    for (const templatesOpen of [false, true]) {
      const markup = renderToStaticMarkup(React.createElement(ToolDock, {
        creationMode: null, templatesOpen, rows: { builtin: [], custom: [] },
      }));
      const templates = dockButton(markup, 'templates');
      assert.match(templates, new RegExp(`aria-expanded="${templatesOpen}"`));
      assert.match(templates, /<span[^>]*>[^<]+<svg[^>]*lucide-chevron-down[^>]*aria-hidden="true"/);
      assert.match(templates, /width="14" height="14"/);
    }
  });
});

test('dock tiles reserve the design border and radius and use theme colors when pressed', () => {
  const css = readFileSync(new URL('./tool-dock.css', import.meta.url), 'utf8');
  assert.match(css, /border: var\(--rb-chrome-border\) solid transparent;/);
  assert.match(css, /border-radius: var\(--radius-dock-tile\);/);
  assert.match(css, /\.rb-dock-tile\[aria-pressed="true"\]\s*\{\s*border-color: var\(--border\);/);
  assert.match(css, /\.rb-dock-tile\[aria-pressed="true"\]\s*\{\s*background: var\(--bg-panel-2\);\s*color: var\(--text\);/);
  for (const tokens of Object.values(TOKENS)) {
    assert.equal(tokens['--radius-dock-tile'], '14px');
  }
});

test('open templates raise the whole fixed rail above zoom and header while closed tools retain dock order', async () => {
  await withChromeModule('/src/client/chrome/ToolDock.jsx', ({ ToolDock }) => {
    const closed = ToolDock({ templatesOpen: false });
    const opened = ToolDock({ templatesOpen: true, rows: { builtin: [], custom: [] } });
    assert.equal(closed.props.style.zIndex, Z.DOCK);
    assert.equal(opened.props.style.zIndex, Z.POPOVER);
    assert.ok(opened.props.style.zIndex > Z.TOPBAR);
    assert.ok(opened.props.style.zIndex > closed.props.style.zIndex);
  });
});
