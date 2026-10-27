import React from 'react';
import { t } from '../ui/i18n.js';
import { chartSegments, resourceAlerts } from './monitoring-model.js';
import { formatMib } from './monitoring-format.js';

const CHART_WIDTH_PX = 600;
const CHART_HEIGHT_PX = 120;
const percent = value => `${value}%`;
const display = (field, value) => field === 'clients' ? String(value) : formatMib(value);

export function ResourceAlerts({data}) {
  const alerts = resourceAlerts(data);
  return <section aria-label={t('maintainer.alerts')}>
    {!data.ready && <p role="alert" className="maintainer-critical">{t('maintainer.degraded')}</p>}
    {alerts.map(alert => <p role="alert" className={`maintainer-${alert.severity}`} key={alert.resource}>
      <strong>{t(`maintainer.${alert.severity}`)}</strong> · {t(`maintainer.${alert.resource}`)} · {t('maintainer.usage', {percent:percent(alert.percent)})}
    </p>)}
    {data.ready && !alerts.length && <p>{t('maintainer.healthy')}</p>}
  </section>;
}

function Chart({history, field, label}) {
  const {segments, maximum} = chartSegments(history,field,CHART_WIDTH_PX,CHART_HEIGHT_PX);
  return <figure className="maintainer-chart">
    <figcaption><strong>{t(label)}</strong><span>{t('maintainer.chartLatest', {value:display(field,history.at(-1)?.[field] ?? 0)})}</span></figcaption>
    <p>{t('maintainer.chartRange',{value:display(field,maximum)})}</p>
    <svg viewBox={`0 0 ${CHART_WIDTH_PX} ${CHART_HEIGHT_PX}`} role="img" aria-label={t(label)}>
      {segments.map((points,index) => <polyline key={index} points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
      {history.length === 1 && <circle cx="0" cy={CHART_HEIGHT_PX - history[0][field] / maximum * CHART_HEIGHT_PX} r="3" fill="currentColor" />}
    </svg>
    <div className="maintainer-chart-times"><time>{new Date(history[0].at).toLocaleTimeString()}</time><time>{new Date(history.at(-1).at).toLocaleTimeString()}</time></div>
  </figure>;
}

export function Monitoring({data,history}) {
  return <>
    <ResourceAlerts data={data}/>
    <section><h2>{t('maintainer.history')}</h2><p>{t('maintainer.historyHint')}</p>
      {history.length < 2 && <p role="status">{t('maintainer.historyWaiting')}</p>}
      {!!history.length && <div className="maintainer-charts">{[
        ['clients','maintainer.connections'],['memory','maintainer.memory'],
        ['database','maintainer.database'],['uploads','maintainer.uploads'],
      ].map(([field,label])=><Chart key={field} history={history} field={field} label={label}/>)}</div>}
    </section>
  </>;
}
