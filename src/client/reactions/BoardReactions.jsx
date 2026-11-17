import React from 'react';
import { ReactionPicker } from './ReactionPicker.jsx';
import { ReactionOverlay } from './ReactionOverlay.jsx';

// The storage bridge opens a channel for retro boards only, so the Public Wall (and Poker) render nothing here.
const boardReactionChannel = () => (typeof window === 'undefined' ? null : window.storage?.boardReactions ?? null);

export function BoardReactions({ channel = boardReactionChannel() }) {
  if (!channel) return null;
  return (
    <>
      <ReactionPicker channel={channel} />
      <ReactionOverlay channel={channel} />
    </>
  );
}
