import React from 'react';
import { Download, Link2, Redo2, Undo2, UserRound } from 'lucide-react';
import { LanguagePicker } from '../ui/LanguagePicker.jsx';
import { Button, IconButton } from '../ui/UiPrimitives.jsx';
import { t, useLang } from '../ui/i18n.js';
import { POKER_DECKS } from '../../domain/poker-deck.js';
import { deckNameKey } from './poker-format.js';

const ICON_SIZE_PX = 16;

function DeckSelect({ deckId, canChange, onChange }) {
  return (
    <label className="rb-poker-header__deck" title={canChange ? undefined : t('poker.deck.locked')}>
      <span>{t('poker.deck.label')}</span>
      <select className="rb-input" value={deckId} disabled={!canChange} onChange={(event) => onChange(event.target.value)}>
        {POKER_DECKS.map((deck) => <option key={deck.id} value={deck.id}>{t(deckNameKey(deck.id))}</option>)}
      </select>
    </label>
  );
}

export function PokerHeader({ snapshot, canChangeDeck, copied, onCopyLink, onExport, onRename, actions }) {
  useLang();
  return (
    <header className="rb-poker-header">
      <a className="rb-poker-header__brand" href="/">{t('poker.title')}</a>
      <DeckSelect deckId={snapshot.room.deckId} canChange={canChangeDeck} onChange={actions.setDeck} />
      <div className="rb-poker-header__tools">
        <IconButton aria-label={t('topbar.undo')} title={t('topbar.undo')} disabled={!snapshot.canUndo} onClick={actions.undo}>
          <Undo2 size={ICON_SIZE_PX} aria-hidden="true" />
        </IconButton>
        <IconButton aria-label={t('topbar.redo')} title={t('topbar.redo')} disabled={!snapshot.canRedo} onClick={actions.redo}>
          <Redo2 size={ICON_SIZE_PX} aria-hidden="true" />
        </IconButton>
        <Button onClick={onExport} disabled={!snapshot.room.stories.length}>
          <Download size={ICON_SIZE_PX} aria-hidden="true" />{t('poker.export')}
        </Button>
        <Button onClick={onRename} title={t('poker.changeName')}>
          <UserRound size={ICON_SIZE_PX} aria-hidden="true" />{t('poker.changeName')}
        </Button>
        <LanguagePicker />
        <Button onClick={onCopyLink} title={t('topbar.copyLink')}>
          <Link2 size={ICON_SIZE_PX} aria-hidden="true" />{copied ? t('topbar.copied') : t('topbar.copyLink')}
        </Button>
      </div>
    </header>
  );
}
