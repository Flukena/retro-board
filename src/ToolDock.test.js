import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';

test('ToolDock preserves presentation and event contracts', async () => {
  await withChromeModule('/src/ToolDock.jsx', async ({ ToolDock, ToolTile, TOOL_ID }) => {
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
  await withChromeModule('/src/ToolDock.jsx', ({ TemplatePopover }, { t, setLang }) => {
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
  await withChromeModule('/src/ToolDock.jsx', ({ TemplatePopover }, { t, setLang }) => {
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
