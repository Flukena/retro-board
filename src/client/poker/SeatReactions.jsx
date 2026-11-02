import React, { useState } from 'react';
import { SmilePlus } from 'lucide-react';
import { IconButton } from '../ui/UiPrimitives.jsx';
import { t } from '../ui/i18n.js';
import { POKER_REACTIONS, POKER_REACTION_TTL_MS } from '../../domain/poker-reactions.js';

const ICON_SIZE_PX = 14;
// The float-and-fade animation lasts exactly as long as the reaction is live.
const REACTION_STYLE = Object.freeze({ '--rb-poker-reaction-ms': `${POKER_REACTION_TTL_MS}ms` });

// Emoji floating up from a seat. A new key restarts the animation.
export function FloatingReactions({ reactions }) {
  if (!reactions?.length) return null;
  return (
    <span className="rb-poker-seat__reactions" aria-hidden="true">
      {reactions.map(({ key, emoji }) => <span key={key} className="rb-poker-reaction" style={REACTION_STYLE}>{emoji}</span>)}
    </span>
  );
}

// Tap the smile under someone's seat, then an emoji, to react to their card.
export function ReactionPicker({ name, onReact }) {
  const [open, setOpen] = useState(false);
  const label = t('poker.react.open', { name });
  return (
    <div className="rb-poker-react">
      <IconButton className="rb-poker-react__toggle" aria-label={label} title={label} aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        <SmilePlus size={ICON_SIZE_PX} aria-hidden="true" />
      </IconButton>
      {open && (
        <div className="rb-poker-react__menu" role="group" aria-label={label}>
          {POKER_REACTIONS.map((emoji) => (
            <button key={emoji} type="button" className="rb-poker-react__emoji" aria-label={t('poker.react.send', { emoji })}
              onClick={() => { onReact(emoji); setOpen(false); }}>
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
