import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
test('session entry respects edit permissions and accepts only saved PNGs without triggering unrelated tools', async () => {
  await withChromeModule('/src/client/board/useDrawingSession.js', ({ useDrawingSession }) => {
    for (const allowed of [false,true]) {
      const events=[];let session;
      function Harness() {session=useDrawingSession({creationMode:null,requireEdit:()=>allowed,closeTemplates:()=>events.push('templates'),setCreationMode:mode=>events.push(mode),setSelectedIds:ids=>events.push(ids.size)});return null;}
      renderToStaticMarkup(React.createElement(Harness));
      session.edit({type:'image',src:'animation.gif'}); assert.deepEqual(events,[]);
      session.toggle(); assert.deepEqual(events,allowed?['templates','draw',0]:[]);
    }
  });
});
