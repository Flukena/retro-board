import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Info, Plus, Search, Sparkles, Trash2 } from 'lucide-react';
import { getLang, t, useLang } from '../ui/i18n.js';
import { Button } from '../ui/UiPrimitives.jsx';
import { BoardTitleDialog } from '../ui/BoardTitleDialog.jsx';
import { TypeToConfirmDialog } from '../ui/TypeToConfirmDialog.jsx';
import { BUTTON_VARIANT } from '../ui/ui-variants.js';
import SiteMasthead from '../app/SiteMasthead.jsx';
import CreateBoardError from '../app/CreateBoardError.jsx';
import { useCreateBoard } from '../app/use-create-board.js';
import { signInHref } from '../account/account-api.js';
import { MY_BOARDS_ERROR, MY_BOARDS_STATUS, createMyBoardsController } from '../account/my-boards-controller.js';
import { AGILE_GUIDE_PATH, PLANNING_POKER_PATH } from '../seo/seo-pages.js';
import { STARTER_FORMAT, starterTemplate } from '../templates/starter-formats.js';
import { TemplateThumbnail } from '../templates/TemplateThumbnail.jsx';
import { DELETE_COPY_KEYS } from './room-delete-copy.js';
import { ROOM_ERROR_KEYS } from './room-error-copy.js';
import { WORKSPACE_SORT, visibleRooms } from './workspace-model.js';
import WorkspaceCard from './WorkspaceCard.jsx';
import './workspace.css';

export const WORKSPACE_LINKS = Object.freeze([
  Object.freeze({ href: PLANNING_POKER_PATH, labelKey: 'poker.title' }),
  Object.freeze({ href: AGILE_GUIDE_PATH, labelKey: 'agileGuide.nav.guide' }),
]);
export const WORKSPACE_SKELETON_CARDS = 4;

const HOME_PATH = '/';
const TITLE_ID = 'workspace-title';
const EMPTY_TITLE_ID = 'workspace-empty-title';
const ICON_SIZE_PX = 16;
const CTA_ICON_SIZE_PX = 18;
const DELETE_ICON_SIZE_PX = 20;
// The empty state sketches a blank Start · Stop · Continue board.
const EMPTY_ART_BOX = Object.freeze({ width: 220, height: 120, padding: 16 });
const SKELETON_KEYS = Object.freeze(Array.from({ length: WORKSPACE_SKELETON_CARDS }, (_, index) => `skeleton-${index}`));
const SORT_OPTIONS = Object.freeze([
  { value: WORKSPACE_SORT.RECENT, labelKey: 'workspace.sort.recent' },
  { value: WORKSPACE_SORT.CREATED, labelKey: 'workspace.sort.created' },
  { value: WORKSPACE_SORT.NAME, labelKey: 'workspace.sort.name' },
]);

function Notice({ error, signInUrl, onRetry }) {
  return (
    <div className="rb-workspace__notice" role="alert">
      <span>{t(ROOM_ERROR_KEYS[error])}</span>
      {error === MY_BOARDS_ERROR.SIGN_IN && <a className="rb-btn" href={signInUrl}>{t('account.signIn')}</a>}
      {error !== MY_BOARDS_ERROR.SIGN_IN && onRetry && <Button onClick={onRetry}>{t('account.retry')}</Button>}
    </div>
  );
}

function OldBoardsNote() {
  return <p className="rb-workspace__note"><Info size={ICON_SIZE_PX} aria-hidden="true" />{t('workspace.oldBoards')}</p>;
}

function SkeletonGrid() {
  return (
    <ul className="rb-workspace__grid" aria-busy="true" aria-label={t('myBoards.loading')}>
      {SKELETON_KEYS.map((key) => (
        <li key={key} className="rb-workspace-card rb-workspace-card--skeleton" aria-hidden="true">
          <div className="rb-workspace-card__thumb" />
          <div className="rb-workspace-card__body">
            <span className="rb-workspace-card__bar" />
            <span className="rb-workspace-card__bar rb-workspace-card__bar--short" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ canCreate, creating, createError, onCreateFirst }) {
  return (
    <section className="rb-workspace__empty" aria-labelledby={EMPTY_TITLE_ID}>
      <TemplateThumbnail zones={starterTemplate(STARTER_FORMAT.START_STOP_CONTINUE).zones} {...EMPTY_ART_BOX}
        className="rb-workspace__empty-art" />
      <h2 id={EMPTY_TITLE_ID} className="rb-workspace__empty-title">{t('workspace.empty.title')}</h2>
      <p className="rb-workspace__empty-body">{t('workspace.empty.body')}</p>
      <Button variant={BUTTON_VARIANT.PRIMARY} className="rb-btn--pill rb-workspace__cta" disabled={creating || !canCreate}
        onClick={onCreateFirst}>
        <Plus size={CTA_ICON_SIZE_PX} aria-hidden="true" />{t('workspace.empty.create')}
      </Button>
      <CreateBoardError error={createError} className="rb-workspace__create-error" />
      <OldBoardsNote />
    </section>
  );
}

function Toolbar({ query, sort, onQuery, onSort }) {
  return (
    <>
      <label className="rb-workspace__search">
        <Search size={ICON_SIZE_PX} aria-hidden="true" />
        <input type="search" className="rb-input rb-workspace__field" value={query} placeholder={t('workspace.search')}
          aria-label={t('workspace.search')} onChange={(event) => onQuery(event.target.value)} />
      </label>
      <label className="rb-workspace__sort">
        <span className="rb-workspace__sort-label">{t('workspace.sort')}</span>
        <select className="rb-input rb-workspace__field" value={sort} aria-label={t('workspace.sort')}
          onChange={(event) => onSort(event.target.value)}>
          {SORT_OPTIONS.map(({ value, labelKey }) => <option key={value} value={value}>{t(labelKey)}</option>)}
        </select>
      </label>
    </>
  );
}

function RoomGrid({ state, query, sort, now, menuCode, onToggleMenu, onAskRename, onAskDelete }) {
  const rooms = visibleRooms(state.rooms, { query, sort, locale: getLang() });
  if (rooms.length === 0) return <p className="rb-workspace__no-match">{t('workspace.noMatch')}</p>;
  return (
    <ul className="rb-workspace__grid">
      {rooms.map((room) => (
        <WorkspaceCard key={room.code} room={room} now={now} busy={state.busyCode !== null}
          menuOpen={menuCode === room.code} onToggleMenu={onToggleMenu} onAskRename={onAskRename} onAskDelete={onAskDelete} />
      ))}
    </ul>
  );
}

function WorkspaceBody({ state, signInUrl, onRetry, canCreate, creating, createError, onCreateFirst, ...listProps }) {
  if (state.status === MY_BOARDS_STATUS.LOADING) return <SkeletonGrid />;
  if (state.status === MY_BOARDS_STATUS.FAILED) return <Notice error={state.error} signInUrl={signInUrl} onRetry={onRetry} />;
  return (
    <>
      {state.error && <Notice error={state.error} signInUrl={signInUrl} />}
      {state.rooms.length === 0
        ? <EmptyState canCreate={canCreate} creating={creating} createError={createError} onCreateFirst={onCreateFirst} />
        : <><RoomGrid state={state} {...listProps} /><OldBoardsNote /></>}
    </>
  );
}

/** Stateless page body, so each state renders on its own in tests. */
export function WorkspaceView({
  state, query, sort, now, signInUrl, canCreate, creating, createError, onQuery, onSort, onRetry, onCreateFirst,
  onAskRename, onAskDelete, menuCode, onToggleMenu,
}) {
  const hasRooms = state.status === MY_BOARDS_STATUS.READY && state.rooms.length > 0;
  return (
    <main className="rb-workspace__main" aria-labelledby={TITLE_ID}>
      <div className="rb-workspace__head">
        <div className="rb-workspace__heading">
          <h1 id={TITLE_ID} className="rb-workspace__title">
            {t('workspace.title')}{hasRooms && <> <span className="rb-workspace__count">{state.rooms.length}</span></>}
          </h1>
          {hasRooms && <p className="rb-workspace__intro">{t('workspace.intro')}</p>}
        </div>
        {hasRooms && <Toolbar query={query} sort={sort} onQuery={onQuery} onSort={onSort} />}
      </div>
      <WorkspaceBody state={state} signInUrl={signInUrl} onRetry={onRetry} canCreate={canCreate} creating={creating}
        createError={createError} onCreateFirst={onCreateFirst} query={query} sort={sort} now={now} menuCode={menuCode}
        onToggleMenu={onToggleMenu} onAskRename={onAskRename} onAskDelete={onAskDelete} />
    </main>
  );
}

function RoomDialogs({ state, renaming, deleting, onRename, onRemove, onCancelRename, onCancelDelete }) {
  return (
    <>
      {renaming && (
        <BoardTitleDialog initialTitle={renaming.title} busy={state.busyCode === renaming.code}
          onCancel={onCancelRename} onSave={onRename} />
      )}
      {deleting && (
        <TypeToConfirmDialog
          icon={<Trash2 size={DELETE_ICON_SIZE_PX} color="var(--danger)" aria-hidden="true" />}
          title={t(DELETE_COPY_KEYS[deleting.kind].title)}
          body={t(DELETE_COPY_KEYS[deleting.kind].body)}
          prompt={t(DELETE_COPY_KEYS[deleting.kind].prompt, { code: deleting.code })}
          expected={deleting.code}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('common.delete')}
          busy={state.busyCode === deleting.code}
          onCancel={onCancelDelete}
          onConfirm={onRemove}
        />
      )}
    </>
  );
}

/**
 * "My boards" as the signed-in home page: the creator's rooms as cards with search, sort, rename and delete.
 * `createAction` fills the masthead's action slot; `canCreate` says the relay has confirmed the account.
 */
export default function Workspace({ createAction = null, canCreate = false }) {
  useLang();
  const controller = useMemo(() => createMyBoardsController(), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { creating, createError, createBoard } = useCreateBoard();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(WORKSPACE_SORT.RECENT);
  const [menuCode, setMenuCode] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [deleting, setDeleting] = useState(null);
  useEffect(() => { void controller.load(); }, [controller]);
  // Passing null, or the open card's code, closes the menu.
  const toggleMenu = useCallback((code) => setMenuCode((open) => (open === code ? null : code)), []);
  const askRename = (room) => { setMenuCode(null); setRenaming(room); };
  const askDelete = (room) => { setMenuCode(null); setDeleting(room); };
  // Either outcome closes the small dialog; a refusal shows above the list.
  const rename = async (title) => { await controller.rename(renaming.code, title); setRenaming(null); };
  const remove = async (typed) => { await controller.remove(deleting.code, typed); setDeleting(null); };
  return (
    <div className="rb-workspace">
      <SiteMasthead homeHref={HOME_PATH} BrandIcon={Sparkles} titleKey="app.title" links={WORKSPACE_LINKS}
        action={createAction && <div className="rb-workspace__create">{createAction}</div>} />
      <WorkspaceView state={state} query={query} sort={sort} now={Date.now()} canCreate={canCreate}
        signInUrl={state.error === MY_BOARDS_ERROR.SIGN_IN ? signInHref() : ''}
        creating={creating} createError={createError} onQuery={setQuery} onSort={setSort}
        onRetry={() => void controller.load()} onCreateFirst={() => void createBoard({})}
        onAskRename={askRename} onAskDelete={askDelete} menuCode={menuCode} onToggleMenu={toggleMenu} />
      <RoomDialogs state={state} renaming={renaming} deleting={deleting}
        onRename={(title) => void rename(title)} onRemove={(typed) => void remove(typed)}
        onCancelRename={() => setRenaming(null)} onCancelDelete={() => setDeleting(null)} />
    </div>
  );
}
