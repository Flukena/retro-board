import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('public chrome exposes shared board tools while keeping ownership and admin transfer private', async () => {
  await withChromeModule('/src/client/chrome/TopBar.jsx', async ({ TopBar }, { t, setLang }) => {
    for (const lang of ['en', 'th']) {
      setLang(lang);
      const markup = renderToStaticMarkup(React.createElement(TopBar, {
        mode: 'public', canUndo: true, players: [], themePref: 'auto', lang,
        isAdmin: true, canClaim: true, admin: { name: 'must hide', isOnline: true },
      }));
      assert.equal(markup.includes('must hide'), false);
      assert.equal(markup.includes(t('topbar.lockEdit')), false);
      assert.equal(markup.includes(t('admin.claim.title')), false);
      assert.equal(markup.includes(t('topbar.undo')), true);
    }
  });
  await withChromeModule('/src/client/chrome/TopBarPopovers.jsx', ({ MorePopover }, { t }) => {
    const markup = renderToStaticMarkup(React.createElement(MorePopover, { mode: 'public', isAdmin: true }));
    for (const key of ['topbar.import', 'topbar.clear', 'topbar.unlockAll', 'topbar.resetVotes']) {
      assert.equal(markup.includes(t(key)), true, key);
    }
    assert.equal(markup.includes(t('topbar.transfer')), false);
  });
  await withChromeModule('/src/client/chrome/ToolDock.jsx', ({ ToolDock }) => {
    const markup = renderToStaticMarkup(React.createElement(ToolDock, { mode: 'public', rows: { builtin: [], custom: [] } }));
    assert.match(markup, /data-tool="image"/);
    assert.match(markup, /data-tool="zone"/);
    assert.match(markup, /data-tool="text"/);
  });
  await withChromeModule('/src/client/board/ZoneCard.jsx', ({ ZoneHeader }, { t }) => {
    const markup = renderToStaticMarkup(React.createElement(ZoneHeader, {
      mode: 'public', item: { id: 'zone' }, isAdmin: true, actions: {}, menuOpen: true, canEdit: true,
    }));
    assert.equal(markup.includes(t('zone.lockToggle.on')), true);
    assert.equal(markup.includes(t('zone.startVote')), true);
  });
});

test('board-wide editing lock controls exist only in private rooms in both languages', async () => {
  await withChromeModule('/src/client/chrome/TopBar.jsx', ({ TopBar }, { t, setLang }) => {
    for (const lang of ['en', 'th']) {
      setLang(lang);
      for (const editingLocked of [false, true]) {
        for (const isAdmin of [false, true]) {
          for (const mode of ['public', 'private']) {
            const markup = renderToStaticMarkup(React.createElement(TopBar, {
              mode, editingLocked, isAdmin, players: [], themePref: 'auto', lang,
            }));
            const label = t(editingLocked ? 'topbar.unlockEdit' : 'topbar.lockEdit');
            assert.equal(markup.includes(label), mode === 'private', `${mode}: ${lang}, lock=${editingLocked}, admin=${isAdmin}`);
            if (mode === 'public') assert.doesNotMatch(markup, /lucide-(?:lock|unlock)/);
          }
        }
      }
    }
  });
});

test('public dock exposes templates and its open menu in both languages', async () => {
  await withChromeModule('/src/client/chrome/ToolDock.jsx', ({ ToolDock }, { t, setLang }) => {
    for (const lang of ['en', 'th']) {
      setLang(lang);
      const markup = renderToStaticMarkup(React.createElement(ToolDock, {
        mode: 'public', templatesOpen: true, rows: { builtin: [], custom: [] },
      }));
      assert.match(markup, /data-tool="templates"/);
      assert.equal(markup.includes(t('tmpl.builtin')), true);
      assert.equal(markup.includes(t('tmpl.saveSelection')), true);
      assert.match(markup, /data-tool="image"/);
    }
  });
});

test('public zone and group toolbars expose saving templates in both languages', async () => {
  await withChromeModule('/src/client/board/SelectionToolbar.jsx', ({ GroupSelectionToolbar }, { t, setLang }) => {
    for (const lang of ['en', 'th']) {
      setLang(lang);
      const markup = renderToStaticMarkup(React.createElement(GroupSelectionToolbar, {
        mode: 'public', anchor: { x: 0, y: 0 }, zoneCount: 1, lockedCount: 0,
      }));
      assert.equal(markup.includes(t('selection.saveTemplate')), true);
      assert.equal(markup.includes(t('selection.nothingLocked')), true);
    }
  });
  await withChromeModule('/src/client/board/ZoneToolStrip.jsx', ({ ZoneToolStrip, ZoneToolPopup }, { t, setLang }) => {
    for (const lang of ['en', 'th']) {
      setLang(lang);
      for (const Component of [ZoneToolStrip, ZoneToolPopup]) {
        const markup = renderToStaticMarkup(React.createElement(Component, {
          mode: 'public', item: { id: 'public-zone', type: 'zone' }, actions: {}, canEdit: true,
        }));
        assert.equal(markup.includes(t('selection.saveTemplate')), true);
        assert.equal(markup.includes(t('zone.lockToggle.on')), true);
      }
    }
  });
});
