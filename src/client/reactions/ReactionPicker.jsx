import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SmilePlus } from 'lucide-react';
import { Button, Surface } from '../ui/UiPrimitives.jsx';
import { topBarButtonVariant } from '../ui/ui-variants.js';
import { useDismiss } from '../ui/useDismiss.js';
import { t } from '../ui/i18n.js';
import { CHROME_ICON_SIZE_PX } from '../chrome/chrome-layout.js';
import { BOARD_REACTIONS, FIREWORKS_REACTION } from '../../domain/board-reactions.js';
import './reactions.css';

export const reactionLabel = (emoji) => (emoji === FIREWORKS_REACTION
  ? t('reaction.fireworks') : t('reaction.send', { emoji }));

/** The six reactions. While `cooling`, clicks still reach `onSend`; the channel's rate limit drops them. */
export function ReactionMenu({ cooling, onSend }) {
  return (
    <Surface className="rb-reaction-picker" role="group" aria-label={t('reaction.picker')} data-board-shortcuts="off">
      {BOARD_REACTIONS.map((emoji) => (
        <Button key={emoji} className="rb-reaction-picker__emoji" aria-label={reactionLabel(emoji)}
          title={reactionLabel(emoji)} disabledLook={cooling} onClick={() => onSend(emoji)}>
          {emoji}
        </Button>
      ))}
    </Surface>
  );
}

/** The add-reaction button: a chrome icon button like the zoom controls, shown pressed while the picker is open. */
export function ReactionToggle({ open, onToggle }) {
  const label = t('reaction.open');
  return (
    <Button variant={topBarButtonVariant({ active: open })} className="rb-btn--icon-sm rb-reaction-toggle"
      aria-label={label} title={label} aria-expanded={open} onClick={onToggle}>
      <SmilePlus size={CHROME_ICON_SIZE_PX.TOOL} aria-hidden="true" />
    </Button>
  );
}

/** True for the rest of a send cooldown so the menu can show it; its timer is cleared on unmount. */
function useCooldown() {
  const [cooling, setCooling] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const start = useCallback((remainingMs) => {
    clearTimeout(timer.current);
    setCooling(remainingMs > 0);
    if (remainingMs > 0) timer.current = setTimeout(() => setCooling(false), remainingMs);
  }, []);
  return [cooling, start];
}

/** The add-reaction button under the tool rail and its picker, which stays open for more sends until dismissed. */
export function ReactionPicker({ channel }) {
  const [open, setOpen] = useState(false);
  const [cooling, startCooldown] = useCooldown();
  const rootRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, rootRef, close);
  const send = (emoji) => {
    channel.send(emoji);
    startCooldown(channel.cooldownMs());
  };
  return (
    <div ref={rootRef} className="rb-reaction-dock">
      {open && <ReactionMenu cooling={cooling} onSend={send} />}
      <ReactionToggle open={open} onToggle={() => setOpen((value) => !value)} />
    </div>
  );
}
