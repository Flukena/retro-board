import React, { useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../ui/UiPrimitives.jsx';
import { ICON_BUTTON_VARIANT } from '../ui/ui-variants.js';
import { t } from '../ui/i18n.js';
import { MAX_STORY_TITLE_CHARS, storyTitlesFromText } from '../../domain/poker-schema.js';
import { cardLabel } from './poker-format.js';

const ICON_SIZE_PX = 14;
const STORY_INPUT_ROWS = 3;

function AddStories({ count, onAdd }) {
  const [draft, setDraft] = useState('');
  const titles = storyTitlesFromText(draft, count);
  const submit = () => {
    if (!titles.length) return;
    onAdd(titles);
    setDraft('');
  };
  return (
    <div className="rb-poker-stories__add">
      <textarea
        className="rb-input rb-poker-stories__input"
        rows={STORY_INPUT_ROWS}
        value={draft}
        aria-label={t('poker.stories.placeholder')}
        placeholder={t('poker.stories.placeholder')}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(); }}
      />
      <Button disabled={!titles.length} onClick={submit}>{t('poker.stories.add')}</Button>
    </div>
  );
}

function StoryTitleEditor({ story, onRename, onDone }) {
  const [draft, setDraft] = useState(story.title);
  const finish = (save) => {
    if (save) onRename(story.id, draft);
    onDone();
  };
  return (
    <input
      className="rb-input rb-poker-story__edit"
      autoFocus
      value={draft}
      maxLength={MAX_STORY_TITLE_CHARS}
      aria-label={t('poker.stories.title')}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(true);
        if (event.key === 'Escape') finish(false);
      }}
    />
  );
}

function StoryRow({ story, deck, active, onSelect, onRename, onRemove }) {
  const [editing, setEditing] = useState(false);
  const final = story.finalEstimate === null ? null : cardLabel(deck, story.finalEstimate);
  return (
    <li className={active ? 'rb-poker-story rb-poker-story--active' : 'rb-poker-story'}>
      {editing
        ? <StoryTitleEditor story={story} onRename={onRename} onDone={() => setEditing(false)} />
        : (
          <button type="button" className="rb-poker-story__select" aria-current={active || undefined} onClick={() => onSelect(story.id)}>
            {story.title}
          </button>
        )}
      {final !== null && <span className="rb-poker-story__final" title={t('poker.stories.final', { value: final })}>{final}</span>}
      <IconButton aria-label={t('poker.stories.rename')} title={t('poker.stories.rename')} onClick={() => setEditing(true)}>
        <Pencil size={ICON_SIZE_PX} aria-hidden="true" />
      </IconButton>
      <IconButton variant={ICON_BUTTON_VARIANT.DANGER} aria-label={t('poker.stories.remove')} title={t('poker.stories.remove')} onClick={() => onRemove(story.id)}>
        <Trash2 size={ICON_SIZE_PX} aria-hidden="true" />
      </IconButton>
    </li>
  );
}

export function StoryList({ stories, deck, activeStoryId, onSelect, onAdd, onRename, onRemove }) {
  return (
    <section className="rb-poker-stories" aria-labelledby="poker-stories-head">
      <h2 id="poker-stories-head" className="rb-poker-stories__head">{t('poker.stories.head')}</h2>
      <AddStories count={stories.length} onAdd={onAdd} />
      {stories.length === 0
        ? <p className="rb-poker-stories__empty">{t('poker.stories.empty')}</p>
        : (
          <ol className="rb-poker-stories__list">
            {stories.map((story) => (
              <StoryRow key={story.id} story={story} deck={deck} active={story.id === activeStoryId}
                onSelect={onSelect} onRename={onRename} onRemove={onRemove} />
            ))}
          </ol>
        )}
    </section>
  );
}
