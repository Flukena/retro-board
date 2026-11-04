import React from 'react';
import { Check, ChevronRight, Eye, ListTodo, Lock, ThumbsUp, Unlock } from 'lucide-react';
import { PHASE_SHORTCUT } from '../../domain/retro-phase.js';
import { Button } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT } from '../ui/ui-variants.js';
import { CHROME_ICON_SIZE_PX, FOLLOW_BANNER_H_PX } from '../chrome/chrome-layout.js';
import { t } from '../ui/i18n.js';
import { PHASE_STEP_STATE } from './phase-bar-model.js';
import './phase-bar.css';

const SHORTCUT_VIEW = Object.freeze({
  [PHASE_SHORTCUT.UNLOCK]: { Icon: Unlock, label: () => t('phase.do.unlock') },
  [PHASE_SHORTCUT.REVEAL]: { Icon: Eye, label: (shortcut) => t('phase.do.reveal', { n: shortcut.zoneIds.length }) },
  [PHASE_SHORTCUT.VOTE]: { Icon: ThumbsUp, label: () => t('phase.do.vote') },
  [PHASE_SHORTCUT.LOCK]: { Icon: Lock, label: () => t('phase.do.lock') },
  [PHASE_SHORTCUT.ACTIONS]: { Icon: ListTodo, label: () => t('phase.do.actions') },
});

function PhaseShortcut({ shortcut, onShortcut }) {
  const { Icon, label } = SHORTCUT_VIEW[shortcut.kind];
  const text = label(shortcut);
  return (
    <Button className="rb-btn--pill" title={text} onClick={() => onShortcut(shortcut)}>
      <Icon size={CHROME_ICON_SIZE_PX.SMALL} /> {text}
    </Button>
  );
}

/** Meeting phase steps with elapsed time; the admin also gets the suggested action and Next. */
export function PhaseBar({ bar, onShortcut, onAdvance }) {
  const advanceLabel = bar.isLast ? t('phase.finish') : t('phase.next');
  const AdvanceIcon = bar.isLast ? Check : ChevronRight;
  const zoneLabel = bar.zoneTitle == null ? null : bar.zoneTitle || t('export.csv.untitledZone');
  return (
    <div role="status" aria-label={t('phase.title')} className="rb-follow-banner"
      style={{ '--rb-follow-banner-height': `${FOLLOW_BANNER_H_PX}px` }}>
      {zoneLabel && <span className="rb-phase-zone" title={zoneLabel}>{zoneLabel}</span>}
      <ol className="rb-phase-steps">
        {bar.steps.map((step) => (
          <li key={step.id} className={`rb-phase-step rb-phase-step--${step.state}`}
            aria-current={step.state === PHASE_STEP_STATE.CURRENT ? 'step' : undefined}>
            {t(`phase.${step.id}`)}
          </li>
        ))}
      </ol>
      <span className="rb-phase-elapsed">{t('phase.elapsed', { n: bar.elapsedMinutes })}</span>
      {bar.shortcut && <PhaseShortcut shortcut={bar.shortcut} onShortcut={onShortcut} />}
      {bar.canAdvance && (
        <Button className="rb-btn--pill" variant={BUTTON_VARIANT.PRIMARY} title={advanceLabel} onClick={onAdvance}>
          {advanceLabel} <AdvanceIcon size={CHROME_ICON_SIZE_PX.SMALL} />
        </Button>
      )}
    </div>
  );
}
