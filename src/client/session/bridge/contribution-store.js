import * as Y from 'yjs';
import { voteKey as VOTE_KEY, commentKey as COMMENT_KEY, VOTE_PREFIX, COMMENT_PREFIX,
  parseStoredVoteKey as parseVoteKey, parseStoredCommentKey as parseCommentKey } from '../../../domain/vote-comment-keys.js';
import { COMMENT_MAX_LEN, isSafeId, normalizeComment } from '../../../domain/comment-schema.js';
import { geometryErrorForPatch } from '../../../domain/board-geometry.js';
import { readCanonicalVotes } from '../../../domain/canonical-votes.js';
import { planVoteFinalization } from '../../../domain/vote-finalization.js';
import { CLEARED_VOTE_RESULTS } from '../../../domain/vote-session-lifecycle.js';
import { isMoodKey, moodKeys, readMoods } from '../mood-store.js';
import { isMoodScore, moodKey } from '../../../domain/mood-check.js';
import { isTemplateKey, putTemplate, readTemplates, removeTemplate } from '../../../domain/template-store.js';
import { getActiveRoomSession } from '../room-session.js';

export function createContributionStore({ ydoc, ymap, yItems, snapshot }) {
  const { readBoardSnapshot, readItemSnapshot, patchExistingItem } = snapshot;
  const isLiveSticky = (itemId) => {
    if (!isSafeId(itemId)) return false;
    const item = yItems.get(itemId);
    return item instanceof Y.Map && item.get('type') === 'sticky';
  };

  // Keep the flat persisted key format for existing rooms, but index its hot
  // read path in memory. A single vote/comment event now touches one sticky;
  // import/delete can still mutate many keys in one Yjs transaction.
  const indexedVotes = new Map();
  const indexedComments = new Map();
  const commentSnapshots = new Map();

  const voteEmitter = new EventTarget();
  ymap.observe((event) => {
    let dirty = false;
    const changed = new Map();
    event.keysChanged.forEach((key) => {
      const parsed = parseVoteKey(key);
      if (!parsed || !isSafeId(parsed.itemId) || !isSafeId(parsed.userId)) return;
      dirty = true;
      let voters = changed.get(parsed.itemId);
      if (!voters) {
        voters = new Set(indexedVotes.get(parsed.itemId) || []);
        changed.set(parsed.itemId, voters);
      }
      if (ymap.get(key)) voters.add(parsed.userId);
      else voters.delete(parsed.userId);
    });
    changed.forEach((voters, itemId) => {
      if (voters.size) indexedVotes.set(itemId, voters);
      else indexedVotes.delete(itemId);
    });
    if (dirty) voteEmitter.dispatchEvent(new Event('change'));
  });

  const commentEmitter = new EventTarget();
  ymap.observe((event) => {
    let dirty = false;
    const changedIds = new Set();
    event.keysChanged.forEach((key) => {
      const parsed = parseCommentKey(key);
      if (!parsed || !isSafeId(parsed.itemId) || !isSafeId(parsed.commentId)) return;
      dirty = true;
      changedIds.add(parsed.itemId);
      let comments = indexedComments.get(parsed.itemId);
      if (!comments) { comments = new Map(); indexedComments.set(parsed.itemId, comments); }
      const normalized = normalizeComment(ymap.get(key), parsed.commentId);
      if (normalized) comments.set(parsed.commentId, normalized);
      else comments.delete(parsed.commentId);
      if (!comments.size) indexedComments.delete(parsed.itemId);
    });
    changedIds.forEach((itemId) => {
      const comments = indexedComments.get(itemId);
      if (!comments) { commentSnapshots.delete(itemId); return; }
      commentSnapshots.set(itemId, [...comments.values()].sort((a, b) => (
        (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id)
      )));
    });
    if (dirty) commentEmitter.dispatchEvent(new Event('change'));
  });

  // Cache the validated, bounded snapshot; notify for local, remote, system,
  // and undo/redo changes alike. React always reads canonical Yjs state.
  const templateEmitter = new EventTarget();
  let templateSnapshot = readTemplates(ymap);
  ymap.observe((event) => {
    if (![...event.keysChanged].some(isTemplateKey)) return;
    templateSnapshot = readTemplates(ymap);
    templateEmitter.dispatchEvent(new Event('change'));
  });

  // Mood answers are few (one per person per round), so a full re-read is cheap.
  const moodEmitter = new EventTarget();
  let moodSnapshot = readMoods(ymap);
  ymap.observe((event) => {
    if (![...event.keysChanged].some(isMoodKey)) return;
    moodSnapshot = readMoods(ymap);
    moodEmitter.dispatchEvent(new Event('change'));
  });

  const methods = {
    setVote(itemId, voterId, on) {
      // Strict id format so a `:` in the key never confuses parseVoteKey on
      // the read-back path. Both ids come from `uid()` (alphanumeric) in
      // practice; this guard also rejects malicious values smuggled through
      // import flows.
      if (!isLiveSticky(itemId) || !isSafeId(voterId)) return;
      const k = VOTE_KEY(itemId, voterId);
      ydoc.transact(() => {
        if (on) ymap.set(k, 1);
        else ymap.delete(k);
      }, 'local');
    },
    // Delete an item and its related flat keys in a single transaction so
    // Cmd+Z restores the complete item state together.
    deleteItemWithVotesAndComments(itemId) {
      if (!isSafeId(itemId)) return;
      const votePrefix = `${VOTE_PREFIX}${itemId}:`;
      const commentPrefix = `${COMMENT_PREFIX}${itemId}:`;
      const relatedKeys = [];
      ymap.forEach((_v, k) => {
        if (k.startsWith(votePrefix) || k.startsWith(commentPrefix)) relatedKeys.push(k);
      });
      ydoc.transact(() => {
        relatedKeys.forEach((k) => ymap.delete(k));
        if (yItems.has(itemId)) yItems.delete(itemId);
      }, 'local');
    },
    getRoomHandle() { return getActiveRoomSession()?.roomHandle || ''; },
    snapshotVotes() {
      const out = new Map();
      indexedVotes.forEach((voters, itemId) => {
        if (isLiveSticky(itemId)) out.set(itemId, voters);
      });
      return out;
    },
    clearAllVotes() {
      const keys = [];
      ymap.forEach((_v, k) => { if (k.startsWith(VOTE_PREFIX)) keys.push(k); });
      if (!keys.length) return;
      ydoc.transact(() => { keys.forEach((k) => ymap.delete(k)); }, 'local');
    },
    clearVotesFor(itemId) {
      if (!isSafeId(itemId)) return;
      const prefix = `${VOTE_PREFIX}${itemId}:`;
      const keys = [];
      ymap.forEach((_v, k) => { if (k.startsWith(prefix)) keys.push(k); });
      if (!keys.length) return;
      ydoc.transact(() => { keys.forEach((k) => ymap.delete(k)); }, 'local');
    },
    clearVotesForItems(itemIds) {
      if (!itemIds || !itemIds.length) return;
      const prefixes = itemIds.filter(isSafeId).map((id) => `${VOTE_PREFIX}${id}:`);
      if (!prefixes.length) return;
      const keys = [];
      ymap.forEach((_v, k) => { if (prefixes.some((p) => k.startsWith(p))) keys.push(k); });
      if (!keys.length) return;
      ydoc.transact(() => { keys.forEach((k) => ymap.delete(k)); }, 'local');
    },
    addComment(itemId, comment) {
      if (!isLiveSticky(itemId) || !comment) return false;
      const value = normalizeComment(comment, comment.id, Date.now());
      if (!value) return false;
      const key = COMMENT_KEY(itemId, value.id);
      if (ymap.has(key)) return false;
      ydoc.transact(() => ymap.set(key, value), 'local');
      return true;
    },
    editComment(itemId, commentId, text) {
      if (!isLiveSticky(itemId) || !isSafeId(commentId)) return false;
      const key = COMMENT_KEY(itemId, commentId);
      const existing = ymap.get(key);
      if (!existing) return false;
      const nextText = typeof text === 'string' ? text.trim().slice(0, COMMENT_MAX_LEN) : '';
      if (!nextText) return false;
      const normalized = normalizeComment(existing, commentId, Date.now());
      if (!normalized) return false;
      ydoc.transact(() => {
        ymap.set(key, { ...normalized, text: nextText, editedAt: Date.now() });
      }, 'local');
      return true;
    },
    deleteComment(itemId, commentId) {
      if (!isSafeId(itemId) || !isSafeId(commentId)) return false;
      const key = COMMENT_KEY(itemId, commentId);
      if (!ymap.has(key)) return false;
      ydoc.transact(() => ymap.delete(key), 'local');
      return true;
    },
    snapshotComments() {
      const out = new Map();
      commentSnapshots.forEach((comments, itemId) => {
        if (isLiveSticky(itemId)) out.set(itemId, comments);
      });
      return out;
    },
    clearCommentsForItems(itemIds) {
      if (!itemIds || !itemIds.length) return;
      const prefixes = itemIds.filter(isSafeId).map((id) => `${COMMENT_PREFIX}${id}:`);
      if (!prefixes.length) return;
      const keys = [];
      ymap.forEach((_v, k) => { if (prefixes.some((p) => k.startsWith(p))) keys.push(k); });
      if (!keys.length) return;
      ydoc.transact(() => { keys.forEach((k) => ymap.delete(k)); }, 'local');
    },
    clearAllComments() {
      const keys = [];
      ymap.forEach((_v, k) => { if (k.startsWith(COMMENT_PREFIX)) keys.push(k); });
      if (!keys.length) return;
      ydoc.transact(() => { keys.forEach((k) => ymap.delete(k)); }, 'local');
    },
    finalizeVoteSession(zoneId, expectedStartedAt, participants, atTime) {
      let finalized = null;
      ydoc.transact(() => {
        const timer = yItems.get(zoneId)?.get('voteTimer');
        if (!timer || timer.startedAt !== expectedStartedAt) return;
        const { items, allRevealed } = readBoardSnapshot();
        const votes = readCanonicalVotes(ymap);
        const plan = planVoteFinalization(items, votes, zoneId, atTime, participants, allRevealed);
        if (!plan || plan.entries.some(({ id, patch }) => geometryErrorForPatch(
          readItemSnapshot(yItems.get(id), id), patch,
        ))) return;
        plan.entries.forEach(({ id, patch }) => patchExistingItem(id, patch));
        finalized = plan;
      }, 'system');
      return finalized;
    },
    startVoteSession(rootZoneId, timerPatch, staleResultZoneIds, clearedItemIds) {
      const root = yItems.get(rootZoneId);
      if (!(root instanceof Y.Map) || root.get('type') !== 'zone'
          || root.get('voteTimer') || !timerPatch?.voteTimer
          || !Array.isArray(staleResultZoneIds) || !Array.isArray(clearedItemIds)) return false;
      ydoc.transact(() => {
        patchExistingItem(rootZoneId, { ...timerPatch, ...CLEARED_VOTE_RESULTS });
        staleResultZoneIds.forEach((id) => patchExistingItem(id, CLEARED_VOTE_RESULTS));
        if (clearedItemIds.length) {
          const prefixes = clearedItemIds.map((id) => `${VOTE_PREFIX}${id}:`);
          const keys = [];
          ymap.forEach((_v, k) => {
            if (prefixes.some((prefix) => k.startsWith(prefix))) keys.push(k);
          });
          keys.forEach((k) => ymap.delete(k));
        }
      }, 'local');
      return true;
    },
    onVotesChange(handler) { voteEmitter.addEventListener('change', handler); },
    offVotesChange(handler) { voteEmitter.removeEventListener('change', handler); },
    snapshotMoods() { return moodSnapshot; },
    // The person's own answer is a local (undoable) write.
    setMood(roundId, userId, score) {
      if (!isSafeId(roundId) || !isSafeId(userId) || !isMoodScore(score)) return false;
      ydoc.transact(() => { ymap.set(moodKey(roundId, userId), score); }, 'local');
      return true;
    },
    // Starting a new round drops the previous one's answers; not undoable.
    clearAllMoods() {
      const keys = moodKeys(ymap);
      if (keys.length) ydoc.transact(() => { keys.forEach((key) => ymap.delete(key)); }, 'system');
    },
    onMoodsChange(handler) { moodEmitter.addEventListener('change', handler); },
    offMoodsChange(handler) { moodEmitter.removeEventListener('change', handler); },
    onCommentsChange(handler) { commentEmitter.addEventListener('change', handler); },
    offCommentsChange(handler) { commentEmitter.removeEventListener('change', handler); },
    snapshotTemplates() { return templateSnapshot; },
    putTemplate(template) { return putTemplate(ydoc, ymap, template); },
    removeTemplate(id) { return removeTemplate(ydoc, ymap, id); },
    onTemplatesChange(handler) { templateEmitter.addEventListener('change', handler); },
    offTemplatesChange(handler) { templateEmitter.removeEventListener('change', handler); },

  };
  return { methods };
}
