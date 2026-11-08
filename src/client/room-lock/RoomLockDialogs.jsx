import React, {
  useEffect, useId, useMemo, useRef, useState, useSyncExternalStore,
} from 'react';
import { ModalShell } from '../ui/ModalShell.jsx';
import { Button, Surface } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT } from '../ui/ui-variants.js';
import { TOAST_BOTTOM_PX, Z } from '../chrome/chrome-layout.js';
import { t, useLang } from '../ui/i18n.js';
import { ROOM_PASSWORD_MIN_LENGTH } from '../../domain/room-lock-contract.js';
import { getRoomKey } from './lock-session.js';
import { changeRoomPassword } from './change-password.js';
import { rotateRoom } from './rotate-room.js';
import { createRoomLockApi } from './room-lock-api.js';
import { createPasswordPromptController } from './password-prompt-controller.js';
import {
  EMPTY_NEW_PASSWORD_FORM, NEW_PASSWORD_ERROR, lockFormErrorFor, lockFormMessageKey, validateNewPasswordForm,
} from './room-lock-form.js';
import {
  ROOM_LOCK_DIALOG, ROOM_LOCK_NOTICE, listenForE2ENotices, roomLockDialog, roomLockNotice,
} from './room-lock-dialog-store.js';
import '../session/client-resilience.css';
import './room-lock.css';

const NOTICE_VISIBLE_MS = 6_000;
const PASSWORD_INPUT = 'password';

function PasswordField({ id, labelKey, value, onChange, busy, autoComplete, invalid }) {
  return (
    <>
      <label htmlFor={id} className="rb-room-lock__label">{t(labelKey)}</label>
      <input id={id} className="rb-input rb-room-lock__input" type={PASSWORD_INPUT} autoComplete={autoComplete}
        value={value} disabled={busy} aria-invalid={invalid || undefined} onChange={(event) => onChange(event.target.value)} />
    </>
  );
}

/** Current password, new password, confirmation and the no-recovery acknowledgement: pure, so each state renders alone. */
export function NewPasswordForm({
  form, onChange, onSubmit, onCancel, busy, error, lockedOutSeconds = 0, submitLabel, busyLabel,
}) {
  const id = useId();
  const errors = validateNewPasswordForm(form);
  const showMismatch = form.confirmation.length > 0 && errors.includes(NEW_PASSWORD_ERROR.MISMATCH);
  const showSame = form.password.length > 0 && errors.includes(NEW_PASSWORD_ERROR.SAME);
  const messageKey = lockFormMessageKey(error);
  return (
    <form className="rb-room-lock__form" onSubmit={onSubmit} aria-busy={busy}>
      <PasswordField id={`${id}-current`} labelKey="roomLock.change.current" value={form.current} busy={busy}
        autoComplete="current-password" onChange={(current) => onChange({ current })} />
      <PasswordField id={`${id}-new`} labelKey="roomLock.change.new" value={form.password} busy={busy}
        autoComplete="new-password" invalid={showSame} onChange={(password) => onChange({ password })} />
      <p className="rb-room-lock__note">{t('roomLock.create.hint', { min: ROOM_PASSWORD_MIN_LENGTH })}</p>
      {showSame && <p role="alert" className="rb-room-lock__error">{t('roomLock.change.same')}</p>}
      <PasswordField id={`${id}-confirm`} labelKey="roomLock.change.confirm" value={form.confirmation} busy={busy}
        autoComplete="new-password" invalid={showMismatch} onChange={(confirmation) => onChange({ confirmation })} />
      {showMismatch && <p role="alert" className="rb-room-lock__error">{t('roomLock.create.mismatch')}</p>}
      <label className="rb-room-lock__check">
        <input type="checkbox" checked={form.acknowledged} disabled={busy}
          onChange={(event) => onChange({ acknowledged: event.target.checked })} />
        <span>{t('roomLock.create.ack')}</span>
      </label>
      {messageKey && <p role="alert" className="rb-room-lock__error">{t(messageKey, { seconds: lockedOutSeconds })}</p>}
      <div className="rb-dialog__actions rb-dialog__actions--spaced">
        <Button type="button" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
        <Button type="submit" variant={BUTTON_VARIANT.PRIMARY} disabled={busy || lockedOutSeconds > 0 || errors.length > 0}>
          {busy ? busyLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** One owner dialog: modal (it also blocks board edits) and not dismissable while its action runs. */
export function OwnerDialogView({ titleId, title, paragraphs, onClose, busy, children }) {
  return (
    <ModalShell labelledBy={titleId} onDismiss={onClose} dismissDisabled={busy}>
      <h2 id={titleId} className="rb-dialog__title">{title}</h2>
      {paragraphs.map((text) => <p key={text} className="rb-room-lock__note">{text}</p>)}
      {children}
    </ModalShell>
  );
}

const DIALOGS = Object.freeze({
  [ROOM_LOCK_DIALOG.PASSWORD]: Object.freeze({
    title: 'roomLock.change.title',
    paragraphs: Object.freeze(['roomLock.change.body']),
    submit: 'roomLock.change.submit',
    busy: 'roomLock.change.busy',
    notice: ROOM_LOCK_NOTICE.PASSWORD_CHANGED,
    run: (form, key, signal) => changeRoomPassword({
      currentPassword: form.current, newPassword: form.password, key, api: createRoomLockApi(key.roomHandle), signal,
    }),
  }),
  [ROOM_LOCK_DIALOG.ROTATE]: Object.freeze({
    title: 'roomLock.rotate.title',
    paragraphs: Object.freeze(['roomLock.rotate.body', 'roomLock.rotate.edits']),
    submit: 'roomLock.rotate.submit',
    busy: 'roomLock.rotate.busy',
    notice: null,
    // Success closes every socket with 4001; the re-unlock dialog then asks this page for the new password too.
    run: (form, key, signal) => rotateRoom({
      currentPassword: form.current, newPassword: form.password, key, storage: globalThis.window.storage, api: createRoomLockApi(key.roomHandle), signal,
    }),
  }),
});

function OwnerDialog({ spec, onClose }) {
  const titleId = useId();
  const [form, setForm] = useState(EMPTY_NEW_PASSWORD_FORM);
  const specRef = useRef(spec);
  specRef.current = spec;
  const running = useRef(null);
  const controller = useMemo(() => createPasswordPromptController((value) => {
    running.current = new AbortController();
    return specRef.current.run(value, getRoomKey(), running.current.signal);
  }, undefined, lockFormErrorFor), []);
  // Unmounting cancels a running action; a rotation that already froze the room then aborts and never commits.
  useEffect(() => () => {
    controller.dispose();
    running.current?.abort();
  }, [controller]);
  const { busy, error, lockedOutSeconds } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const onSubmit = async (event) => {
    event.preventDefault();
    if (validateNewPasswordForm(form).length > 0 || !(await controller.submit(form))) return;
    setForm(EMPTY_NEW_PASSWORD_FORM);
    onClose();
    if (specRef.current.notice) roomLockNotice.set(specRef.current.notice);
  };
  return (
    <OwnerDialogView titleId={titleId} title={t(spec.title)} paragraphs={spec.paragraphs.map((key) => t(key))} onClose={onClose} busy={busy}>
      <NewPasswordForm form={form} onChange={(patch) => setForm({ ...form, ...patch })} onSubmit={onSubmit} onCancel={onClose}
        busy={busy} error={error} lockedOutSeconds={lockedOutSeconds} submitLabel={t(spec.submit)} busyLabel={t(spec.busy)} />
    </OwnerDialogView>
  );
}

export function RoomLockNoticeView({ messageKey }) {
  return (
    <Surface role="status" aria-live="polite" className="rb-sync-banner"
      style={{ '--rb-sync-bottom-px': `${TOAST_BOTTOM_PX}px`, zIndex: Z.TOAST }}>
      <span>{t(messageKey)}</span>
    </Surface>
  );
}

function RoomLockNotices() {
  useLang();
  const notice = useSyncExternalStore(roomLockNotice.subscribe, roomLockNotice.getSnapshot, () => null);
  useEffect(() => listenForE2ENotices(globalThis.window), []);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => roomLockNotice.set(null), NOTICE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  return notice ? <RoomLockNoticeView messageKey={notice} /> : null;
}

/** Mounted next to ReunlockDialog on an unlocked board: the owner dialogs and the encrypted-room notices. */
export default function RoomLockDialogs() {
  const open = useSyncExternalStore(roomLockDialog.subscribe, roomLockDialog.getSnapshot, () => null);
  const close = () => roomLockDialog.set(null);
  return (
    <>
      {open && <OwnerDialog key={open} spec={DIALOGS[open]} onClose={close} />}
      <RoomLockNotices />
    </>
  );
}
