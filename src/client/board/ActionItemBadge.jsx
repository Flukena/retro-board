import React from 'react';
import { CheckSquare, Square } from 'lucide-react';
import { ACTION_FIELD, isActionItem } from '../../domain/action-item.js';
import { t, getLang } from '../ui/i18n.js';
import { formatActionDue } from './action-item-format.js';

const BADGE_ICON_SIZE_PX = 12;

/** Read-only chip on an action-item sticky: done state, owner and due date. */
export function ActionItemBadge({ item, hidden }) {
  if (!isActionItem(item)) return null;
  const done = item[ACTION_FIELD.DONE] === true;
  const owner = hidden ? '' : item[ACTION_FIELD.OWNER] || '';
  const due = formatActionDue(item[ACTION_FIELD.DUE], getLang());
  const label = done ? t('action.badge.done') : t('action.badge.open');
  return (
    <span className={done ? 'rb-action-badge rb-action-badge--done' : 'rb-action-badge'} title={label} aria-label={label}>
      {done ? <CheckSquare size={BADGE_ICON_SIZE_PX} /> : <Square size={BADGE_ICON_SIZE_PX} />}
      {owner && <span className="rb-action-badge__text">{owner}</span>}
      {due && <span className="rb-action-badge__text">{due}</span>}
    </span>
  );
}
