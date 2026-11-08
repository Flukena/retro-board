import React, { useMemo, useSyncExternalStore } from 'react';
import { ModalShell } from '../ui/ModalShell.jsx';
import { t } from '../ui/i18n.js';
import PasswordPrompt from './PasswordPrompt.jsx';
import { createReunlockController } from './reunlock-controller.js';

const TITLE_ID = 'room-reunlock-dialog-title';

/** The dialog body; it cannot be dismissed, because the board stays read-only until the key is back. */
export function ReunlockDialogView({ onUnlock }) {
  return (
    <ModalShell labelledBy={TITLE_ID} dismissDisabled>
      <h2 id={TITLE_ID} className="rb-dialog__title">{t('roomLock.reunlock.title')}</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6 }}>{t('roomLock.reunlock.body')}</p>
      <PasswordPrompt submit={onUnlock} submitLabel={t('roomLock.reunlock.submit')} />
    </ModalShell>
  );
}

/** Opens over the board, without a reload, when the password or key changed elsewhere. */
export default function ReunlockDialog() {
  const controller = useMemo(() => createReunlockController(globalThis.window), []);
  const open = useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => false);
  return open ? <ReunlockDialogView onUnlock={controller.unlock} /> : null;
}
