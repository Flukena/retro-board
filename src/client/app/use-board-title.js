import { useEffect } from 'react';
import { boardTitleToSeed } from '../../domain/board-title.js';
import { t } from '../ui/i18n.js';

// Names the room with the title its creator typed on the landing page.
// Reads the synced room state first so an existing title is never overwritten.
export const seedBoardTitle = async ({ storage, pendingTitle, patchMeta }) => {
  const record = await storage.get('boardState', true);
  const title = boardTitleToSeed({ storedTitle: record?.value?.title, pendingTitle });
  if (title) patchMeta({ title }, { silent: true });
  return title;
};

export const documentTitleFor = (title) => (title ? `${title} · ${t('app.title')}` : t('app.title'));

export function useBoardTitle({ storage, liveStorage, title, pendingTitle, patchMeta }) {
  useEffect(() => {
    if (!pendingTitle) return undefined;
    let pending = true;
    const seedOnce = () => {
      if (!pending) return;
      pending = false;
      seedBoardTitle({ storage, pendingTitle, patchMeta });
    };
    if (liveStorage.synced()) seedOnce();
    const offSynced = liveStorage.onSynced(seedOnce) || (() => {});
    return () => { pending = false; offSynced(); };
  }, [storage, liveStorage, pendingTitle, patchMeta]);

  useEffect(() => { document.title = documentTitleFor(title); }, [title]);
}
