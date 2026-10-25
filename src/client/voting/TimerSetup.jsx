import React, { useState } from 'react';
import { ThumbsUp } from 'lucide-react';
import { Button, ChoiceChip, portalToBody } from '../ui/UiPrimitives.jsx';
import { ModalShell } from '../ui/ModalShell.jsx';
import { BUTTON_VARIANT, MODAL_SIZE } from '../ui/ui-variants.js';
import { t } from '../ui/i18n.js';
import {
  TIMER_PRESETS, VOTE_LIMIT_PRESETS, TIMER_MIN_MINUTES, TIMER_MAX_MINUTES,
  VOTE_LIMIT_MIN_VOTES, VOTE_LIMIT_MAX_VOTES, TIMER_DEFAULT_MINUTES, VOTE_LIMIT_DEFAULT_VOTES,
  clampTimerMinutes, clampVoteLimit, timerSetupArguments,
} from '../../domain/vote-timing.js';
import './timer-setup.css';

const SETUP_ICON_SIZE_PX = 16;

function SetupCheckbox({ checked, onChange, label }) {
  return (
    <label className="rb-timer-setup__checkbox">
      <input
        className="rb-input"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

function SetupNumber({ label, unlimitedLabel, unlimited, onUnlimited, value, onValue,
  presets, min, max, formatPreset }) {
  return (
    <>
      <div className="rb-timer-setup__row">
        <span>{label}</span>
        <SetupCheckbox checked={unlimited} onChange={onUnlimited} label={unlimitedLabel} />
      </div>
      <div
        className={unlimited
          ? 'rb-timer-setup__presets rb-timer-setup__presets--disabled'
          : 'rb-timer-setup__presets'}
      >
        {presets.map((preset) => (
          <ChoiceChip key={preset} selected={value === preset} onClick={() => onValue(preset)}>
            {formatPreset(preset)}
          </ChoiceChip>
        ))}
        <input
          className="rb-input rb-timer-setup__number"
          type="number"
          aria-label={label}
          min={min}
          max={max}
          value={value}
          onChange={(event) => onValue(event.target.value)}
        />
      </div>
    </>
  );
}

const minutesPresetLabel = (minutes) => t('vote.setup.minutesPreset', { n: minutes });
const votePresetLabel = (votes) => votes;

export function TimerSetup({ onClose, onStart, nestedZoneCount }) {
  const [minutes, setMinutes] = useState(TIMER_DEFAULT_MINUTES);
  const [noTimeLimit, setNoTimeLimit] = useState(false);
  const [votes, setVotes] = useState(VOTE_LIMIT_DEFAULT_VOTES);
  const [unlimitedVotes, setUnlimitedVotes] = useState(false);
  const [hideResults, setHideResults] = useState(true);
  const [showNonVoters, setShowNonVoters] = useState(false);
  const submit = () => onStart(...timerSetupArguments({
    minutes, votes, noTimeLimit, unlimitedVotes, hideResults, showNonVoters,
  }));
  const content = (
    <ModalShell
      className="rb-timer-setup"
      size={MODAL_SIZE.MD}
      labelledBy="vote-dialog-title"
      onDismiss={onClose}
      data-board-shortcuts="off"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="rb-timer-setup__header">
        <ThumbsUp size={SETUP_ICON_SIZE_PX} color="var(--accent)" />
        <strong id="vote-dialog-title">{t('vote.setup.head')}</strong>
      </div>
      {nestedZoneCount > 0 && (
        <div className="rb-timer-setup__nested">
          {t('vote.session.coversNested', { n: nestedZoneCount })}
        </div>
      )}
      <SetupNumber
        label={t('vote.setup.duration')}
        unlimitedLabel={t('vote.setup.unlimitedTime')}
        unlimited={noTimeLimit}
        onUnlimited={setNoTimeLimit}
        value={minutes}
        onValue={(value) => setMinutes(clampTimerMinutes(value))}
        presets={TIMER_PRESETS}
        min={TIMER_MIN_MINUTES}
        max={TIMER_MAX_MINUTES}
        formatPreset={minutesPresetLabel}
      />
      <SetupNumber
        label={t('vote.setup.voteLimit')}
        unlimitedLabel={t('vote.setup.unlimitedVotes')}
        unlimited={unlimitedVotes}
        onUnlimited={setUnlimitedVotes}
        value={votes}
        onValue={(value) => setVotes(clampVoteLimit(value))}
        presets={VOTE_LIMIT_PRESETS}
        min={VOTE_LIMIT_MIN_VOTES}
        max={VOTE_LIMIT_MAX_VOTES}
        formatPreset={votePresetLabel}
      />
      <div className="rb-timer-setup__options">
        <SetupCheckbox checked={hideResults} onChange={setHideResults} label={t('vote.setup.hideResults')} />
        <SetupCheckbox
          checked={showNonVoters}
          onChange={setShowNonVoters}
          label={t('vote.setup.showNonVoters')}
        />
      </div>
      <Button variant={BUTTON_VARIANT.PRIMARY} className="rb-btn--block" onClick={submit}>
        {t('vote.setup.start')}
      </Button>
    </ModalShell>
  );
  return portalToBody(content);
}
