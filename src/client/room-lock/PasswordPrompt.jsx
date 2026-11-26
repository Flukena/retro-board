import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT } from '../ui/ui-variants.js';
import { t } from '../ui/i18n.js';
import { PROMPT_ERROR } from './password-prompt-state.js';
import { createPasswordPromptController } from './password-prompt-controller.js';
import './room-lock.css';

const FORM_STYLE = Object.freeze({ display: 'grid', gap: 12, textAlign: 'start' });
const INPUT_STYLE = Object.freeze({ padding: '10px 12px', fontSize: 15, width: '100%' });
const ERROR_STYLE = Object.freeze({ color: 'var(--danger)', fontSize: 13, margin: 0 });

const errorText = (error) => {
  if (error?.kind === PROMPT_ERROR.WRONG) return t('roomLock.prompt.wrong');
  if (error?.kind === PROMPT_ERROR.LOCKED_OUT) return t('roomLock.prompt.lockedOut', { seconds: error.seconds });
  if (error?.kind === PROMPT_ERROR.UNAVAILABLE) return t('roomLock.prompt.unavailable');
  return null;
};

/** The password field and submit button: pure, so each state can be rendered on its own. */
export function PasswordPromptView({
  password, onPasswordChange, remember = false, onRememberChange, onSubmit,
  busy, error, lockedOutSeconds, submitLabel,
}) {
  const inputId = useId();
  const message = errorText(error);
  const blocked = busy || lockedOutSeconds > 0 || password.length === 0;
  return (
    <form style={FORM_STYLE} onSubmit={onSubmit} aria-busy={busy}>
      <label htmlFor={inputId} style={{ fontSize: 13, fontWeight: 700 }}>{t('roomLock.password.label')}</label>
      <input
        id={inputId}
        className="rb-input"
        style={INPUT_STYLE}
        type="password"
        autoComplete="current-password"
        autoFocus
        value={password}
        disabled={busy}
        aria-invalid={error?.kind === PROMPT_ERROR.WRONG || undefined}
        aria-describedby={message ? `${inputId}-error` : undefined}
        onChange={(event) => onPasswordChange(event.target.value)}
      />
      <label className="rb-room-lock__check">
        <input type="checkbox" checked={remember} disabled={busy}
          onChange={(event) => onRememberChange(event.target.checked)} />
        <span>{t('roomLock.prompt.remember')}</span>
      </label>
      {message && <p id={`${inputId}-error`} role="alert" style={ERROR_STYLE}>{message}</p>}
      <Button type="submit" variant={BUTTON_VARIANT.PRIMARY} disabled={blocked}>
        {busy ? t('roomLock.prompt.busy') : submitLabel}
      </Button>
    </form>
  );
}

/** Collects a password and hands it to `submit`; shows the busy, wrong-password and lock-out states. */
export default function PasswordPrompt({ submit, submitLabel }) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const controller = useMemo(
    () => createPasswordPromptController(({ password: value, remember: shouldRemember }) => submitRef.current(value, shouldRemember)),
    [],
  );
  useEffect(() => controller.dispose, [controller]);
  const { busy, error, lockedOutSeconds } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const onSubmit = async (event) => {
    event.preventDefault();
    if (await controller.submit({ password, remember })) setPassword('');
  };
  return (
    <PasswordPromptView
      password={password}
      onPasswordChange={setPassword}
      remember={remember}
      onRememberChange={setRemember}
      onSubmit={onSubmit}
      busy={busy}
      error={error}
      lockedOutSeconds={lockedOutSeconds}
      submitLabel={submitLabel}
    />
  );
}
