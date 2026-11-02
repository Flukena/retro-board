import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { t, useLang } from '../ui/i18n.js';
import { NameDialog } from '../ui/Modals.jsx';
import { SyncStatusBanner } from '../session/SyncBanner.jsx';
import { randomGuestName } from '../session/guest-name.js';
import { downloadArtifact } from '../transfer/browser-download.js';
import { ROOM_KIND, buildBoardUrl } from '../app/router.js';
import { canChangeDeck, nextStoryId } from '../../domain/poker-schema.js';
import { pokerCsv } from '../../domain/poker-export.js';
import { pokerTableSeats, summarizeRound } from '../../domain/poker-round.js';
import { savePokerName } from './poker-identity.js';
import { PokerHeader } from './PokerHeader.jsx';
import { StoryList } from './StoryList.jsx';
import { PokerTable } from './PokerTable.jsx';
import { RoundSummary } from './RoundSummary.jsx';
import { CardHand } from './CardHand.jsx';
import { PlayerList } from './PlayerList.jsx';
import './poker.css';

const COPIED_NOTICE_MS = 2000;
const EMPTY_VOTES = new Map();
const CSV_MIME_TYPE = 'text/csv;charset=utf-8';
const EDITABLE_TARGET = 'input, textarea, select, [contenteditable="true"]';

function useUndoShortcuts(store) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      if (event.target instanceof Element && event.target.closest(EDITABLE_TARGET)) return;
      event.preventDefault();
      if (event.shiftKey) store.redo();
      else store.undo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store]);
}

function useNameDialog(store, initialName) {
  const [name, setName] = useState(initialName);
  const [draft, setDraft] = useState(initialName || randomGuestName(Math.random));
  const [open, setOpen] = useState(!initialName);
  const save = () => {
    const saved = savePokerName(draft, localStorage) || randomGuestName(Math.random);
    setName(saved);
    setDraft(saved);
    setOpen(false);
    store.setName(saved);
  };
  const close = () => (name ? setOpen(false) : save());
  return { name, draft, setDraft, open, setOpen, save, close };
}

function useCopyLink(code, token) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    await navigator.clipboard.writeText(buildBoardUrl(code, token, ROOM_KIND.POKER));
    setCopied(true);
  };
  return { copied, copy };
}

function exportCsv(room, code) {
  downloadArtifact({
    fileName: `planning-poker-${code}.csv`,
    mimeType: CSV_MIME_TYPE,
    contents: pokerCsv(room, {
      story: t('poker.csv.story'), estimate: t('poker.csv.estimate'), votes: t('poker.csv.votes'), average: t('poker.csv.average'),
    }),
  });
}

export default function PokerApp({ code, token, store, syncStatus, initialName }) {
  useLang();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const sync = useSyncExternalStore(syncStatus.subscribe, syncStatus.getSnapshot);
  const name = useNameDialog(store, initialName);
  const link = useCopyLink(code, token);
  useUndoShortcuts(store);

  const { room, names, userId, reactions } = snapshot;
  const story = room.stories.find((entry) => entry.id === room.activeStoryId) ?? null;
  const votes = (story && room.votesByStory.get(story.id)) || EMPTY_VOTES;
  const revealed = story?.revealedAt != null;
  const seats = pokerTableSeats(names, votes, { revealed, viewerId: userId, fallbackName: t('poker.guest') });
  return (
    <div className="rb-poker">
      <PokerHeader snapshot={snapshot} canChangeDeck={canChangeDeck(room)} copied={link.copied}
        onCopyLink={link.copy} onExport={() => exportCsv(room, code)} onRename={() => name.setOpen(true)} actions={store} />
      <main className="rb-poker__body">
        <div className="rb-poker__side">
          <StoryList stories={room.stories} deck={room.deck} activeStoryId={room.activeStoryId}
            onSelect={store.selectStory} onAdd={store.addStories} onRename={store.renameStory} onRemove={store.removeStory} />
          <PlayerList seats={seats} hasStory={story !== null} />
        </div>
        <div className="rb-poker__play">
          <PokerTable seats={seats} deck={room.deck} story={story} onReveal={store.reveal} onReset={store.resetRound}
            onNext={store.nextStory} canNext={story !== null && nextStoryId(room.stories, story.id) !== null}
            reactions={reactions} onReact={name.name ? store.react : undefined} />
          {revealed && (
            <RoundSummary summary={summarizeRound(votes, room.deck)} deck={room.deck} names={names}
              finalEstimate={story.finalEstimate} onAccept={store.acceptEstimate} />
          )}
          {story && (
            <CardHand deck={room.deck} selectedCardId={votes.get(userId) ?? null} locked={revealed} disabled={!name.name}
              onPick={(cardId) => (cardId === null ? store.clearVote() : store.vote(cardId))} />
          )}
        </div>
      </main>
      {name.open && (
        <NameDialog draft={name.draft} onDraftChange={name.setDraft} onSave={name.save} onClose={name.close} hasName={!!name.name} />
      )}
      <SyncStatusBanner state={sync} />
    </div>
  );
}
