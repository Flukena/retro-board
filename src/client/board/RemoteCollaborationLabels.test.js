import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withSsrModule } from '../../test-support/ssr-load.js';

const SUBJECT = '/src/client/board/RemoteCollaborationLabels.jsx';
test('collaboration labels preserve accessible messages, world anchors and inverse zoom in th/en', async () => {
  await withSsrModule(SUBJECT, async ({ RemoteCollaborationLabels }, { load }) => {
    const { setLang, t } = await load('/src/client/ui/i18n.js');
    const selector = { userId: 'peer', name: '<Peer>', extraCount: 0 };
    const item = { id: 'note', type: 'sticky', x: 40, y: 80, w: 200, h: 100 };
    const render = (props) => renderToStaticMarkup(React.createElement(RemoteCollaborationLabels, props));
    for (const lang of ['th', 'en']) {
      await setLang(lang);
      assert.equal(render({ selectionLabels: [], editingIndicators: [], viewport: { zoom: 1 } }), '');
      const html = render({ selectionLabels: [{ key: 'peer', selector, count: 1, x: 40, y: 80 }],
        editingIndicators: [{ item, editor: selector }], viewport: { zoom: 2 } });
      const escaped = (message) => message.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      assert.ok(html.includes(escaped(t('selection.by', { name: '<Peer>' }))));
      assert.ok(html.includes(escaped(t('editing.by', { name: '<Peer>' }))));
      assert.equal((html.match(/role="status"/g) || []).length, 2);
      assert.match(html, /left:40px;top:63px/);
      assert.match(html, /transform:scale\(0.5\)/);
      assert.match(html, /rb-editing-dot/);
      assert.doesNotMatch(html, /<Peer>/);
      const many = render({ selectionLabels: [{ key: 'peer', selector: { ...selector, extraCount: 2 }, count: 3, x: 0, y: 0 }],
        editingIndicators: [{ item, editor: { ...selector, extraCount: 2 } }], viewport: { zoom: 0 } });
      assert.ok(many.includes(escaped(t('editing.byMany', { name: '<Peer>', n: 2 }))));
      assert.ok(many.includes(escaped(t('selection.byMany', { name: '<Peer>', n: 2 }))));
      assert.match(many, /scale\(100\)/);
    }
  });
});
