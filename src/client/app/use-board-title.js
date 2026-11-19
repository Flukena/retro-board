import { useEffect } from 'react';
import { boardTitleToSeed } from '../../domain/board-title.js';
import { documentTitleFor } from './document-title.js';
import { boardTitleEvents, serveBoardTitle } from './board-title-requests.js';

// Names the room with the title its creator typed on the landing page.
// Reads the synced room state first so an existing title is never overwritten.
export const seedBoardTitle = async ({ storage, pendingTitle, patchMeta }) => {
  const record = await storage.get('boardState', true);
  const title = boardTitleToSeed({ storedTitle: record?.value?.title, pendingTitle });
  if (title) patchMeta({ title }, { silent: true });
  return title;
};

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
  useEffect(() => serveBoardTitle(boardTitleEvents, { title, patchMeta }), [title, patchMeta]);
}
