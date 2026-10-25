import React, { memo } from 'react';
import { StickyCard } from './StickyCard.jsx';
import { CollaborativeTextEditor } from './CollaborativeTextEditor.jsx';
import { hueFromId } from './player-colors.js';

const EMPTY_COMMENT_PREVIEWS = [];

export const BoardStickyCard = memo(function BoardStickyCard({ item, compact, context }) {
  const voting = context.stickyVotingContext.get(item.id);
  const remoteSelected = context.remoteSelectorsByItem.has(item.id);
  return <StickyCard
    TextEditor={CollaborativeTextEditor}
    item={item}
    selected={context.selectedIds.has(item.id) && !remoteSelected}
    remoteSelected={remoteSelected}
    remoteSelectionHue={hueFromId(context.remoteSelectorsByItem.get(item.id)?.userId || '')}
    isEditing={context.focusedTextId === `${item.id}:text`}
    isOwner={item.authorId === context.userId}
    allRevealed={voting?.revealed ?? context.allRevealed}
    dense={context.denseRender}
    compact={compact}
    voted={context.didUserVoteOn(item.id)}
    voteCount={context.voteCountOf(item.id)}
    voteFlash={context.voteFlashes[item.id] || null}
    voteRank={context.topVotedRanks.get(item.id)}
    votingAllowedNow={voting?.votingAllowedNow ?? false}
    showVoteCount={!(voting?.hideVoteCounts ?? false)}
    inZone={voting?.inZone ?? false}
    commentCount={context.commentCountOf(item.id)}
    commentPreviews={context.commentPreviewsByItem.get(item.id) ?? EMPTY_COMMENT_PREVIEWS}
    lang={context.lang}
    onStartDrag={context.startItemDrag}
    onBeginFocus={context.beginFocus}
    onTextChange={context.onTextChange}
    onTextKeyDown={context.onTextKeyDown}
    onTextBlur={context.onTextBlur}
    onToggleVote={context.toggleVote}
    onOpenComments={context.openComments}
    editAreaRef={context.editAreaRef}
  />;
});
