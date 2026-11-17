import React, { useId, useState } from 'react';
import { ModalShell } from './ModalShell.jsx';
import { Button } from './UiPrimitives.jsx';
import { BUTTON_VARIANT, MODAL_LAYER, MODAL_SIZE } from './ui-variants.js';
import { isEnterKey, typedConfirmationMatches } from './modal-model.js';
import './modals.css';

/** Stateless, so each typed value renders on its own in tests. Confirm enables only on an exact match. */
export function TypeToConfirmView({
  icon, title, body, prompt, expected, typed, onTypedChange, cancelLabel, confirmLabel,
  busy = false, layer = MODAL_LAYER.DEFAULT, onCancel, onConfirm,
}) {
  const id = useId();
  const matches = typedConfirmationMatches(typed, expected);
  const submit = () => { if (matches && !busy) onConfirm(typed); };
  return (
    <ModalShell size={MODAL_SIZE.SM} layer={layer} labelledBy={`${id}-title`} onDismiss={onCancel} dismissDisabled={busy}>
      <div className="rb-dialog__heading">
        {icon}
        <div id={`${id}-title`} className="rb-dialog__title">{title}</div>
      </div>
      <div className="rb-dialog__body">{body}</div>
      <label htmlFor={`${id}-input`} className="rb-dialog__body">{prompt}</label>
      <input
        id={`${id}-input`}
        autoFocus
        className="rb-input rb-dialog__input"
        value={typed}
        disabled={busy}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(event) => onTypedChange(event.target.value)}
        onKeyDown={(event) => { if (isEnterKey(event)) submit(); }}
      />
      <div className="rb-dialog__actions">
        <Button disabled={busy} onClick={onCancel}>{cancelLabel}</Button>
        <Button variant={BUTTON_VARIANT.DANGER} disabled={busy || !matches} onClick={submit}>{confirmLabel}</Button>
      </div>
    </ModalShell>
  );
}

/** A destructive confirmation that asks the user to type `expected` first. */
export function TypeToConfirmDialog(props) {
  const [typed, setTyped] = useState('');
  return <TypeToConfirmView {...props} typed={typed} onTypedChange={setTyped} />;
}
