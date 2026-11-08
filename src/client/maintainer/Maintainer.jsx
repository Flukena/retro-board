import React, { useEffect, useRef, useState } from 'react';
import { t, useLang } from '../ui/i18n.js';
import { appendHistory, selectRooms } from './monitoring-model.js';
import { Monitoring } from './Monitoring.jsx';
import { RoomActivity } from './RoomActivity.jsx';
import { RoomAccess } from './RoomAccess.jsx';
import { IdleRooms } from './IdleRooms.jsx';
import { Accounts } from './Accounts.jsx';
import { formatMib } from './monitoring-format.js';

const REFRESH_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 8000;

function Metric({ label, children }) {
  return <div className="maintainer-metric"><span>{t(label)}</span><strong>{children}</strong></div>;
}

export function Rooms({ rooms, now }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('connections');
  const visible = selectRooms(rooms, query, filter, sort);
  return <section>
    <h2>{t('maintainer.rooms', { n: rooms.length })}</h2>
    <div className="maintainer-filters">
      <label>{t('maintainer.search')}<input value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label>{t('maintainer.filter')}<select aria-label={t('maintainer.filter')} value={filter} onChange={event=>setFilter(event.target.value)}>{['all','active','blocked','resident','cold'].map(value=><option key={value} value={value}>{t(`maintainer.filter.${value}`)}</option>)}</select></label>
      <label>{t('maintainer.sort')}<select aria-label={t('maintainer.sort')} value={sort} onChange={event=>setSort(event.target.value)}>{['connections','uploads','document','handle'].map(value=><option key={value} value={value}>{t(`maintainer.sort.${value}`)}</option>)}</select></label>
    </div>
    <p>{t('maintainer.visibleRooms', {n:visible.length, total:rooms.length})}</p>
    <div className="maintainer-table"><table>
      <thead><tr>{['handle', 'connections', 'state', 'activity', 'uploads', 'document', 'collections', 'openRoom'].map(key => <th key={key}>{t(`maintainer.${key}`)}</th>)}</tr></thead>
      <tbody>{visible.map(room => <tr key={room.handle}>
        <td><code>{room.handle}</code>{room.encrypted && <span className="maintainer-badge">{t('maintainer.encrypted')}</span>}</td><td>{room.connections}</td>
        <td>{t(room.blockedUntil ? 'maintainer.blocked' : room.resident ? 'maintainer.resident' : 'maintainer.cold')}</td>
        <RoomActivity room={room} now={now}/>
        <td>{formatMib(room.uploadBytes)} · {t('maintainer.files', { n: room.uploadFiles })}</td>
        <td>{room.documentBytesUpperBound === null ? t('maintainer.unknown') : formatMib(room.documentBytesUpperBound)}</td>
        <td>{room.collections ? Object.entries(room.collections).map(([name, count]) => <div key={name}><code>{name}</code>: {count ?? t('maintainer.unknown')}</div>) : t('maintainer.unknown')}</td>
        <td>{room.encrypted ? <small>{t('maintainer.encryptedHint')}</small> : <RoomAccess handle={room.handle}/>}</td>
      </tr>)}</tbody>
    </table></div>
    {!visible.length && <p>{t('maintainer.empty')}</p>}
    <p>{t('maintainer.coldHint')}</p>
  </section>;
}

function Dashboard({ data, history }) {
  return <>
    <p>{t(data.ready ? 'maintainer.ready' : 'maintainer.degraded')} · {t(data.publicWall ? 'maintainer.public' : 'maintainer.private')} · {t('maintainer.updated', { at: new Date(data.at).toLocaleTimeString() })}</p>
    <div className="maintainer-metrics">
      <Metric label="maintainer.connections">{data.rooms.reduce((total, room) => total + room.connections, 0)}</Metric>
      <Metric label="maintainer.database">{formatMib(data.databaseBytes)} / {formatMib(data.limits.databaseBytes)}</Metric>
      <Metric label="maintainer.uploads">{formatMib(data.uploadBytes)} / {formatMib(data.limits.uploadBytes)}</Metric>
      <Metric label="maintainer.memory">{formatMib(data.memory.rss)}</Metric>
      <Metric label="maintainer.heap">{formatMib(data.memory.heapUsed)} / {formatMib(data.memory.heapTotal)}</Metric>
      <Metric label="maintainer.uptime">{t('maintainer.seconds', { n: data.uptimeSeconds })}</Metric>
      <Metric label="maintainer.backlog">{data.pendingStoreOps} · {formatMib(data.pendingStoreBytes)}</Metric>
      <Metric label="maintainer.activeDocuments">{formatMib(data.activeDocumentBytes)} / {formatMib(data.limits.activeDocumentBytes)}</Metric>
    </div>
    <Monitoring data={data} history={history} />
    <IdleRooms rooms={data.rooms} now={Date.parse(data.at)} publicWall={data.publicWall} />
    <Rooms rooms={data.rooms} now={Date.parse(data.at)} />
    <Accounts />
  </>;
}

export function Maintainer() {
  const [lang, setLang] = useLang();
  const [secret, setSecret] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [sessionVersion, setSessionVersion] = useState(0);
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = t('maintainer.title');
  }, [lang]);
  useEffect(() => {
    const current = ++generation.current;
    let request;
    let timer;
    let polling = true;
    const refresh = async () => {
      request = new AbortController();
      const timeout = setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch('/api/status', { signal: request.signal, cache: 'no-store', credentials: 'same-origin' });
        if (generation.current !== current) return;
        if (response.status === 401) { polling = false; setAuthenticated(false); setChecking(false); setData(null); setHistory([]); return; }
        if (!response.ok) throw new Error('Maintainer unavailable');
        const next = await response.json();
        if (generation.current === current) { setData(next); setHistory(previous => appendHistory(previous, next)); setAuthenticated(true); setChecking(false); setError(''); }
      } catch {
        if (generation.current === current) { setChecking(false); setError('maintainer.unavailable'); }
      } finally {
        clearTimeout(timeout);
        if (polling && generation.current === current) timer = setTimeout(refresh, REFRESH_INTERVAL_MS);
      }
    };
    refresh();
    return () => { generation.current += 1; request?.abort(); clearTimeout(timer); };
  }, [sessionVersion]);
  const changeSession = async (method, headers = {}) => {
    generation.current += 1;
    const current = generation.current;
    setChecking(true);
    setError('');
    try {
      const response = await fetch('/api/session', {
        method, headers, credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (generation.current !== current) return;
      if (!response.ok) {
        setError(response.status === 401 ? 'maintainer.denied' : 'maintainer.unavailable');
        return;
      }
      setSecret('');
      setData(null);
      setHistory([]);
      setAuthenticated(false);
    } catch {
      if (generation.current === current) setError('maintainer.unavailable');
    } finally {
      if (generation.current === current) { setChecking(false); setSessionVersion(value => value + 1); }
    }
  };
  const login = event => {
    event.preventDefault();
    const authorization = `Bearer ${secret}`;
    setSecret('');
    void changeSession('POST', { Authorization: authorization });
  };
  return <main className="maintainer">
    <header><div><p>{t('maintainer.eyebrow')}</p><h1>{t('maintainer.title')}</h1></div><nav>
      <button onClick={() => setLang(lang === 'th' ? 'en' : 'th')}>{t('maintainer.language')}</button>
      {authenticated && <button disabled={checking} onClick={() => void changeSession('DELETE')}>{t('maintainer.logout')}</button>}
    </nav></header>
    <p>{t('maintainer.description')}</p>
    {error && <p role="alert">{t(error)}</p>}
    {checking ? <p role="status">{t('maintainer.loading')}</p> : !authenticated ? <form onSubmit={login}>
      <label>{t('maintainer.key')}<input type="password" required autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} /></label>
      <button type="submit">{t('maintainer.login')}</button>
    </form> : data ? <Dashboard data={data} history={history} /> : <p role="status">{t('maintainer.loading')}</p>}
  </main>;
}
