import { useCallback, useState, useSyncExternalStore } from 'react';
import { moodCheckAvailable, moodSummary } from '../../domain/mood-check.js';

const NO_ANSWERS = Object.freeze([]);

/** What this viewer sees for the room's round; skip and dismiss are this viewer's own choices. */
export function moodCheckView({ round, answers, userId, isAdmin, skippedRound, dismissedRound }) {
  if (!round) return { open: false, dialogOpen: false, banner: null, result: null };
  const summary = moodSummary(answers, round.id);
  const answered = answers.some((answer) => answer.roundId === round.id && answer.userId === userId);
  return {
    open: round.open,
    dialogOpen: round.open && !answered && skippedRound !== round.id,
    banner: round.open ? { count: summary.count, answered, canClose: Boolean(isAdmin) } : null,
    result: !round.open && summary.count > 0 && dismissedRound !== round.id ? summary : null,
  };
}

/**
 * Mood check for the board. Opening and closing a round is a silent meta write;
 * each answer is the person's own undoable kv write. Skipping the dialog and
 * dismissing the result are per-viewer and never shared.
 */
export function useMoodCheck({ mode, isAdmin, userId, moodCheck, patchMeta, storage, newRoundId }) {
  const subscribe = useCallback((listener) => {
    storage?.onMoodsChange?.(listener);
    return () => storage?.offMoodsChange?.(listener);
  }, [storage]);
  const readAnswers = () => storage?.snapshotMoods?.() ?? NO_ANSWERS;
  const answers = useSyncExternalStore(subscribe, readAnswers, readAnswers);
  const [skippedRound, setSkippedRound] = useState(null);
  const [dismissedRound, setDismissedRound] = useState(null);

  const available = moodCheckAvailable(mode);
  const round = available ? moodCheck ?? null : null;
  const view = moodCheckView({ round, answers, userId, isAdmin, skippedRound, dismissedRound });

  const start = () => {
    storage?.clearAllMoods?.();
    patchMeta({ moodCheck: { id: newRoundId(), startedAt: Date.now(), open: true } }, { silent: true });
  };
  const close = () => patchMeta({ moodCheck: { ...round, open: false } }, { silent: true });

  return {
    available,
    ...view,
    start,
    close,
    answer: (score) => { if (round?.open) storage?.setMood?.(round.id, userId, score); },
    skip: () => setSkippedRound(round?.id ?? null),
    reopen: () => setSkippedRound(null),
    dismissResult: () => setDismissedRound(round?.id ?? null),
  };
}
