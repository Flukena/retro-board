import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withSsrModule } from '../../test-support/ssr-load.js';

const SUBJECT = '/src/client/ui/BoardDialogs.jsx';
test('dialog host preserves conditional dialogs, translated confirmations and import busy state', async () => {
  await withSsrModule(SUBJECT, async ({ BoardDialogs }, { load }) => {
    const { setLang, t } = await load('/src/client/ui/i18n.js');
    const base = { mood: {}, actionItems: {}, templateDraft: [], commentsByItem: new Map(), items: [] };
    const render = props => renderToStaticMarkup(React.createElement(BoardDialogs, { ...base, ...props }));
    assert.equal(render({}), '');
    for (const lang of ['th', 'en']) {
      await setLang(lang);
      const html = render({ confirmClear: true, confirmResetVotes: true, confirmUnlockAll: true });
      assert.equal((html.match(/role="dialog"/g) || []).length, 3);
      for (const key of ['clear.confirm.head', 'reset.confirm.head', 'unlockAll.confirm.head']) assert.ok(html.includes(t(key)));
      assert.ok(html.indexOf(t('unlockAll.confirm.head')) < html.indexOf(t('reset.confirm.head')));
      assert.ok(html.indexOf(t('reset.confirm.head')) < html.indexOf(t('clear.confirm.head')));
      const busy = render({ pendingImport: { name: 'board.json', items: [], warnings: [] }, importBusy: true });
      assert.equal((busy.match(/disabled=""/g) || []).length, 3);
      assert.ok(busy.includes(t('import.processing')));
      const help = render({ helpOpen: true });
      assert.match(help, /role="dialog"/);
      for (const props of [
        { saveTemplateOpen: true },
        { renameTarget: { id: 'template', name: 'Existing template' } },
        { nameModalOpen: true, nameDraft: 'Participant', userName: 'Participant' },
        { commentsOpenReadable: true, commentsOpenItem: { id: 'note', type: 'sticky', text: 'Note' }, editingAllowed: true },
        { pinPromptCfg: { isSetting: false, error: '' } },
        { mood: { dialogOpen: true } },
        { actionItems: { open: true, rows: [] } },
      ]) assert.match(render(props), /role="dialog"/);
      assert.match(render({ renameTarget: { id: 'template', name: 'Existing template' } }), /value="Existing template"/);
    }
  });
});
