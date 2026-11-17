import React, { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { Lock, Trash2 } from 'lucide-react';
import { t } from '../ui/i18n.js';
import { ModalShell } from '../ui/ModalShell.jsx';
import { Button, portalToBody } from '../ui/UiPrimitives.jsx';
import { TypeToConfirmDialog } from '../ui/TypeToConfirmDialog.jsx';
import { BoardTitleDialog } from '../ui/BoardTitleDialog.jsx';
import { BUTTON_VARIANT, MODAL_LAYER, MODAL_SIZE } from '../ui/ui-variants.js';
import { formatRelativeTime } from '../ui/relative-time.js';
import { ROOM_KIND } from '../../domain/room-ownership.js';
import { signInHref } from './account-api.js';
import { MY_BOARDS_ERROR, MY_BOARDS_STATUS, createMyBoardsController } from './my-boards-controller.js';
import { DELETE_COPY_KEYS } from '../workspace/room-delete-copy.js';
import { ROOM_ERROR_KEYS as ERROR_KEYS } from '../workspace/room-error-copy.js';
import './my-boards.css';

const BADGE_ICON_SIZE_PX = 12;
const DELETE_ICON_SIZE_PX = 20;
const KIND_KEYS = Object.freeze({ [ROOM_KIND.BOARD]: 'myBoards.kind.board', [ROOM_KIND.POKER]: 'poker.title' });

const isKnownTime = (value) => Number.isFinite(value) && value > 0;

function ErrorNotice({ error, signInUrl, onRetry }) {
  return (
    <div className="rb-my-boards__notice" role="alert">
      <span>{t(ERROR_KEYS[error])}</span>
      {error === MY_BOARDS_ERROR.SIGN_IN && <a className="rb-btn rb-my-boards__link" href={signInUrl}>{t('account.signIn')}</a>}
      {error !== MY_BOARDS_ERROR.SIGN_IN && onRetry && <Button onClick={onRetry}>{t('account.retry')}</Button>}
    </div>
  );
}

function RoomMeta({ room, now }) {
  return (
    <span className="rb-my-boards__meta">
      <span>{t(KIND_KEYS[room.kind])}</span>
      {room.title && <span className="rb-my-boards__code">{room.code}</span>}
      {room.locked && (
        <span className="rb-my-boards__badge"><Lock size={BADGE_ICON_SIZE_PX} aria-hidden="true" />{t('myBoards.locked')}</span>
      )}
      {isKnownTime(room.createdAt) && <span>{t('myBoards.created', { time: formatRelativeTime(room.createdAt, now) })}</span>}
      {isKnownTime(room.lastActiveAt) && <span>{t('myBoards.lastActive', { time: formatRelativeTime(room.lastActiveAt, now) })}</span>}
    </span>
  );
}

function RoomRow({ room, now, busy, onAskRename, onAskDelete }) {
  return (
    <li className="rb-my-boards__row">
      <div className="rb-my-boards__main">
        <span className="rb-my-boards__name">{room.title || room.code}</span>
        <RoomMeta room={room} now={now} />
      </div>
      <div className="rb-my-boards__actions">
        {/* A full page load: the link carries the room key in its fragment. */}
        <a className="rb-btn rb-my-boards__link" href={room.link}>{t('myBoards.open')}</a>
        {!room.locked && <Button disabled={busy} onClick={() => onAskRename(room)}>{t('myBoards.rename')}</Button>}
        <Button variant={BUTTON_VARIANT.DANGER} disabled={busy} onClick={() => onAskDelete(room)}>{t('common.delete')}</Button>
      </div>
    </li>
  );
}

function RoomList({ state, now, onAskRename, onAskDelete }) {
  if (state.rooms.length === 0) return <p className="rb-my-boards__status">{t('myBoards.empty')}</p>;
  return (
    <ul className="rb-my-boards__list">
      {state.rooms.map((room) => (
        <RoomRow key={room.code} room={room} now={now} busy={state.busyCode !== null}
          onAskRename={onAskRename} onAskDelete={onAskDelete} />
      ))}
    </ul>
  );
}

function MyBoardsBody({ state, now, signInUrl, onRetry, onAskRename, onAskDelete }) {
  if (state.status === MY_BOARDS_STATUS.LOADING) return <p className="rb-my-boards__status" role="status">{t('myBoards.loading')}</p>;
  if (state.status === MY_BOARDS_STATUS.FAILED) return <ErrorNotice error={state.error} signInUrl={signInUrl} onRetry={onRetry} />;
  return (
    <>
      {state.error && <ErrorNotice error={state.error} signInUrl={signInUrl} />}
      <RoomList state={state} now={now} onAskRename={onAskRename} onAskDelete={onAskDelete} />
    </>
  );
}

/** Stateless view so each state renders on its own in tests. */
export function MyBoardsView({ onClose, ...bodyProps }) {
  const id = useId();
  return (
    <ModalShell size={MODAL_SIZE.MD} labelledBy={`${id}-dialog-title`} onDismiss={onClose}>
      <div id={`${id}-dialog-title`} className="rb-dialog__title rb-my-boards__title">{t('account.myBoards')}</div>
      <MyBoardsBody {...bodyProps} />
    </ModalShell>
  );
}

/** "My boards": the signed-in creator's rooms with open, rename and delete. */
export default function MyBoardsDialog({ onClose }) {
  const controller = useMemo(() => createMyBoardsController(), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [renaming, setRenaming] = useState(null);
  const [deleting, setDeleting] = useState(null);
  useEffect(() => { void controller.load(); }, [controller]);
  // Either outcome closes the small dialog; a refusal shows in the list behind it.
  const rename = async (title) => { await controller.rename(renaming.code, title); setRenaming(null); };
  const remove = async (typed) => { await controller.remove(deleting.code, typed); setDeleting(null); };
  // Portaled: the masthead's stacking context would otherwise trap the overlay below the sticky public bar.
  return portalToBody(
    <>
      <MyBoardsView state={state} now={Date.now()} signInUrl={state.error === MY_BOARDS_ERROR.SIGN_IN ? signInHref() : ''}
        onClose={onClose} onRetry={() => void controller.load()} onAskRename={setRenaming} onAskDelete={setDeleting} />
      {renaming && (
        <BoardTitleDialog initialTitle={renaming.title} busy={state.busyCode === renaming.code} layer={MODAL_LAYER.RAISED}
          onCancel={() => setRenaming(null)} onSave={(title) => void rename(title)} />
      )}
      {deleting && (
        <TypeToConfirmDialog
          layer={MODAL_LAYER.RAISED}
          icon={<Trash2 size={DELETE_ICON_SIZE_PX} color="var(--danger)" aria-hidden="true" />}
          title={t(DELETE_COPY_KEYS[deleting.kind].title)}
          body={t(DELETE_COPY_KEYS[deleting.kind].body)}
          prompt={t(DELETE_COPY_KEYS[deleting.kind].prompt, { code: deleting.code })}
          expected={deleting.code}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('common.delete')}
          busy={state.busyCode === deleting.code}
          onCancel={() => setDeleting(null)}
          onConfirm={(typed) => void remove(typed)}
        />
      )}
    </>,
  );
}
