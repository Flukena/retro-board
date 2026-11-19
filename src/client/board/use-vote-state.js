import { useState, useCallback } from 'react';
import { reuseSnapshotMap as reuseMap } from '../../domain/snapshot-references.js';
import { activeVoteZone as voteZone } from '../../domain/vote-ownership.js';
import { t as translate } from '../ui/i18n.js';

export function createVoteSnapshotController({ window = globalThis.window, setVotesByItem, setCommentsByItem, reuseSnapshotMap = reuseMap }) {
    const voteHandler = () => {
      if (typeof window !== 'undefined' && window.storage?.snapshotVotes) {
        const next = window.storage.snapshotVotes();
        setVotesByItem(previous => reuseSnapshotMap(previous, next));
      }
    };
    const commentHandler = () => {
      if (typeof window !== 'undefined' && window.storage?.snapshotComments) {
        const next = window.storage.snapshotComments();
        setCommentsByItem(previous => reuseSnapshotMap(previous, next));
      }
    };

return { refreshVotes: voteHandler, refreshComments: commentHandler, subscribe() {
    if (typeof window !== 'undefined' && window.storage?.onVotesChange) {
      window.storage.onVotesChange(voteHandler);
    }
    if (typeof window !== 'undefined' && window.storage?.onCommentsChange) {
      window.storage.onCommentsChange(commentHandler);
    }
}, dispose() {
      if (typeof window !== 'undefined' && window.storage?.offVotesChange) {
        window.storage.offVotesChange(voteHandler);
      }
      if (typeof window !== 'undefined' && window.storage?.offCommentsChange) {
        window.storage.offCommentsChange(commentHandler);
      }
} };
}

export function createController({boardRef, activeVoteZone = voteZone, Date = globalThis.Date, setToast, t = translate, window = globalThis.window, userId, flashVote, setBoard, storage, setSelectedIds, focusedTextIdRef, updateFocusedText}) {
const toggleVote = (it) => {
    const items = boardRef.current.items;
    const voteZone = activeVoteZone(it, items, Date.now());
    const zTimer = voteZone?.voteTimer;
    const allowed = !!voteZone && !voteZone.votingLocked;
    if (!allowed) {
      setToast({ msg: t('vote.notStarted'), type: 'warn' });
      return;
    }
    if (!window.storage?.setVote) return;
    // Read the live Yjs snapshot (not React state) so rapid clicks and
    // concurrent remote writes see the latest value.
    const live = window.storage.snapshotVotes();
    const has = !!live.get(it.id)?.has(userId);
    if (!has && zTimer.voteLimit != null) {
      let used = 0;
      // Only count votes on cards still under an active session — a vote
      // cast in an earlier, already-finished session (anywhere on the
      // board) must not eat into a brand-new session's quota.
      live.forEach((set, id) => {
        if (!set.has(userId)) return;
        const votedItem = items.find((i) => i.id === id);
        if (votedItem && activeVoteZone(votedItem, items, Date.now())) used += 1;
      });
      if (used >= zTimer.voteLimit) {
        setToast({ msg: t('vote.outOfQuota'), type: 'warn' });
        return;
      }
    }
    window.storage.setVote(it.id, userId, !has);
    if (!has) flashVote(it.id);
  };
const removeItemUnchecked = (id) => {
    // One Yjs transaction so Cmd+Z restores the item and its related state together.
    // Falls back to the two-call path if the bridge is an older build that
    // doesn't expose the combined helper yet.
    if (window.storage?.deleteItemWithVotesAndComments) {
      window.storage.deleteItemWithVotesAndComments(id);
      // React state still needs to drop the item — the deepObserver fires a
      // synthetic boardState change, but only for non-local origins. Our own
      // delete is 'local', so do it explicitly here.
      setBoard((prev) => ({ ...prev, items: prev.items.filter((it) => it.id !== id) }));
    } else {
      window.storage?.clearVotesFor?.(id);
      window.storage?.clearCommentsForItems?.([id]);
      setBoard((prev) => ({ ...prev, items: prev.items.filter((it) => it.id !== id) }));
      storage.removeItem(id);
    }
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    if (focusedTextIdRef.current?.startsWith(`${id}:`)) updateFocusedText(null);
  };
return {toggleVote,removeItemUnchecked, dispose() {}};
}

const VOTE_FLASH_MS = 900;
const FLASH_CLOCK = {
  now: () => globalThis.Date.now(),
  setTimeout: (run, delayMs) => globalThis.setTimeout(run, delayMs),
  clearTimeout: id => globalThis.clearTimeout(id),
};

export function createVoteFlashController({ clock = FLASH_CLOCK, publish } = {}) {
  const timers = new Set();
  const flash = (itemId, update = publish) => {
    const timestampMs = clock.now();
    update(previous => ({ ...previous, [itemId]: timestampMs }));
    const timer = clock.setTimeout(() => {
      timers.delete(timer);
      update(previous => {
        if (previous[itemId] !== timestampMs) return previous;
        const next = { ...previous };
        delete next[itemId];
        return next;
      });
    }, VOTE_FLASH_MS);
    timers.add(timer);
  };
  const dispose = () => {
    timers.forEach(timer => clock.clearTimeout(timer));
    timers.clear();
  };
  return { flash, dispose };
}

export function useVoteSnapshotsState() {
  const [votesByItem, setVotesByItem] = useState(() => globalThis.window?.storage?.snapshotVotes?.() || new Map());
  const [commentsByItem, setCommentsByItem] = useState(() => globalThis.window?.storage?.snapshotComments?.() || new Map());
  return { votesByItem, setVotesByItem, commentsByItem, setCommentsByItem };
}

export function useVoteFlashes() {
  const [state, setState] = useState(() => ({ flashes: {}, controller: createVoteFlashController() }));
  const flashVote = useCallback(itemId => state.controller.flash(itemId, update => {
    setState(previous => ({ ...previous, flashes: update(previous.flashes) }));
  }), []);
  return { voteFlashes: state.flashes, flashVote, disposeVoteFlashes: state.controller.dispose };
}

export function useToggleVote(options, dependencies) {
  return useCallback(createController(options).toggleVote, dependencies);
}

export function useRemoveItem(options, dependencies) {
  return useCallback(createController(options).removeItemUnchecked, dependencies);
}
