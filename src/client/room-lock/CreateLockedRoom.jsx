import React, { useId, useMemo, useState, useSyncExternalStore } from 'react';
import { Lock } from 'lucide-react';
import { useAccountSession } from '../account/use-account-session.js';
import { Button } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT } from '../ui/ui-variants.js';
import { t } from '../ui/i18n.js';
import { ROOM_PASSWORD_MIN_LENGTH } from '../../domain/room-lock-contract.js';
import {
  FORM_ERROR, canOfferLockedRoom, createLockedRoomController, validateLockedRoomForm,
} from './create-locked-room-controller.js';

const ICON_SIZE_PX = 16;
const NOTICE_KEYS = Object.freeze(['roomLock.create.notice.votes', 'roomLock.create.notice.owner', 'roomLock.create.notice.recovery']);

/** The form itself: pure, so each state can be rendered on its own. */
export function CreateLockedRoomForm({ form, onChange, onSubmit, busy, disabled, failed = false, formId }) {
  const id = useId();
  const errors = validateLockedRoomForm(form);
  const showMismatch = form.confirmation.length > 0 && errors.includes(FORM_ERROR.MISMATCH);
  return (
    <form id={formId} className="rb-landing__lock-form" onSubmit={onSubmit} aria-busy={busy} aria-label={t('roomLock.create.toggle')}>
      <p className="rb-landing__lock-note">{t('roomLock.create.desc')}</p>
      <label htmlFor={`${id}-pw`} className="rb-landing__lock-label">{t('roomLock.create.password')}</label>
      <input id={`${id}-pw`} className="rb-input rb-landing__input" type="password" autoComplete="new-password"
        value={form.password} disabled={busy} onChange={(e) => onChange({ password: e.target.value })} />
      <p className="rb-landing__lock-note">{t('roomLock.create.hint', { min: ROOM_PASSWORD_MIN_LENGTH })}</p>
      <label htmlFor={`${id}-confirm`} className="rb-landing__lock-label">{t('roomLock.create.confirm')}</label>
      <input id={`${id}-confirm`} className="rb-input rb-landing__input" type="password" autoComplete="new-password"
        value={form.confirmation} disabled={busy} aria-invalid={showMismatch || undefined}
        onChange={(e) => onChange({ confirmation: e.target.value })} />
      {showMismatch && <p role="alert" className="rb-landing__lock-error">{t('roomLock.create.mismatch')}</p>}
      <ul className="rb-landing__lock-notice">{NOTICE_KEYS.map((key) => <li key={key}>{t(key)}</li>)}</ul>
      <label className="rb-landing__lock-check">
        <input type="checkbox" checked={form.acknowledged} disabled={busy}
          onChange={(e) => onChange({ acknowledged: e.target.checked })} />
        <span>{t('roomLock.create.ack')}</span>
      </label>
      {failed && <p role="alert" className="rb-landing__lock-error">{t('landing.create.error.unavailable')}</p>}
      <Button type="submit" variant={BUTTON_VARIANT.DEFAULT} disabled={busy || disabled || errors.length > 0}>
        {busy ? t('roomLock.create.busy') : t('roomLock.create.submit')}
      </Button>
    </form>
  );
}

const EMPTY_FORM = Object.freeze({ password: '', confirmation: '', acknowledged: false });

/** The toggle and, when open, the form: what an entitled user sees. */
export function CreateLockedRoomOption({ open, onToggle, formId, ...formProps }) {
  return (
    <div className="rb-landing__lock">
      <Button type="button" variant={BUTTON_VARIANT.DEFAULT} aria-expanded={open} aria-controls={formId} onClick={onToggle}>
        <Lock size={ICON_SIZE_PX} aria-hidden="true" /> {t('roomLock.create.toggle')}
      </Button>
      {open && <CreateLockedRoomForm formId={formId} {...formProps} />}
    </div>
  );
}

/** Offers a password-protected board to entitled, signed-in users only; renders nothing until that is known. */
export default function CreateLockedRoom({ boardName, createBoard, creating }) {
  const account = useAccountSession();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const controller = useMemo(() => createLockedRoomController(), []);
  const formId = useId();
  const { busy, failed } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  if (!canOfferLockedRoom(account)) return null;
  const onSubmit = async (event) => {
    event.preventDefault();
    await controller.submit(form, { name: boardName, createBoard });
    setForm(EMPTY_FORM);
  };
  return (
    <CreateLockedRoomOption open={open} onToggle={() => setOpen(!open)} formId={formId} failed={failed} form={form}
      busy={busy} disabled={creating} onChange={(patch) => setForm({ ...form, ...patch })} onSubmit={onSubmit} />
  );
}
