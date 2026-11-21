import { useCallback } from 'react';
import { readBoardImport as readImport, prepareBoardImport as prepareImport, ImportBundleLimitError } from './board-transfer.js';
import { t as translate } from '../ui/i18n.js';

export function createBoardImport({
  isAdmin, fileInputRef, setToast, setPendingImport, pendingImport, importBusy, setImportBusy,
  boardRef, setBoard, readBoardImport = readImport, prepareBoardImport = prepareImport,
  t = translate, view = globalThis.window,
}) {
  const onImportPick = () => {
    if (!isAdmin) { setToast({ msg: t('common.adminOnly'), type: 'warn' }); return; }
    fileInputRef.current?.click();
  };
  const onImportFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (!file) return;
    try {
      setPendingImport(await readBoardImport(file));
    } catch (err) {
      setToast({ msg: t('import.fail', { err: err.message }), type: 'warn' });
    }
  };
  const confirmImport = async () => {
    if (!pendingImport || !isAdmin || importBusy) return;
    const {
      voteEntries, commentEntries, moodEntries, customTemplates: importedTemplates,
    } = pendingImport;
    setImportBusy(true);
    let nextBoard;
    try {
      nextBoard = await prepareBoardImport(pendingImport, boardRef.current);
    } catch (err) {
      setImportBusy(false);
      setToast({
        msg: err instanceof ImportBundleLimitError ? t('import.tooLarge', { mb: err.maximumMiB }) : t('import.fail', { err: err.message }),
        type: 'warn',
      });
      return;
    }
    const imported = view.storage?.importBundle?.(
      nextBoard, voteEntries, commentEntries, importedTemplates, moodEntries,
    );
    if (!imported) {
      setImportBusy(false);
      setToast({ msg: t('import.fail', { err: 'invalid import bundle' }), type: 'warn' });
      return;
    }
    setBoard(nextBoard);
    const n = nextBoard.items.length;
    setPendingImport(null);
    setImportBusy(false);
    setToast({
      msg: t('import.done', { n }),
      type: 'info',
    });
  };
  return { onImportPick, onImportFileChange, confirmImport };
}

export function useOnImportPick(options, dependencies) {
  return useCallback(createBoardImport(options).onImportPick, dependencies);
}

export function useOnImportFileChange(options, dependencies) {
  return useCallback(createBoardImport(options).onImportFileChange, dependencies);
}

export function useConfirmImport(options, dependencies) {
  return useCallback(createBoardImport(options).confirmImport, dependencies);
}
