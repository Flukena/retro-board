import React from 'react';
import { Clock, ThumbsUp, Square } from 'lucide-react';
import { Button, Divider } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT, DIVIDER_ORIENTATION } from '../ui/ui-variants.js';
import { TIMER_EXTEND_MINUTES } from '../../domain/vote-timing.js';
import { CHROME_ICON_SIZE_PX, TIMER_DOCK_H_PX } from '../chrome/chrome-layout.js';
import { t } from '../ui/i18n.js';
import './timer-dock.css';
import '../ui/chrome-animations.css';

function TimerAdminActions({ zoneId, onExtendTimer, onStopTimer }) {
  return (
    <>
      <Divider orientation={DIVIDER_ORIENTATION.VERTICAL} />
      {TIMER_EXTEND_MINUTES.map((minutes) => (
        <Button
          key={minutes}
          title={t('topbar.extend', { n: minutes })}
          onClick={() => onExtendTimer(zoneId, minutes)}
        >
          {t('topbar.extend', { n: minutes })}
        </Button>
      ))}
      <Divider orientation={DIVIDER_ORIENTATION.VERTICAL} />
      <Button
        variant={BUTTON_VARIANT.DANGER}
        title={t('topbar.stopVote')}
        onClick={() => onStopTimer(zoneId)}
      >
        <Square size={CHROME_ICON_SIZE_PX.SMALL} /> {t('topbar.stopVote')}
      </Button>
    </>
  );
}

export function TimerDock({ timer, votesUsed, isAdmin, onExtendTimer, onStopTimer }) {
  const TimerIcon = timer.remainingMs == null ? ThumbsUp : Clock;
  return (
    <div
      className={`rb-timer-dock${timer.urgent ? ' rb-timer-dock--urgent' : ''}`}
      style={{ '--rb-timer-dock-height': `${TIMER_DOCK_H_PX}px` }}
    >
      <span className="rb-timer-title">{timer.title || t('export.csv.untitledZone')}</span>
      <div className="rb-timer-clock">
        <TimerIcon size={CHROME_ICON_SIZE_PX.TIMER} />
        <span>{timer.label ?? t('vote.banner.open')}</span>
      </div>
      <span className="rb-timer-votes">
        {timer.voteLimit != null
          ? t('vote.banner.votesUsed', { used: votesUsed, limit: timer.voteLimit })
          : t('vote.banner.unlimited')}
      </span>
      {isAdmin && (
        <TimerAdminActions
          zoneId={timer.zoneId}
          onExtendTimer={onExtendTimer}
          onStopTimer={onStopTimer}
        />
      )}
    </div>
  );
}
