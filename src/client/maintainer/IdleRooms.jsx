import React, { useState } from 'react';
import { t } from '../ui/i18n.js';
import { GUEST_ROOM_RETENTION_HOURS, IDLE_ROOM_RETENTION_DAYS, idleRoomCandidates } from '../../domain/room-retention.js';

const RETIRE_TIMEOUT_MS = 60_000;
const RETIRE_IDLE_PATH = '/api/rooms/retire-idle';
const RETENTION_LABEL = Object.freeze({ hours: GUEST_ROOM_RETENTION_HOURS, days: IDLE_ROOM_RETENTION_DAYS });
export const IDLE_STEP = Object.freeze({ READY: 'ready', CONFIRM: 'confirm', BUSY: 'busy' });

async function requestRetirement() {
  const response = await fetch(RETIRE_IDLE_PATH, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(RETIRE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'maintainer.sessionExpired' : 'maintainer.idle.failed');
  return response.json();
}

function IdleAction({ idle, step, onAsk, onConfirm, onCancel }) {
  if (!idle) return null;
  if (step === IDLE_STEP.READY) {
    return <button onClick={onAsk}>{t('maintainer.idle.delete', { n: idle })}</button>;
  }
  return <div role="group" aria-label={t('maintainer.idle.title', RETENTION_LABEL)}>
    <p><strong>{t('maintainer.idle.warning')}</strong></p>
    <button disabled={step === IDLE_STEP.BUSY} onClick={onConfirm}>
      {t(step === IDLE_STEP.BUSY ? 'maintainer.loading' : 'maintainer.idle.confirm', { n: idle })}
    </button>
    <button disabled={step === IDLE_STEP.BUSY} onClick={onCancel}>{t('maintainer.idle.cancel')}</button>
  </div>;
}

// Stateless view, so each step renders on its own in tests.
export function IdleRoomsView({ idle, unknownAge, step = IDLE_STEP.READY, result = null, error = '', ...actions }) {
  return <section className="maintainer-idle">
    <h2>{t('maintainer.idle.title', RETENTION_LABEL)}</h2>
    <p>{t(idle ? 'maintainer.idle.summary' : 'maintainer.idle.none', { n: idle, unknown: unknownAge, ...RETENTION_LABEL })}</p>
    <IdleAction idle={idle} step={step} {...actions} />
    {result && <p role="status">{t('maintainer.idle.done', { n: result.retired, files: result.files })}</p>}
    {error && <p role="alert">{t(error)}</p>}
  </section>;
}

// The preview uses the relay's own rule; the relay recomputes it when asked.
export function IdleRooms({ rooms, now, publicWall }) {
  const [step, setStep] = useState(IDLE_STEP.READY);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  if (publicWall) return null;
  const { idle, unknownAge } = idleRoomCandidates(rooms, now);
  const confirm = async () => {
    setStep(IDLE_STEP.BUSY);
    setError('');
    try {
      setResult(await requestRetirement());
    } catch (failure) {
      setError(failure.message.startsWith('maintainer.') ? failure.message : 'maintainer.idle.failed');
    } finally {
      setStep(IDLE_STEP.READY);
    }
  };
  return <IdleRoomsView idle={idle.length} unknownAge={unknownAge.length} step={step} result={result} error={error}
    onAsk={() => { setResult(null); setStep(IDLE_STEP.CONFIRM); }}
    onConfirm={() => void confirm()} onCancel={() => setStep(IDLE_STEP.READY)} />;
}
