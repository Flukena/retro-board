import React, { useState } from 'react';
import { CheckSquare, ListTodo, LocateFixed, Square } from 'lucide-react';
import { ACTION_FIELD, ACTION_OWNER_MAX_LENGTH } from '../../domain/action-item.js';
import { ModalShell } from '../ui/ModalShell.jsx';
import { IconButton } from '../ui/UiPrimitives.jsx';
import { MODAL_SIZE } from '../ui/ui-variants.js';
import { t } from '../ui/i18n.js';
import { isActionOverdue, localIsoDate } from './action-item-format.js';
import './action-items.css';

const ROW_ICON_SIZE_PX = 18;
const TITLE_ICON_SIZE_PX = 22;

// Owner is committed on blur or Enter so one name becomes one undo step.
function OwnerField({ row, can, onPatch }) {
  const [draft, setDraft] = useState(row.owner);
  const commit = () => {
    const owner = draft.trim();
    if (owner !== row.owner) onPatch(row.id, { [ACTION_FIELD.OWNER]: owner });
  };
  return (
    <input
      className="rb-action-row__owner"
      value={draft}
      maxLength={ACTION_OWNER_MAX_LENGTH}
      disabled={!can || row.hidden}
      placeholder={t('action.owner.placeholder')}
      aria-label={t('action.owner.label')}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
    />
  );
}

export function ActionItemRow({ row, can, today, onPatch, onLocate }) {
  const doneLabel = row.done ? t('action.markOpen') : t('action.markDone');
  const overdue = isActionOverdue(row, today);
  return (
    <li className={row.done ? 'rb-action-row rb-action-row--done' : 'rb-action-row'}>
      <IconButton
        className="rb-action-row__done"
        disabled={!can}
        aria-pressed={row.done}
        title={doneLabel}
        aria-label={doneLabel}
        onClick={() => can && onPatch(row.id, { [ACTION_FIELD.DONE]: !row.done })}
      >
        {row.done ? <CheckSquare size={ROW_ICON_SIZE_PX} /> : <Square size={ROW_ICON_SIZE_PX} />}
      </IconButton>
      <div className="rb-action-row__body">
        <div className="rb-action-row__text">{row.hidden ? t('action.hiddenCard') : row.text || t('action.emptyCard')}</div>
        <div className="rb-action-row__fields">
          <OwnerField key={row.owner} row={row} can={can} onPatch={onPatch} />
          <input
            type="date"
            className={overdue ? 'rb-action-row__due rb-action-row__due--overdue' : 'rb-action-row__due'}
            value={row.due}
            disabled={!can}
            aria-label={overdue ? t('action.due.overdue') : t('action.due.label')}
            title={overdue ? t('action.due.overdue') : t('action.due.label')}
            onChange={(event) => onPatch(row.id, { [ACTION_FIELD.DUE]: event.target.value })}
          />
        </div>
      </div>
      <IconButton title={t('action.locate')} aria-label={t('action.locate')} onClick={() => onLocate(row.id)}>
        <LocateFixed size={ROW_ICON_SIZE_PX} />
      </IconButton>
    </li>
  );
}

/** Board-wide list of action items; every write goes through the board's item patch. */
export function ActionItemsDialog({ rows, canEdit, onPatch, onLocate, onClose }) {
  const today = localIsoDate();
  return (
    <ModalShell size={MODAL_SIZE.LG} labelledBy="action-items-title" onDismiss={onClose}>
      <div className="rb-dialog__comments">
        <div className="rb-dialog__header">
          <div className="rb-dialog__heading">
            <ListTodo size={TITLE_ICON_SIZE_PX} color="var(--accent)" />
            <div id="action-items-title" className="rb-dialog__title">{t('action.title')}</div>
          </div>
        </div>
        {rows.length === 0
          ? <div className="rb-dialog__empty">{t('action.empty')}</div>
          : (
            <ul className="rb-action-list">
              {rows.map(row => (
                <ActionItemRow key={row.id} row={row} can={canEdit(row.id)} today={today} onPatch={onPatch} onLocate={onLocate} />
              ))}
            </ul>
          )}
      </div>
    </ModalShell>
  );
}
