import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withSsrModule } from '../../test-support/ssr-load.js';

const SUBJECT = '/src/client/board/CanvasOverlays.jsx';
test('canvas overlays preserve separate world/screen placements and empty-hint conditions', async () => {
  await withSsrModule(SUBJECT, async ({ ZonePreview, EmptyCanvasHint, MarqueeSelection }, { load }) => {
    const { setLang, t } = await load('/src/client/ui/i18n.js');
    const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
    assert.equal(render(ZonePreview, { zonePreview: null }), '');
    assert.match(render(ZonePreview, { zonePreview: { x: 10, y: 20, w: 30, h: 40 } }),
      /position:absolute;left:10px;top:20px;width:30px;height:40px/);
    assert.equal(render(MarqueeSelection, { marquee: null }), '');
    assert.match(render(MarqueeSelection, { marquee: { x1: 90, y1: 70, x2: 10, y2: 20 } }),
      /position:fixed;left:10px;top:20px;width:80px;height:50px/);
    for (const lang of ['th', 'en']) {
      await setLang(lang);
      const empty = render(EmptyCanvasHint, { itemCount: 0, creationMode: null });
      assert.ok(empty.includes(t('empty.hint')));
      assert.ok(empty.includes(t('mobile.emptyHint')));
      assert.equal(render(EmptyCanvasHint, { itemCount: 1, creationMode: null }), '');
      assert.equal(render(EmptyCanvasHint, { itemCount: 0, creationMode: 'draw' }), '');
    }
  });
});
