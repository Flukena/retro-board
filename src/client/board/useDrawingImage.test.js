import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
test('server rendering never fetches or accesses bitmap/DOM hosts for either editor state', async () => {
  await withChromeModule('/src/client/board/useDrawingImage.js', ({ useDrawingImage }) => {
    for (const active of [false,true]) {
      let model;
      function Harness() { model=useDrawingImage(active,{id:'image',type:'image',src:'drawing.png'},()=>assert.fail('SSR must not load a browser image')); return null; }
      assert.equal(renderToStaticMarkup(React.createElement(Harness)), '');
      assert.equal(model.baseRef.current,null); assert.equal(model.failed,false);
    }
  });
});
