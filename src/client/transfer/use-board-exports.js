import { useCallback, useState } from 'react';
import { createBoardExport, createCsvBoardExport } from './board-transfer.js';
import { exportFileName } from './board-backup.js';
import { backupDoneNotice } from './export-notice.js';
import { downloadArtifact } from './browser-download.js';
import { PNG_MIME_TYPE, renderBoardImage } from './board-image-export.js';
import { PDF_MIME_TYPE } from './pdf-image-document.js';
import { t } from '../ui/i18n.js';

const IMAGE_EXTENSION = Object.freeze({ [PNG_MIME_TYPE]: 'png', [PDF_MIME_TYPE]: 'pdf' });

const liveVotes = () => window.storage?.snapshotVotes?.() || new Map();
function boardImageLabels() {
  return {
    hidden: t('export.image.hiddenCard'), votes: n => t('export.image.votes', { n }),
  };
}

const imageNotice = ({ reduced, failedImages }, fileName) => {
  if (failedImages) return { msg: t('export.image.missing', { file: fileName, n: failedImages }), type: 'warn' };
  return { msg: reduced ? t('export.image.reduced', { file: fileName }) : t('export.done', { file: fileName }), type: 'info' };
};

/**
 * Every board export behind one busy flag: JSON/zip backup, CSV, PNG and PDF. The caller passes a ref so handlers read fresh state.
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

  return { busy, exportJson, exportCsv, exportPng, exportPdf };
}
