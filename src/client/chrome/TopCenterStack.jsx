import React, { useState } from 'react';
import { LocateFixed, X } from 'lucide-react';
import { Button } from '../ui/UiPrimitives.jsx';
import { visibleVoteResultZones, dismissResult, resultDismissalStorage } from '../voting/vote-results-dismissal.js';
import { VoteResultsCards } from '../voting/VoteResultsCard.jsx';
import { TimerDock } from '../voting/TimerDock.jsx';
import {
  TOPBAR_BOTTOM_PX, TOP_STACK_GAP_PX, TOP_STACK_ITEM_GAP_PX, FOLLOW_BANNER_H_PX, CHROME_ICON_SIZE_PX, Z,
} from './chrome-layout.js';
import { playerAccentColor } from '../board/player-colors.js';
import { t } from '../ui/i18n.js';
import './top-center-stack.css';
import '../ui/chrome-animations.css';

function FollowBanner({ follow, onStopFollowing }) {
  return (
    <div
      role="status"
      className="rb-follow-banner"
      style={{ '--rb-follow-banner-height': `${FOLLOW_BANNER_H_PX}px` }}
    >
      <LocateFixed
        size={CHROME_ICON_SIZE_PX.TOOL}
        color={playerAccentColor(follow.hue)}
      />
      <span className="rb-follow-name">{t('follow.active', { name: follow.name })}</span>
      {follow.waiting && <span className="rb-follow-waiting">{t('follow.waiting')}</span>}
      <Button
        className="rb-btn--icon-sm rb-btn--pill"
        onClick={onStopFollowing}
        title={t('follow.stop')}
        aria-label={t('follow.stop')}
      >
        <X size={CHROME_ICON_SIZE_PX.SMALL} />
      </Button>
    </div>
  );
}

export function TopCenterStack({
  board = { items: [] }, roomHandle, userId, now, follow, timers, votesUsed, isAdmin, onStopFollowing, onExtendTimer, onStopTimer,
}) {
  const [, refreshDismissals] = useState(0);
  const storage = resultDismissalStorage();
  const zones = visibleVoteResultZones(board.items, storage, roomHandle);
  const onDismiss = (resultId) => {
    if (dismissResult(storage, roomHandle, resultId)) refreshDismissals((revision) => revision + 1);
  };
  if (!follow && !timers.length && !zones.length) return null;
  return (
    <div
      className="rb-top-center-stack"
      style={{
        '--rb-top-stack-top-px': `${TOPBAR_BOTTOM_PX + TOP_STACK_GAP_PX}px`, zIndex: Z.TOP_CENTER_STACK,
        '--rb-top-stack-item-gap': `${TOP_STACK_ITEM_GAP_PX}px`,
      }}
    >
      <VoteResultsCards zones={zones} board={board} userId={userId} now={now} onDismiss={onDismiss} />
      {follow && <FollowBanner follow={follow} onStopFollowing={onStopFollowing} />}
      {timers.map((timer) => (
        <TimerDock
          key={timer.zoneId}
          timer={timer}
          votesUsed={votesUsed}
          isAdmin={isAdmin}
          onExtendTimer={onExtendTimer}
          onStopTimer={onStopTimer}
        />
      ))}
    </div>
  );
}
