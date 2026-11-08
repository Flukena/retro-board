import React, { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { Lock } from 'lucide-react';
import { fetchAccount } from '../account/account-api.js';
import { Button } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT } from '../ui/ui-variants.js';
import { t } from '../ui/i18n.js';
import { ROOM_PASSWORD_MIN_LENGTH } from '../../domain/room-lock-contract.js';
import {
  FORM_ERROR, canOfferLockedRoom, createLockedRoomController, validateLockedRoomForm,
} from './create-locked-room-controller.js';

const ICON_SIZE_PX = 16;
const SECTION_STYLE = Object.freeze({ display: 'grid', gap: 10, marginTop: 14, textAlign: 'start' });
const LABEL_STYLE = Object.freeze({ fontSize: 13, fontWeight: 700 });
const NOTE_STYLE = Object.freeze({ color: 'var(--text-muted)', fontSize: 13, margin: 0 });
const ERROR_STYLE = Object.freeze({ color: 'var(--danger)', fontSize: 13, margin: 0 });
const NOTICE_STYLE = Object.freeze({ ...NOTE_STYLE, paddingInlineStart: 18 });
const CHECK_ROW_STYLE = Object.freeze({ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 });
const NOTICE_KEYS = Object.freeze(['roomLock.create.notice.votes', 'roomLock.create.notice.owner', 'roomLock.create.notice.recovery']);

/** The form itself: pure, so each state can be rendered on its own. */
export function CreateLockedRoomForm({ form, onChange, onSubmit, busy, disabled }) {
  const id = useId();
  const errors = validateLockedRoomForm(form);
  const showMismatch = form.confirmation.length > 0 && errors.includes(FORM_ERROR.MISMATCH);
  return (
    <form style={SECTION_STYLE} onSubmit={onSubmit} aria-busy={busy}>
      <p style={NOTE_STYLE}>{t('roomLock.create.desc')}</p>
      <label htmlFor={`${id}-pw`} style={LABEL_STYLE}>{t('roomLock.create.password')}</label>
      <input id={`${id}-pw`} className="rb-input rb-landing__input" type="password" autoComplete="new-password"
        value={form.password} disabled={busy} onChange={(e) => onChange({ password: e.target.value })} />
      <p style={NOTE_STYLE}>{t('roomLock.create.hint', { min: ROOM_PASSWORD_MIN_LENGTH })}</p>
      <label htmlFor={`${id}-confirm`} style={LABEL_STYLE}>{t('roomLock.create.confirm')}</label>
      <input id={`${id}-confirm`} className="rb-input rb-landing__input" type="password" autoComplete="new-password"
        value={form.confirmation} disabled={busy} aria-invalid={showMismatch || undefined}
        onChange={(e) => onChange({ confirmation: e.target.value })} />
      {showMismatch && <p role="alert" style={ERROR_STYLE}>{t('roomLock.create.mismatch')}</p>}
      <ul style={NOTICE_STYLE}>{NOTICE_KEYS.map((key) => <li key={key}>{t(key)}</li>)}</ul>
      <label style={CHECK_ROW_STYLE}>
        <input type="checkbox" checked={form.acknowledged} disabled={busy}
          onChange={(e) => onChange({ acknowledged: e.target.checked })} />
        <span>{t('roomLock.create.ack')}</span>
      </label>
      <Button type="submit" variant={BUTTON_VARIANT.DEFAULT} disabled={busy || disabled || errors.length > 0}>
        {busy ? t('roomLock.create.busy') : t('roomLock.create.submit')}
      </Button>
    </form>
  );
}

const EMPTY_FORM = Object.freeze({ password: '', confirmation: '', acknowledged: false });

/** Offers a password-protected board to entitled, signed-in users only; renders nothing until that is known. */
export default function CreateLockedRoom({ boardName, createBoard, creating }) {
  const [account, setAccount] = useState(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const controller = useMemo(() => createLockedRoomController(), []);
  const { busy } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    let live = true;
    fetchAccount().then((session) => { if (live) setAccount(session); });
    return () => { live = false; };
  }, []);
  if (!canOfferLockedRoom(account)) return null;
  const onSubmit = async (event) => {
    event.preventDefault();
    await controller.submit(form, { name: boardName, createBoard });
    setForm(EMPTY_FORM);
  };
  return (
    <div>
      <Button variant={BUTTON_VARIANT.DEFAULT} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Lock size={ICON_SIZE_PX} aria-hidden="true" /> {t('roomLock.create.toggle')}
      </Button>
      {open && (
        <CreateLockedRoomForm form={form} busy={busy} disabled={creating}
          onChange={(patch) => setForm({ ...form, ...patch })} onSubmit={onSubmit} />
      )}
    </div>
  );
}
