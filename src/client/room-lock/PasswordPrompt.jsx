import React, { useEffect, useId, useState } from 'react';
import { Button } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT } from '../ui/ui-variants.js';
import { t } from '../ui/i18n.js';
import { PROMPT_ERROR, promptErrorFor } from './password-prompt-state.js';

const COUNTDOWN_TICK_MS = 1_000;
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
  password, onPasswordChange, onSubmit, busy, error, lockedOutSeconds, submitLabel,
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
      {message && <p id={`${inputId}-error`} role="alert" style={ERROR_STYLE}>{message}</p>}
      <Button type="submit" variant={BUTTON_VARIANT.PRIMARY} disabled={blocked}>
        {busy ? t('roomLock.prompt.busy') : submitLabel}
      </Button>
    </form>
  );
}

/** The lock-out seconds left, counting down once a second; set it to begin. */
function useLockoutCountdown() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (seconds <= 0) return undefined;
    const timer = setTimeout(() => setSeconds(seconds - 1), COUNTDOWN_TICK_MS);
    return () => clearTimeout(timer);
  }, [seconds]);
  return [seconds, setSeconds];
}

/** Collects a password and hands it to `submit`; shows the busy, wrong-password and lock-out states. */
export default function PasswordPrompt({ submit, submitLabel }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [lockedOutSeconds, setLockedOutSeconds] = useLockoutCountdown();
  const onSubmit = async (event) => {
    event.preventDefault();
    if (busy || lockedOutSeconds > 0) return;
    setBusy(true);
    setError(null);
    try {
      await submit(password);
      setPassword('');
    } catch (failure) {
      const next = promptErrorFor(failure);
      setError(next);
      setLockedOutSeconds(next.seconds);
    } finally {
      setBusy(false);
    }
  };
  const lockedOut = error?.kind === PROMPT_ERROR.LOCKED_OUT;
  let shown = error;
  if (lockedOut) shown = lockedOutSeconds > 0 ? { ...error, seconds: lockedOutSeconds } : null;
  return (
    <PasswordPromptView
      password={password}
      onPasswordChange={setPassword}
      onSubmit={onSubmit}
      busy={busy}
      error={shown}
      lockedOutSeconds={lockedOutSeconds}
      submitLabel={submitLabel}
    />
  );
}
