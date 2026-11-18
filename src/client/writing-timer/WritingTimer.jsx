import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Square, Timer } from 'lucide-react';
import { Button, ChoiceChip, IconButton, Surface } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT, ICON_BUTTON_VARIANT } from '../ui/ui-variants.js';
import { useDismiss } from '../ui/useDismiss.js';
import { t } from '../ui/i18n.js';
import { CHROME_ICON_SIZE_PX } from '../chrome/chrome-layout.js';
import { TIMER_MAX_MINUTES, TIMER_MIN_MINUTES, clampTimerMinutes } from '../../domain/countdown.js';
import {
  WRITING_TIMER_EXTEND_MINUTES, WRITING_TIMER_PHASE, WRITING_TIMER_PRESET_MINUTES, writingTimerTickMs,
} from '../../domain/writing-timer.js';
import { createChime } from './chime.js';
import { watchWritingTimer } from './writing-timer-store.js';
import '../ui/chrome-animations.css';
import './writing-timer.css';

// The storage bridge opens the store for retro boards only, so the Public Wall (and Poker) render nothing here.
const boardWritingTimer = () => (typeof window === 'undefined' ? null : window.storage?.writingTimer ?? null);
const DEFAULT_CUSTOM_MINUTES = WRITING_TIMER_PRESET_MINUTES[0];

/** What this page shows now; re-reads on every shared change and whenever the shown second changes. */
function useWritingTimerView(store) {
  const [view, setView] = useState(() => store.view());
  const chime = useMemo(() => createChime(), []);
  useEffect(() => watchWritingTimer(store, setView), [store]);
  useEffect(() => {
    const delayMs = writingTimerTickMs(view);
    if (delayMs === null) return undefined;
    const tick = setTimeout(() => {
      if (store.takeExpiry()) chime.play();
      setView(store.view());
    }, delayMs);
    return () => clearTimeout(tick);
  }, [store, chime, view]);
  return view;
}

/** The admin's choices: a preset starts at once; a custom number starts with Start. */
export function WritingTimerSetup({ minutes, onMinutes, onStart }) {
  return (
    <Surface className="rb-writing-timer-setup" role="dialog" aria-label={t('writingTimer.open')} data-board-shortcuts="off">
      <div className="rb-writing-timer-setup__presets">
        {WRITING_TIMER_PRESET_MINUTES.map((preset) => (
          <ChoiceChip key={preset} selected={false} onClick={() => onStart(preset)}>
            {t('writingTimer.minutes', { n: preset })}
          </ChoiceChip>
        ))}
      </div>
      <div className="rb-writing-timer-setup__custom">
        <input
          className="rb-input rb-writing-timer-setup__number"
          type="number"
          aria-label={t('writingTimer.custom')}
          min={TIMER_MIN_MINUTES}
          max={TIMER_MAX_MINUTES}
          value={minutes}
          onChange={(event) => onMinutes(clampTimerMinutes(event.target.value))}
        />
        <Button variant={BUTTON_VARIANT.PRIMARY} onClick={() => onStart(minutes)}>{t('writingTimer.start')}</Button>
      </div>
    </Surface>
  );
}

function TimerStarter({ store }) {
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState(DEFAULT_CUSTOM_MINUTES);
  const rootRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, rootRef, close);
  const start = (chosen) => {
    store.start(chosen);
    setOpen(false);
  };
  return (
    <div ref={rootRef} className="rb-writing-timer-start">
      {open && <WritingTimerSetup minutes={minutes} onMinutes={setMinutes} onStart={start} />}
      <IconButton
        className="rb-writing-timer-start__toggle"
        aria-label={t('writingTimer.open')}
        title={t('writingTimer.open')}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Timer size={CHROME_ICON_SIZE_PX.TIMER} />
      </IconButton>
    </div>
  );
}

/** The shared countdown, with +1 and stop for an admin. */
export function RunningTimer({ view, store, isAdmin }) {
  return (
    <>
      <Timer size={CHROME_ICON_SIZE_PX.TIMER} aria-hidden="true" />
      <span className="rb-writing-timer__time">{view.label}</span>
      {isAdmin && (
        <>
          <Button className="rb-writing-timer__extend" onClick={() => store.extend()}>
            {t('topbar.extend', { n: WRITING_TIMER_EXTEND_MINUTES })}
          </Button>
          <IconButton
            variant={ICON_BUTTON_VARIANT.DANGER}
            aria-label={t('writingTimer.stop')}
            title={t('writingTimer.stop')}
            onClick={() => store.stop()}
          >
            <Square size={CHROME_ICON_SIZE_PX.SMALL} />
          </IconButton>
        </>
      )}
    </>
  );
}

function SharedTimer({ store, isAdmin }) {
  const view = useWritingTimerView(store);
  if (view.phase === WRITING_TIMER_PHASE.IDLE) return isAdmin ? <TimerStarter store={store} /> : null;
  const running = view.phase === WRITING_TIMER_PHASE.RUNNING;
  return (
    <div
      className={view.urgent ? 'rb-writing-timer rb-writing-timer--urgent' : 'rb-writing-timer'}
      data-phase={view.phase}
      role="timer"
      aria-label={t('writingTimer.left')}
    >
      {running
        ? <RunningTimer view={view} store={store} isAdmin={isAdmin} />
        : <span className="rb-writing-timer__time">{t('writingTimer.timesUp')}</span>}
    </div>
  );
}

/** The board's card-writing countdown at the bottom centre; admins start, extend and stop it. */
export function WritingTimer({ isAdmin, store = boardWritingTimer() }) {
  return store ? <SharedTimer store={store} isAdmin={isAdmin} /> : null;
}
