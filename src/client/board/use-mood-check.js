import { useCallback, useState, useSyncExternalStore } from 'react';
import { moodCheckAvailable, moodSummary } from '../../domain/mood-check.js';

const NO_ANSWERS = Object.freeze([]);

const hasShowing = (round) => typeof round.resultShownAt === 'number';
const resultShown = (round, summary) => !round.open && summary.count > 0 && hasShowing(round);
/** One admin "show" press; a viewer's local dismissal is keyed by it so a later showing appears again. */
const showingKey = (round) => `${round.id}:${round.resultShownAt}`;

/** What this viewer sees for the room's round; skip and dismiss are this viewer's own choices. */
export function moodCheckView({ round, answers, userId, isAdmin, skippedRound, dismissedShowing }) {
  if (!round) return { open: false, dialogOpen: false, banner: null, result: null, canShowResult: false };
  const summary = moodSummary(answers, round.id);
  const answered = answers.some((answer) => answer.roundId === round.id && answer.userId === userId);
  return {
    open: round.open,
    dialogOpen: round.open && !answered && skippedRound !== round.id,
    banner: round.open ? { count: summary.count, answered, canClose: Boolean(isAdmin) } : null,
    result: resultShown(round, summary) && dismissedShowing !== showingKey(round) ? summary : null,
    canShowResult: Boolean(isAdmin) && !round.open && summary.count > 0 && !hasShowing(round),
  };
}

/**
 * Mood check for the board. Opening, closing, showing and hiding the result are silent meta writes;
 * each answer is the person's own undoable kv write. Skipping the dialog and
 * a member's dismissal of the result are per-viewer and never shared.
 */
export function useMoodCheck({ mode, isAdmin, userId, moodCheck, patchMeta, storage, newRoundId }) {
  const subscribe = useCallback((listener) => {
    storage?.onMoodsChange?.(listener);
    return () => storage?.offMoodsChange?.(listener);
  }, [storage]);
  const readAnswers = () => storage?.snapshotMoods?.() ?? NO_ANSWERS;
  const answers = useSyncExternalStore(subscribe, readAnswers, readAnswers);
  const [skippedRound, setSkippedRound] = useState(null);
  const [dismissedShowing, setDismissedShowing] = useState(null);

  const available = moodCheckAvailable(mode);
  const round = available ? moodCheck ?? null : null;
  const view = moodCheckView({ round, answers, userId, isAdmin, skippedRound, dismissedShowing });

  const start = () => {
    storage?.clearAllMoods?.();
    patchMeta({ moodCheck: { id: newRoundId(), startedAt: Date.now(), open: true } }, { silent: true });
  };
  const writeRound = (next) => patchMeta({ moodCheck: next }, { silent: true });
  // Closing is the admin's "show" press.
  const close = () => writeRound({ ...round, open: false, resultShownAt: Date.now() });
  const showResult = () => { if (view.canShowResult) writeRound({ ...round, resultShownAt: Date.now() }); };
  // The admin hides the card for everyone; anyone else only for themselves.
  const dismissResult = () => {
    if (!round) return;
    if (isAdmin) writeRound({ ...round, resultShownAt: null });
    else setDismissedShowing(showingKey(round));
  };

  return {
    available,
    ...view,
    start,
    close,
    showResult,
    answer: (score) => { if (round?.open) storage?.setMood?.(round.id, userId, score); },
    skip: () => setSkippedRound(round?.id ?? null),
    reopen: () => setSkippedRound(null),
    dismissResult,
  };
}
