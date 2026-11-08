import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const FREE = { id: 'acc_1', email: 'owner@example.com', name: 'Owner', plan: 'free', planGrantedAt: null };
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test('shows not-found for an unknown email', async () => {
  await withChromeModule('/src/client/maintainer/Accounts.jsx', ({ AccountsView }, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const html = render(AccountsView, { email: 'x@y.z', notFound: true });
      assert.ok(html.includes(t('maintainer.accounts.notFound')));
      assert.ok(!html.includes(t('maintainer.accounts.grantPro')));
      assert.doesNotMatch(html, /maintainer\.accounts\.\w+/);
    }
  });
});

test('toggles grant and revoke', async () => {
  await withChromeModule('/src/client/maintainer/Accounts.jsx', ({ AccountsView }, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const free = render(AccountsView, { accounts: [FREE] });
      assert.ok(free.includes(t('maintainer.accounts.grantPro')));
      assert.ok(free.includes(t('maintainer.accounts.plan.free')));
      assert.ok(!free.includes(t('maintainer.accounts.revokePro')));
      const pro = render(AccountsView, { accounts: [{ ...FREE, plan: 'pro' }] });
      assert.ok(pro.includes(t('maintainer.accounts.revokePro')));
      assert.ok(pro.includes(t('maintainer.accounts.plan.pro')));
      assert.ok(!pro.includes(t('maintainer.accounts.grantPro')));
      assert.ok(render(AccountsView, { accounts: [FREE], error: 'maintainer.accounts.error' }).includes(t('maintainer.accounts.error')));
    }
  });
});

test('lists every account that shares the searched email', async () => {
  await withChromeModule('/src/client/maintainer/Accounts.jsx', ({ AccountsView }, { t, setLang }) => {
    setLang('en');
    const second = { ...FREE, id: 'acc_2', name: 'Second Owner', plan: 'pro' };
    const html = render(AccountsView, { accounts: [FREE, second] });
    assert.equal(html.match(/class="maintainer-account"/g).length, 2);
    assert.ok(html.includes('Owner') && html.includes('Second Owner'));
    assert.ok(html.includes(t('maintainer.accounts.grantPro')) && html.includes(t('maintainer.accounts.revokePro')));
  });
});

test('every maintainer.accounts key exists in th and en', async () => {
  await withChromeModule('/src/client/maintainer/Accounts.jsx', (_, { t, setLang }) => {
    const keys = ['title', 'search', 'notFound', 'grantPro', 'revokePro', 'plan.free', 'plan.pro', 'error'];
    for (const lang of ['th', 'en']) {
      setLang(lang);
      for (const key of keys) {
        const id = `maintainer.accounts.${key}`;
        assert.notEqual(t(id), id, `${lang} is missing ${id}`);
      }
    }
  });
});
