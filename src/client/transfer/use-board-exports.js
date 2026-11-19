import { useCallback, useState } from 'react';
import { buildRetroSummary } from '../../domain/retro-summary.js';
import { moodSummary } from '../../domain/mood-check.js';
import { createBoardExport, createCsvBoardExport } from './board-transfer.js';
import { exportFileName } from './board-backup.js';
import { backupDoneNotice } from './export-notice.js';
import { downloadArtifact } from './browser-download.js';
import { copyTextToClipboard } from './clipboard.js';
import { PNG_MIME_TYPE, renderBoardImage } from './board-image-export.js';
import { PDF_MIME_TYPE } from './pdf-image-document.js';
import { formatActionDue } from '../board/action-item-format.js';
import { getLang, t } from '../ui/i18n.js';

const MARKDOWN_MIME_TYPE = 'text/markdown;charset=utf-8';
const SUMMARY_DATE_FORMAT = Object.freeze({ dateStyle: 'medium' });
const IMAGE_EXTENSION = Object.freeze({ [PNG_MIME_TYPE]: 'png', [PDF_MIME_TYPE]: 'pdf' });

const liveVotes = () => window.storage?.snapshotVotes?.() || new Map();
// Only a closed round is reported; an open one is still collecting answers.
const closedMood = (moodCheck) => (moodCheck && !moodCheck.open
  ? moodSummary(window.storage?.snapshotMoods?.() || [], moodCheck.id) : null);

export function summaryLabels() {
  return {
    untitledBoard: t('summary.untitledBoard'), date: t('summary.date'), participants: t('summary.participants'),
    topVoted: t('summary.topVoted'), cards: t('summary.cards'), untitledZone: t('export.csv.untitledZone'),
    unassigned: t('export.csv.unassigned'), actionItems: t('action.title'), noActionItems: t('action.empty'),
    hiddenCard: t('action.hiddenCard'), emptyCard: t('action.emptyCard'),
    votes: n => t('summary.votes', { n }), hiddenCount: n => t('summary.hiddenCount', { n }),
    mood: t('mood.result'), moodScore: score => t(`mood.score.${score}`),
    moodAverage: (average, count) => t('mood.summaryAverage', { n: average, count }),
  };
}

export function boardImageLabels() {
  const lang = getLang();
  return {
    hidden: t('action.hiddenCard'), votes: n => t('summary.votes', { n }),
    actionBadge: ({ done, owner, due }) => [done ? t('action.badge.done') : t('action.badge.open'), owner, formatActionDue(due, lang)]
      .filter(Boolean).join(' · '),
  };
}

function summaryText(board, userId, exportedAt) {
  return buildRetroSummary({
    title: board.title, items: board.items, votesByItem: liveVotes(), userId, allRevealed: board.allRevealed,
    participants: window.storage?.getVoteResultParticipants?.() || [], mood: closedMood(board.moodCheck), labels: summaryLabels(),
    dateText: new Intl.DateTimeFormat(getLang(), SUMMARY_DATE_FORMAT).format(exportedAt),
  });
}

const imageNotice = ({ reduced, failedImages }, fileName) => {
  if (failedImages) return { msg: t('export.image.missing', { file: fileName, n: failedImages }), type: 'warn' };
  return { msg: reduced ? t('export.image.reduced', { file: fileName }) : t('export.done', { file: fileName }), type: 'info' };
};

/**
 * Every board export behind one busy flag: JSON/zip backup, CSV, Markdown
 * summary, PNG and PDF. The caller passes a ref so handlers read fresh state.
 */
export function useBoardExports({ boardRef, boardCode, userId, setToast }) {
  const [busy, setBusy] = useState(false);
  const done = useCallback((fileName) => setToast({ msg: t('export.done', { file: fileName }), type: 'info' }), [setToast]);

  const runBusy = useCallback(async (work) => {
    if (busy) return;
    setBusy(true);
    setToast({ msg: t('export.processing'), type: 'info' });
    try {
      await work();
    } catch (err) {
      setToast({ msg: t('export.fail', { err: err.message }), type: 'warn' });
    } finally {
      setBusy(false);
    }
  }, [busy, setToast]);

  const exportJson = useCallback(() => runBusy(async () => {
    const artifact = await createBoardExport(boardRef.current, { boardCode, userId });
    downloadArtifact(artifact);
    setToast(backupDoneNotice(artifact));
  }), [runBusy, boardRef, boardCode, userId, setToast]);

  // A zone's CSV holds only the stickies inside it; the board CSV groups every
  // sticky by its smallest enclosing zone, with unzoned cards in their own group.
  const exportCsv = useCallback((zone = null) => {
    if (zone && zone.type !== 'zone') return;
    const artifact = createCsvBoardExport(boardRef.current, { boardCode, userId, zone });
    downloadArtifact(artifact);
    done(artifact.fileName);
  }, [boardRef, boardCode, userId, done]);

  const copySummary = useCallback(async () => {
    const copied = await copyTextToClipboard(globalThis.navigator?.clipboard, summaryText(boardRef.current, userId, Date.now()));
    setToast(copied ? { msg: t('summary.copied'), type: 'info' } : { msg: t('summary.copyFailed'), type: 'warn' });
  }, [boardRef, userId, setToast]);

  const downloadSummary = useCallback(() => {
    const exportedAt = Date.now();
    const fileName = exportFileName({ fallbackBoardCode: boardCode, exportedAt, extension: 'md' });
    downloadArtifact({ fileName, mimeType: MARKDOWN_MIME_TYPE, contents: summaryText(boardRef.current, userId, exportedAt) });
    done(fileName);
  }, [boardRef, boardCode, userId, done]);

  const exportImage = useCallback((format) => runBusy(async () => {
    const board = boardRef.current;
    const result = await renderBoardImage(document, { items: board.items, votesByItem: liveVotes(), userId,
      allRevealed: board.allRevealed }, boardImageLabels(), format);
    if (!result) { setToast({ msg: t('export.image.empty'), type: 'warn' }); return; }
    const fileName = exportFileName({ fallbackBoardCode: boardCode, extension: IMAGE_EXTENSION[format] });
    downloadArtifact({ fileName, blob: result.blob });
    setToast(imageNotice(result, fileName));
  }), [runBusy, boardRef, boardCode, userId, setToast]);

  const exportPng = useCallback(() => exportImage(PNG_MIME_TYPE), [exportImage]);
  const exportPdf = useCallback(() => exportImage(PDF_MIME_TYPE), [exportImage]);

  return { busy, exportJson, exportCsv, copySummary, downloadSummary, exportPng, exportPdf };
}
