import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { appendHistory } from './monitoring-model.js';

test('monitoring renders translated alert severity, limits and chart labels in Thai and English', async () => {
  const data = {at:'2026-10-27T00:00:00Z',ready:true,rooms:[{connections:3}],databaseBytes:95,uploadBytes:0,activeDocumentBytes:0,pendingStoreOps:0,pendingStoreBytes:0,memory:{rss:100,heapUsed:1,heapLimit:100},limits:{databaseBytes:100,uploadBytes:100,activeDocumentBytes:100}};
  await withChromeModule('/src/client/maintainer/Monitoring.jsx', ({Monitoring}, {t,setLang}) => {
    for (const lang of ['th','en']) {
      setLang(lang);
      const html=renderToStaticMarkup(React.createElement(Monitoring,{data,history:appendHistory([],data)}));
      assert.ok(html.includes(t('maintainer.critical')));
      assert.ok(html.includes(t('maintainer.usage',{percent:'95%'})));
      assert.ok(html.includes(t('maintainer.connections')));
      assert.ok(html.includes(t('maintainer.historyWaiting')));
      assert.doesNotMatch(html,/NaN|maintainer\.\w+/);
      assert.equal((html.match(/<svg/g) ?? []).length,4);
    }
  });
});
