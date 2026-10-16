import React, { useState } from 'react';
import { Lock, X, Trash2, MessageSquare, HelpCircle } from 'lucide-react';
import { ModalShell } from './ModalShell.jsx';
import { Button, IconButton } from './UiPrimitives.jsx';
import { BUTTON_VARIANT, MODAL_SIZE, MODAL_LAYER } from './ui-variants.js';
import { COMMENT_MAX_LEN } from './comment-schema.js';
import { DISPLAY_NAME_MAX_LENGTH, TEMPLATE_NAME_MAX_LENGTH } from './security-boundaries.js';
import { pinValidity, sanitizePin, TEMPLATE_NAME_MODE, templateNameKeys, templateNameCanSubmit } from './modal-model.js';
import { formatRelativeTime } from './relative-time.js';
import { t } from './i18n.js';
import './modals.css';

export { TEMPLATE_NAME_MODE, templateNameKeys, templateNameCanSubmit } from './modal-model.js';

export function CommentsDialog({ item, comments, editingAllowed, onAdd, onDelete, onClose }) {
  const [draft, setDraft] = useState('');
  const submit = () => {
    const text = draft.trim();
    if (!text || !editingAllowed) return;
    if (onAdd(text) !== false) setDraft('');
  };
  return (
    <ModalShell
      size={MODAL_SIZE.LG}
      role="dialog"
      aria-modal="true"
      labelledBy="comments-dialog-title"
      onDismiss={onClose}
    >
      <div className="rb-dialog__comments">
        <div className="rb-dialog__header">
          <div className="rb-dialog__heading">
            <MessageSquare size={22} color="var(--accent)" />
            <div id="comments-dialog-title" className="rb-dialog__title">{t('comments.title')}</div>
          </div>
          <IconButton
            onClick={onClose}
            aria-label={t('common.close')}
            autoFocus={!editingAllowed}
          >
            <X size={18} />
          </IconButton>
        </div>
        {item.text && (
          <div className="rb-dialog__excerpt">{item.text}
          </div>
        )}
        <div className="rb-dialog__comment-list">
          {comments.length === 0 ? (
            <div className="rb-dialog__empty">
              {t('comments.empty')}
            </div>
          ) : comments.map((comment) => (
            <div
              key={comment.id}
              className="rb-dialog__comment"
            >
              <div className="rb-dialog__comment-meta">
                <span className="rb-dialog__author">
                  {comment.authorName || t('comments.anonymous')}
                </span>
                <span className="rb-dialog__timestamp">{formatRelativeTime(comment.createdAt)}</span>
                <div className="rb-dialog__spacer" />
                {editingAllowed && (
                  <IconButton
                    onClick={() => onDelete(comment.id)}
                    title={t('comments.delete')}
                    aria-label={t('comments.delete')}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                )}
              </div>
              <div className="rb-dialog__comment-text">
                {comment.text}
              </div>
            </div>
          ))}
        </div>
        <div className="rb-dialog__composer">
          <textarea
            autoFocus={editingAllowed}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
              if (e.key === 'Escape') onClose();
            }}
            maxLength={COMMENT_MAX_LEN}
            disabled={!editingAllowed}
            placeholder={t('comments.placeholder')}
            className="rb-input rb-dialog__textarea"
          />
          <div className="rb-dialog__send-actions">
            <Button
              variant={BUTTON_VARIANT.PRIMARY}
              onClick={submit}
              disabled={!editingAllowed || !draft.trim()}
            >{t('comments.send')}
            </Button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

export function AdminPinDialog({ isSetting, error, onCancel, onSubmit }) {
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { valid, matches } = pinValidity(pin, pin2, isSetting);
  const submit = async () => {
    if (!valid || !matches || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(pin);
    } catch (e) {
      setErr(e?.message || t('pin.genericError'));
    } finally {
      setBusy(false);
    }
  };
  const handleKeyDown = (event) => {
    if (event.key === 'Enter') submit();
    if (event.key === 'Escape') onCancel();
  };
  return (
    <ModalShell
      size={MODAL_SIZE.MD}
      role="dialog"
      aria-modal="true"
      layer={MODAL_LAYER.RAISED}
    >
      <div className="rb-dialog__pin-heading">
        <Lock size={20} color="var(--accent)" />
        <div className="rb-dialog__title">
          {isSetting ? t('pin.setHead') : t('pin.verifyHead')}
        </div>
      </div>
      <div className="rb-dialog__pin-body">
        {isSetting
          ? t('pin.setBody')
          : t('pin.verifyBody')}
      </div>
      <input
        type="password"
        inputMode="numeric"
        autoFocus
        value={pin}
        onChange={(e) => setPin(sanitizePin(e.target.value))}
        onKeyDown={handleKeyDown}
        placeholder={t('pin.placeholder')}
        className="rb-input rb-input--mono rb-dialog__pin-input"
      />
      {isSetting && (
        <input
          type="password"
          inputMode="numeric"
          value={pin2}
          onChange={(e) => setPin2(sanitizePin(e.target.value))}
          onKeyDown={handleKeyDown}
          placeholder={t('pin.confirm')}
          className="rb-input rb-input--mono rb-dialog__pin-input rb-dialog__pin-input--confirmation"
        />
      )}
      {error === 'wrong' && (
        <div className="rb-dialog__error">
          {t('pin.wrong')}
        </div>
      )}
      {err && (
        <div className="rb-dialog__error">
          {err}
        </div>
      )}
      {isSetting && pin && pin2 && !matches && (
        <div className="rb-dialog__error">
          {t('pin.mismatch')}
        </div>
      )}
      <div className="rb-dialog__actions rb-dialog__actions--spaced">
        <Button
          onClick={onCancel}
          disabled={busy}
        >{t('common.cancel')}
        </Button>
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          onClick={submit}
          disabled={!valid || !matches || busy}
        >{isSetting ? t('pin.set') : t('pin.unlock')}
        </Button>
      </div>
    </ModalShell>
  );
}

export function TemplateNameDialog({ mode, initialName = '', zoneCount, onSubmit, onClose }) {
  const [name, setName] = useState(initialName);
  const keys = templateNameKeys(mode);
  const canSubmit = templateNameCanSubmit(mode, name, initialName, zoneCount);
  const submit = () => { if (canSubmit) onSubmit(name); };
  return (
    <ModalShell
      size={MODAL_SIZE.SM}
      role="dialog"
      aria-modal="true"
    >
      <div className="rb-dialog__title rb-dialog__template-heading">
        {t(keys.heading)}
      </div>
      {mode === TEMPLATE_NAME_MODE.SAVE && <div className="rb-dialog__body">{t('tmpl.saveDialog.count', { n: zoneCount })}</div>}
      <input
        autoFocus
        value={name}
        maxLength={TEMPLATE_NAME_MAX_LENGTH}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onClose();
        }}
        placeholder={t('tmpl.saveDialog.placeholder')}
        className="rb-input rb-dialog__input rb-dialog__input--template"
      />
      <div className="rb-dialog__actions rb-dialog__actions--spaced">
        <Button
          onClick={onClose}
        >{t('common.cancel')}
        </Button>
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          disabled={!canSubmit}
          onClick={submit}
        >{t(keys.button)}
        </Button>
      </div>
    </ModalShell>
  );
}

export function HelpDialog({ sections, onClose }) {
  return (
    <ModalShell
      size={MODAL_SIZE.LG}
      role="dialog"
      aria-modal="true"
      onDismiss={onClose}
    >
      <div className="rb-dialog__scroll">
        <div className="rb-dialog__header">
          <div className="rb-dialog__heading">
            <HelpCircle size={22} color="var(--accent)" />
            <div className="rb-dialog__title">{t('help.title')}</div>
          </div>
          <IconButton
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X size={18} />
          </IconButton>
        </div>
        <div className="rb-dialog__help-sections">
          {sections.map((s) => (
            <div key={s.key}>
              <div className="rb-dialog__help-heading">
                <span
                  className="rb-help__swatch"
                  style={{ '--rb-help-color': s.color }}
                />
                <div className="rb-dialog__help-title">{t(`help.${s.key}.title`)}</div>
              </div>
              <ul className="rb-dialog__help-list">
                {t(`help.${s.key}.body`).split('\n').map((line) => (
                  <li key={line} className="rb-dialog__help-line">{line}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </ModalShell>
  );
}

export function ConfirmDialog({
  icon, title, body, notes = [], cancelLabel, confirmLabel,
  confirmVariant = BUTTON_VARIANT.PRIMARY, busy, onCancel, onConfirm,
  size = MODAL_SIZE.SM,
}) {
  return (
    <ModalShell
      size={size}
      role="dialog"
      aria-modal="true"
      labelledBy="confirm-dialog-title"
      onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onCancel(); }}
    >
      <div className="rb-dialog__heading">
        {icon}
        <div id="confirm-dialog-title" className="rb-dialog__title">{title}</div>
      </div>
      <div className="rb-dialog__body">{body}</div>
      {notes.map((text) => <div key={text} role="note" className="rb-dialog__note">{text}</div>)}
      <div className="rb-dialog__actions">
        <Button
          autoFocus
          disabled={busy}
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
        <Button
          variant={confirmVariant}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </ModalShell>
  );
}

export function NameDialog({ draft, onDraftChange, onSave }) {
  return (
    <ModalShell>
      <div className="rb-dialog__title rb-dialog__name-heading">{t('name.head')}</div>
      <input
        className="rb-input rb-dialog__input"
        autoFocus
        value={draft}
        maxLength={DISPLAY_NAME_MAX_LENGTH}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') onSave(); }}
        placeholder={t('name.placeholder')}
      />
      <div className="rb-dialog__actions rb-dialog__actions--spaced">
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          onClick={onSave}
        >
          {t('name.confirm')}
        </Button>
      </div>
    </ModalShell>
  );
}
