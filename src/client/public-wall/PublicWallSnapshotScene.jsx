import React from 'react';
import { ZoneCard } from '../board/ZoneCard.jsx';
import { StickyCard } from '../board/StickyCard.jsx';
import { TextCard } from '../board/TextCard.jsx';
import { ImageCard } from '../board/ImageCard.jsx';
import { BOARD_MODE } from '../../domain/public-wall-contract.js';
import { publicWallScene } from './public-wall-view.js';
import { gridBackgroundForZoom } from '../board/grid-background.js';
import '../board/public-wall.css';

const ignoreMutation = () => undefined;
const EMPTY_COMMENT_PREVIEWS = Object.freeze([]);
const READ_ONLY_EVENTS = Object.freeze({
  onStartDrag: ignoreMutation, onStartZoneDrag: ignoreMutation, onBeginFocus: ignoreMutation,
  onTextChange: ignoreMutation, onTextKeyDown: ignoreMutation, onTextBlur: ignoreMutation,
  onToggleVote: ignoreMutation, onOpenComments: ignoreMutation,
});
const READ_ONLY_ZONE_ACTIONS = Object.freeze({
  color: ignoreMutation, fontSize: ignoreMutation, toggleLock: ignoreMutation,
  toggleReveal: ignoreMutation, vote: ignoreMutation, exportCsv: ignoreMutation,
  saveTemplate: ignoreMutation, remove: ignoreMutation, bringToFront: ignoreMutation,
  sendToBack: ignoreMutation, closeTimerSetup: ignoreMutation, startTimer: ignoreMutation,
});

function SnapshotCard({ item, childCount, lang }) {
  const props = { item, lang, selected: false, isEditing: false, ...READ_ONLY_EVENTS };
  if (item.type === 'image') return <ImageCard {...props} publicPreview remoteSelected={false} />;
  if (item.type === 'zone') return <ZoneCard {...props} mode={BOARD_MODE.PUBLIC}
    isEditingTitle={false} isAdmin={false} canEdit={false} canDelete={false}
    childCount={childCount} nestedZoneCount={0} revealed={false} hasVoteTimer={false}
    timerSetupOpen={false} actions={READ_ONLY_ZONE_ACTIONS} />;
  if (item.type === 'sticky') return <StickyCard {...props} remoteSelected={false}
    isOwner={false} allRevealed={false} compact={false} voted={false}
    voteCount={0} votingAllowedNow={false} showVoteCount={false} inZone={false}
    commentCount={0} commentPreviews={EMPTY_COMMENT_PREVIEWS} />;
  return <TextCard {...props} remoteSelected={false} />;
}

export function PublicWallSnapshotScene({ snapshot, sceneRef, lang }) {
  const scene = publicWallScene(snapshot);
  const { x, y, zoom } = scene.viewport;
  return (
    <div ref={sceneRef} className="rb-public-wall__scene" inert="" aria-hidden="true" data-item-count={scene.items.length}
      style={{ width: scene.width, height: scene.height, ...gridBackgroundForZoom(zoom),
        backgroundPosition: `${x}px ${y}px` }}>
      <div className="rb-public-wall__world" style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})` }}>
        {scene.items.map(item => <SnapshotCard key={item.id} item={item} lang={lang}
          childCount={scene.childCounts.get(item.id) || 0} />)}
      </div>
    </div>
  );
}
