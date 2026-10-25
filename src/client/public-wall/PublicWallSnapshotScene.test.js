import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('snapshot uses the real image card with eager room-bound public source', async () => {
  await withChromeModule('/src/client/public-wall/PublicWallSnapshotScene.jsx', ({ PublicWallSnapshotScene }) => {
    const src = `/yjs-public/rooms/${'a'.repeat(32)}/images/12345678.png`;
    const markup = renderToStaticMarkup(React.createElement(PublicWallSnapshotScene, {
      snapshot: { items: [{ id: 'photo', type: 'image', x: 120, y: 80, w: 320, h: 180, src }] }, lang: 'en',
    }));
    assert.match(markup, new RegExp(`<img[^>]+src="${src}"`));
    assert.match(markup, /loading="eager"/);
    assert.match(markup, /left:120px;top:80px;width:320px;height:180px/);
  });
});

const SNAPSHOT = { items: [
  { id: 'zone', type: 'zone', x: 100, y: 200, w: 1200, h: 800, color: 2, text: 'Actual zone' },
  { id: 'sticky', type: 'sticky', x: 160, y: 260, color: 3, text: 'Actual sticky' },
  { id: 'text', type: 'text', x: 450, y: 260, text: '<script>escaped</script>' },
] };

test('snapshot scene renders the actual readonly board components with current geometry and no editor or custom gallery', async () => {
  await withChromeModule('/src/client/public-wall/PublicWallSnapshotScene.jsx', ({ PublicWallSnapshotScene }) => {
    const markup = renderToStaticMarkup(React.createElement(PublicWallSnapshotScene, { snapshot: SNAPSHOT, lang: 'en' }));
    assert.match(markup, /class="rb-zone"/);
    assert.match(markup, /class="rb-sticky/);
    assert.match(markup, /Actual zone/);
    assert.match(markup, /Actual sticky/);
    assert.match(markup, /left:160px;top:260px/);
    assert.match(markup, /&lt;script&gt;escaped&lt;\/script&gt;/);
    assert.match(markup, /inert=""/);
    assert.doesNotMatch(markup, /<svg[^>]*viewBox="0 0 560|<foreignObject|rb-public-wall__zone-title|<input|<textarea|contenteditable/);
  });
});

test('every scene mutating entry point is a safe no-op and never changes snapshot state', async () => {
  await withChromeModule('/src/client/public-wall/PublicWallSnapshotScene.jsx', ({ PublicWallSnapshotScene }) => {
    const source = structuredClone(SNAPSHOT);
    const tree = PublicWallSnapshotScene({ snapshot: source, lang: 'en' });
    const cards = tree.props.children.props.children;
    for (const card of cards) {
      const element = card.type(card.props);
      for (const name of ['onStartDrag', 'onStartZoneDrag', 'onBeginFocus', 'onTextChange',
        'onTextKeyDown', 'onTextBlur', 'onToggleVote', 'onOpenComments']) {
        assert.equal(typeof element.props[name], 'function');
        assert.equal(element.props[name]('id', { text: 'must not persist' }), undefined);
      }
      for (const action of Object.values(element.props.actions || {})) assert.equal(action(), undefined);
    }
    assert.deepEqual(source, SNAPSHOT);
  });
});

test('actual snapshot keeps normal board shadows and renders validated custom font size and white ink', async () => {
  await withChromeModule('/src/client/public-wall/PublicWallSnapshotScene.jsx', ({ PublicWallSnapshotScene }) => {
    const markup = renderToStaticMarkup(React.createElement(PublicWallSnapshotScene, {
      snapshot: { items: [{ id: 'note', type: 'sticky', x: 0, y: 0, text: 'Styled note', fontSize: 96, fontColor: '#FFFFFF' }] },
    }));
    assert.match(markup, /rb-sticky--shadow-default/);
    assert.doesNotMatch(markup, /rb-sticky--shadow-flat/);
    assert.match(markup, /font-size:96px/);
    assert.match(markup, /color:#ffffff/);
  });
});
