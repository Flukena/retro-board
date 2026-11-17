import React, { useId, useState } from 'react';
import { t } from './i18n.js';
import { ModalShell } from './ModalShell.jsx';
import { Button } from './UiPrimitives.jsx';
import { BUTTON_VARIANT, MODAL_LAYER, MODAL_SIZE } from './ui-variants.js';
import { isEnterKey } from './modal-model.js';
import { BOARD_TITLE_MAX_LENGTH } from '../../domain/security-boundaries.js';
import { renameTitleFrom } from '../../domain/board-title.js';

/** Small rename dialog: Save stays off until the typed title is within the board title bounds. */
export function BoardTitleDialog({ initialTitle, busy = false, layer = MODAL_LAYER.DEFAULT, onCancel, onSave }) {
  const id = useId();
  const [name, setName] = useState(initialTitle ?? '');
  const canSave = !busy && renameTitleFrom(name) !== null;
  const save = () => { if (canSave) onSave(name); };
  return (
    <ModalShell size={MODAL_SIZE.SM} layer={layer} labelledBy={`${id}-title`} onDismiss={onCancel} dismissDisabled={busy}>
      <label id={`${id}-title`} htmlFor={`${id}-input`} className="rb-dialog__title">{t('myBoards.renameTitle')}</label>
      <input id={`${id}-input`} autoFocus className="rb-input rb-dialog__input" value={name} disabled={busy}
        maxLength={BOARD_TITLE_MAX_LENGTH} placeholder={t('myBoards.renamePlaceholder')}
        onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (isEnterKey(event)) save(); }} />
      <div className="rb-dialog__actions">
        <Button disabled={busy} onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant={BUTTON_VARIANT.PRIMARY} disabled={!canSave} onClick={save}>{t('common.save')}</Button>
      </div>
    </ModalShell>
  );
}
