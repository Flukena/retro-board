import React, { useState } from 'react';
import { PLAN } from '../../domain/plan-entitlements.js';
import { t } from '../ui/i18n.js';

const ACCOUNTS_TIMEOUT_MS = 8000;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;

async function requestAccounts(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(ACCOUNTS_TIMEOUT_MS), ...options,
  });
  if (response.status === STATUS_NOT_FOUND) return null;
  if (!response.ok) throw new Error(response.status === STATUS_UNAUTHORIZED ? 'maintainer.sessionExpired' : 'maintainer.accounts.error');
  return response.json();
}

const findAccounts = (email) => requestAccounts(`/api/accounts?email=${encodeURIComponent(email)}`);

const savePlan = (id, plan) => requestAccounts(`/api/accounts/${encodeURIComponent(id)}/plan`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan }),
});

function AccountCard({ account, busy, onToggle }) {
  const pro = account.plan === PLAN.PRO;
  return <div className="maintainer-account">
    <p><strong>{account.name}</strong> · {account.email}</p>
    <p>{t(pro ? 'maintainer.accounts.plan.pro' : 'maintainer.accounts.plan.free')}</p>
    <button disabled={busy} onClick={onToggle}>{t(pro ? 'maintainer.accounts.revokePro' : 'maintainer.accounts.grantPro')}</button>
  </div>;
}

// Stateless view, so each state renders on its own in tests.
// Two Google identities can share an email, so a search can list several accounts.
export function AccountsView({ email = '', accounts = [], notFound = false, busy = false, error = '', onEmail, onSearch, onToggle }) {
  return <section className="maintainer-accounts">
    <h2>{t('maintainer.accounts.title')}</h2>
    <form onSubmit={onSearch}>
      <label>{t('maintainer.accounts.search')}<input type="email" required value={email} onChange={onEmail} /></label>
      <button type="submit" disabled={busy}>{t(busy ? 'maintainer.loading' : 'maintainer.accounts.search')}</button>
    </form>
    {notFound && <p role="status">{t('maintainer.accounts.notFound')}</p>}
    {accounts.map((account) => <AccountCard key={account.id} account={account} busy={busy} onToggle={() => onToggle(account)} />)}
    {error && <p role="alert">{t(error)}</p>}
  </section>;
}

export function Accounts() {
  const [email, setEmail] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (work) => {
    setBusy(true);
    setError('');
    try { await work(); } catch (failure) {
      setError(failure.message === 'maintainer.sessionExpired' ? failure.message : 'maintainer.accounts.error');
    } finally { setBusy(false); }
  };
  const search = (event) => {
    event.preventDefault();
    void run(async () => {
      const found = await findAccounts(email.trim());
      setAccounts(found?.accounts ?? []);
      setNotFound(found === null);
    });
  };
  // An account deleted since the search drops out of the list.
  const toggle = (account) => run(async () => {
    const next = account.plan === PLAN.PRO ? PLAN.FREE : PLAN.PRO;
    const updated = await savePlan(account.id, next);
    setAccounts((current) => current.flatMap((each) => {
      if (each.id !== account.id) return [each];
      return updated ? [updated] : [];
    }));
  });
  return <AccountsView email={email} accounts={accounts} notFound={notFound} busy={busy} error={error}
    onEmail={(event) => setEmail(event.target.value)} onSearch={search} onToggle={(account) => void toggle(account)} />;
}
