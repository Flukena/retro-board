import * as Y from 'yjs';
import { Observable } from 'lib0/observable';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import {
  E2E_CIPHERTEXT_OVERHEAD_BYTES, E2E_EPHEMERAL_MAX_BYTES, E2E_FRAME, E2E_MAX_FRAME_HEADER_BYTES, E2E_REJECT,
  decodeServerFrame, e2eFrameHeaderBytes, encodeFrame,
} from '../../domain/e2e-envelope.js';
import {
  RELAY_DEFAULT_MAX_DOCUMENT_BYTES, RELAY_DEFAULT_MAX_WS_MESSAGE_BYTES, e2eMaxSnapshotCiphertextBytes,
} from '../../domain/e2e-limits.js';
import { KEY_ROTATED_CLOSE_CODE, e2eAad } from '../../domain/room-lock-contract.js';
import { decryptFrame, encryptFrame } from '../room-lock/e2e-crypto.js';
import { KEY_ROTATED_EVENT } from '../room-lock/lock-session.js';
import { SeqCoverage } from './e2e-coverage.js';
import { PendingDeliveries } from './e2e-delivery.js';
import { isReauthRequiredError, refreshActiveRoomSession } from './room-session.js';
import { SNAPSHOT_JITTER_MAX_MS, SnapshotPolicy } from './e2e-snapshot-policy.js';
import { isRoomDeletedClose, pageRoomDeleted } from './room-deleted.js';

/** Dispatched on the page when a log entry could not be decrypted or applied; detail `{ seq }`. */
export const E2E_SKIPPED_EVENT = 'retroroom:e2e-skipped';
/** Dispatched on the page when the room has no space left for this page's edits. */
export const E2E_ROOM_FULL_EVENT = 'retroroom:e2e-room-full';
/** Awareness field a page sets while it holds every log entry up to the relay's head (Deviation 7). */
export const E2E_SYNCED_FIELD = 'e2eSynced';

const SOCKET_PATH_SUFFIX = 'e2e';
const ARRAYBUFFER = 'arraybuffer';
const STATUS = Object.freeze({ CONNECTING: 'connecting', CONNECTED: 'connected', DISCONNECTED: 'disconnected' });
const AAD_KIND = Object.freeze({ UPDATE: 'update', EPHEMERAL: 'ephemeral', SNAPSHOT: 'snapshot' });
const RECONNECT_BASE_MS = 100;
/** Cap for both reconnect and REJECT RATE retry backoff. */
export const E2E_MAX_BACKOFF_MS = 2_500;
const APPEND_OVERHEAD_BYTES = e2eFrameHeaderBytes(E2E_FRAME.APPEND) + E2E_CIPHERTEXT_OVERHEAD_BYTES;
// An update with no structs and an empty delete set: appending it changes no document. It proves ordering
// after a snapshot (its ACK means the relay finished the snapshot first) and moves the log head when needed.
const EMPTY_UPDATE = (() => {
  const empty = new Y.Doc();
  const update = Y.encodeStateAsUpdate(empty);
  empty.destroy();
  return update;
})();
const WS_OPEN_STATE = 1;
const NORMAL_CLOSE = Object.freeze({ code: 1000, reason: 'disconnect' });
/** A page advertises e2eSynced again only after it stayed caught up this long, so presence does not flap per edit. */
export const E2E_SYNCED_SETTLE_MS = 1_000;
const SKIPPED_LOG = '[e2e] skipped an unreadable log entry';
const SKIPPED_SUPPRESSED_LOG = '[e2e] more unreadable log entries skipped';
/** How a log frame ended: applied; not decrypted under the room key (nobody can read it); or decrypted but invalid. */
const REMOTE = Object.freeze({ APPLIED: 'applied', UNDECRYPTABLE: 'undecryptable', INVALID: 'invalid' });
const FAILURE_LOG = '[e2e] provider step failed';

const PROBE_OUTCOME = Object.freeze({ RENEWED: 'renewed', REAUTH: 'reauth', INCONCLUSIVE: 'inconclusive' });
const probeFailureOutcome = (error) => (isReauthRequiredError(error) ? PROBE_OUTCOME.REAUTH : PROBE_OUTCOME.INCONCLUSIVE);
const backoffMs = (attempt) => Math.min(RECONNECT_BASE_MS * 2 ** attempt, E2E_MAX_BACKOFF_MS);
const defaultTimers = Object.freeze({
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  now: () => Date.now(),
});
const reportFailure = (error) => console.error(FAILURE_LOG, error?.name);

/**
 * Provider for an end-to-end encrypted room: the same contract the board uses with y-websocket
 * (`sync`/`status`/`connection-close`/`connection-error`, `wsconnected`, `synced`, `awareness`, connect/disconnect/destroy)
 * plus acknowledged delivery (`pendingDelivery`, `delivery`). The relay only ever sees AES-GCM ciphertext.
 */
export class E2EProvider extends Observable {
  #key;
  #WebSocketImpl;
  #events;
  #cipher;
  #timers;
  #random;
  #appendFrameBytes;
  #maxSnapshotBytes;
  #maxFrameBytes;
  #pending;
  #coverage = new SeqCoverage();
  #policy;
  #synced = false;
  #generation = 0;
  #replayDone = false;
  // Set by a rotation close or a session probe that needs the password: no reconnect until setKey.
  #awaitingReunlock = false;
  // A socket refused before it opened probes the session until one probe is conclusive (M3).
  #sessionProbed = false;
  #probeSession;
  // The page's terminal deleted state: once set, nothing opens a socket again.
  #roomDeleted;
  #offRoomDeleted;
  #reconnectAttempts = 0;
  #reconnectTimer = null;
  #inbox = Promise.resolve();
  #outbox = Promise.resolve();
  #sendSerial = 0;
  #snapshot = null;
  #snapshotTimer = null;
  #retryTimers = new Set();
  // baseSeq of the newest snapshot this page applied or wrote on this connection; the relay fences on it.
  #appliedSnapshotBase = 0;
  #awaitingPeerSnapshot = false;
  // Snapshots received but not yet applied: each may hold edits no log entry carries.
  #unappliedSnapshots = 0;
  #syncedSettleMs;
  #syncedTimer = null;
  #awarenessBusy = false;
  #awarenessDirty = false;
  #roomFullAnnounced = false;
  #suppressedSkips = 0;
  #lossReported = false;

  constructor(wsBaseUrl, roomHandle, doc, {
    key, WebSocketImpl = globalThis.WebSocket, connect = true, awareness = new Awareness(doc),
    eventTarget = globalThis.window, cipher = { encryptFrame, decryptFrame }, timers = defaultTimers,
    random = Math.random, firstClientRef, snapshotPolicy = {},
    appendFrameBytes = RELAY_DEFAULT_MAX_WS_MESSAGE_BYTES, maxRoomBytes = RELAY_DEFAULT_MAX_DOCUMENT_BYTES,
    syncedSettleMs = E2E_SYNCED_SETTLE_MS, probeSession = refreshActiveRoomSession, roomDeleted = pageRoomDeleted,
  } = {}) {
    super();
    this.url = `${wsBaseUrl.replace(/\/+$/, '')}/${roomHandle}/${SOCKET_PATH_SUFFIX}`;
    this.roomname = roomHandle;
    this.doc = doc;
    this.awareness = awareness;
    this.ws = null;
    this.wsconnected = false;
    this.wsconnecting = false;
    this.shouldConnect = connect;
    this.#key = key;
    this.#WebSocketImpl = WebSocketImpl;
    this.#events = eventTarget;
    this.#cipher = cipher;
    this.#timers = timers;
    this.#random = random;
    this.#appendFrameBytes = appendFrameBytes;
    this.#syncedSettleMs = syncedSettleMs;
    this.#probeSession = probeSession;
    this.#roomDeleted = roomDeleted;
    this.#maxSnapshotBytes = e2eMaxSnapshotCiphertextBytes(maxRoomBytes);
    this.#maxFrameBytes = maxRoomBytes + E2E_MAX_FRAME_HEADER_BYTES;
    this.#pending = new PendingDeliveries({ firstClientRef });
    this.#policy = new SnapshotPolicy(snapshotPolicy);
    this._updateHandler = (update, origin) => { if (origin !== this) this.#queueLocalUpdate(update); };
    this._awarenessUpdateHandler = ({ added, updated, removed }) => {
      if ([...added, ...updated, ...removed].includes(doc.clientID)) this.#sendAwareness();
    };
    doc.on('update', this._updateHandler);
    awareness.on('update', this._awarenessUpdateHandler);
    this.#offRoomDeleted = roomDeleted.subscribe(() => this.disconnect());
    if (connect) this.connect();
  }

  get synced() { return this.#synced; }

  set synced(state) {
    if (this.#synced === state) return;
    this.#synced = state;
    this.emit('synced', [state]);
    this.emit('sync', [state]);
  }

  /** Local updates the relay has not acknowledged yet. */
  get pendingDelivery() { return this.#pending.size; }
  get appliedSeq() { return this.#coverage.appliedSeq; }
  get head() { return this.#coverage.head; }
  get skippedSeq() { return this.#coverage.skippedSeq; }
  /** The base of the stored snapshot this page has applied or written; a rotation commit must claim it. */
  get appliedSnapshotBase() { return this.#appliedSnapshotBase; }
  /** True while connected, replayed, nothing skipped, every log entry up to the head held and every snapshot applied. */
  get e2eSynced() {
    return this.wsconnected && this.#replayDone && this.#coverage.skippedSeq === null && this.#coverage.caughtUp
      && this.#unappliedSnapshots === 0;
  }

  connect() {
    if (this.#roomDeleted.isDeleted()) return;
    this.shouldConnect = true;
    if (this.#awaitingReunlock || this.ws !== null) return;
    this.#open();
  }

  /**
   * Orderly close. Everything tied to the socket is invalidated at once, so no decryption or encryption still in
   * flight can touch the doc or send afterwards; peers get an encrypted removal of this page's presence.
   */
  disconnect() {
    this.shouldConnect = false;
    this.#clearReconnect();
    const ws = this.ws;
    if (ws === null) return;
    const goodbye = this.wsconnected ? this.#presenceRemoval() : null;
    this.#onClose(NORMAL_CLOSE);
    if (goodbye === null) {
      ws.close();
      return;
    }
    goodbye.then((frame) => { if (ws.readyState === WS_OPEN_STATE) ws.send(frame); })
      .catch(reportFailure).finally(() => ws.close());
  }

  /** The awareness removal y-websocket sends on close; the local state itself is kept for the next connection. */
  #presenceRemoval() {
    const removal = encodeAwarenessUpdate(this.awareness, [this.doc.clientID], new Map());
    const aad = e2eAad(this.roomname, this.#key.keyEpoch, AAD_KIND.EPHEMERAL);
    return this.#cipher.encryptFrame(this.#key.dek, aad, removal).then((ciphertext) => encodeFrame(E2E_FRAME.EPHEMERAL, { ciphertext }));
  }

  /** After re-unlock: future frames use the new key and epoch; pending entries are re-sent under it. */
  setKey(key) {
    this.#key = key;
    this.#awaitingReunlock = false;
    if (this.shouldConnect && this.ws === null && !this.#roomDeleted.isDeleted()) this.#open();
  }

  destroy() {
    this.#offRoomDeleted();
    this.disconnect();
    this.#clearTimers();
    this.awareness.off('update', this._awarenessUpdateHandler);
    this.doc.off('update', this._updateHandler);
    super.destroy();
  }

  // ---- connection ---------------------------------------------------------------------------------

  #open() {
    this.#clearReconnect();
    this.#generation += 1;
    const generation = this.#generation;
    const ws = new this.#WebSocketImpl(this.url);
    ws.binaryType = ARRAYBUFFER;
    this.ws = ws;
    this.wsconnecting = true;
    this.wsconnected = false;
    ws.onopen = () => { if (generation === this.#generation) this.#onOpen(); };
    ws.onmessage = (event) => { if (generation === this.#generation) this.#onMessage(new Uint8Array(event.data), generation); };
    ws.onerror = (event) => { if (generation === this.#generation) this.emit('connection-error', [event, this]); };
    ws.onclose = (event) => { if (generation === this.#generation) this.#onClose(event); };
    this.emit('status', [{ status: STATUS.CONNECTING }]);
  }

  #onOpen() {
    this.wsconnecting = false;
    this.wsconnected = true;
    this.#reconnectAttempts = 0;
    this.#sessionProbed = false;
    this.#replayDone = false;
    this.#appliedSnapshotBase = 0;
    this.#awaitingPeerSnapshot = false;
    this.#coverage.restart();
    this.#lossReported = false;
    this.#policy.restart();
    this.emit('status', [{ status: STATUS.CONNECTED }]);
    this.#announcePresence();
  }

  /** A fresh clock, so peers accept this state even after the removal sent when the last socket closed. */
  #announcePresence() {
    const state = this.awareness.getLocalState();
    if (state === null) this.#sendAwareness();
    else this.awareness.setLocalState(state);
  }

  #onClose(event) {
    const wasConnected = this.wsconnected;
    this.#generation += 1;
    this.ws = null;
    this.wsconnected = false;
    this.wsconnecting = false;
    this.#replayDone = false;
    this.#snapshot = null;
    this.#unappliedSnapshots = 0;
    this.#clearTimers();
    this.#flushSkipCount();
    this.synced = false;
    this.emit('connection-close', [event, this]);
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    removeAwarenessStates(this.awareness, others, this);
    this.#publishE2ESynced();
    if (wasConnected) this.emit('status', [{ status: STATUS.DISCONNECTED }]);
    else this.#reconnectAttempts += 1;
    if (event?.code === KEY_ROTATED_CLOSE_CODE) {
      this.#awaitingReunlock = true;
      this.#dispatch(KEY_ROTATED_EVENT);
      return;
    }
    // The relay deleted the room: the page's deleted state disconnects every provider for good.
    if (isRoomDeletedClose(event)) {
      this.#roomDeleted.mark();
      return;
    }
    if (this.shouldConnect && !this.#awaitingReunlock) this.#scheduleReconnect(!wasConnected && !this.#sessionProbed);
  }

  // A refused upgrade looks like any network close (1006), so a failed open renews the session: a missed rotation
  // then answers 403 and the re-unlock dialog takes over instead of a silent reconnect loop. An inconclusive probe
  // (network, 429, 5xx) is retried on the next failed open, at the reconnect backoff, until a probe or a socket succeeds.
  #scheduleReconnect(probe) {
    if (probe) this.#sessionProbed = true;
    this.#reconnectTimer = this.#timers.setTimeout(() => {
      this.#reconnectTimer = null;
      if (probe) this.#probeThenConnect();
      else this.connect();
    }, backoffMs(this.#reconnectAttempts));
  }

  #probeThenConnect() {
    const generation = this.#generation;
    const key = this.#key;
    this.#probeSession().then(() => PROBE_OUTCOME.RENEWED, probeFailureOutcome).then((outcome) => {
      if (outcome === PROBE_OUTCOME.INCONCLUSIVE) this.#sessionProbed = false;
      const retry = outcome !== PROBE_OUTCOME.REAUTH;
      // The health change reaches listeners first, and one may already have reconnected: unless setKey brought a
      // new key meanwhile, a re-auth answer still holds every reconnect until the page re-unlocks.
      if (!retry && this.#key === key) this.#awaitingReunlock = true;
      if (retry && generation === this.#generation && this.ws === null && this.shouldConnect) this.connect();
    }).catch(reportFailure);
  }

  #clearReconnect() {
    if (this.#reconnectTimer !== null) this.#timers.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #clearTimers() {
    if (this.#snapshotTimer !== null) this.#timers.clearTimeout(this.#snapshotTimer);
    this.#snapshotTimer = null;
    if (this.#syncedTimer !== null) this.#timers.clearTimeout(this.#syncedTimer);
    this.#syncedTimer = null;
    this.#retryTimers.forEach((id) => this.#timers.clearTimeout(id));
    this.#retryTimers.clear();
  }

  #dispatch(type, detail) {
    this.#events?.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #send(frame) {
    this.ws.send(frame);
    this.#sendSerial += 1;
    return this.#sendSerial;
  }

  /** Runs `step` after every earlier outgoing step; it is skipped once its connection has closed. */
  #queueOutgoing(step) {
    const generation = this.#generation;
    this.#outbox = this.#outbox.then(() => (generation === this.#generation ? step(generation) : undefined))
      .catch(reportFailure);
  }

  #aad(kind, binding) {
    return e2eAad(this.roomname, this.#key.keyEpoch, kind, binding);
  }

  // ---- receive: one ordered queue ------------------------------------------------------------------

  #onMessage(bytes, generation) {
    const frame = decodeServerFrame(bytes, { maxBytes: this.#maxFrameBytes });
    if (!frame) return;
    if (frame.type === E2E_FRAME.EPHEMERAL_OUT) {
      this.#receiveAwareness(frame.ciphertext, generation);
      return;
    }
    // The head moves when a log frame arrives, not when its decryption ends: until it is applied this page is
    // behind, so it must not act as fully synced (vote expiry) meanwhile. A snapshot counts even at a base already
    // covered, because it may carry edits that were never log entries.
    if (frame.type === E2E_FRAME.SNAPSHOT_OUT) this.#unappliedSnapshots += 1;
    if (frame.type === E2E_FRAME.UPDATE || frame.type === E2E_FRAME.SNAPSHOT_OUT) {
      this.#coverage.noteHead(frame.seq);
      this.#publishE2ESynced();
    }
    this.#inbox = this.#inbox.then(() => (generation === this.#generation ? this.#handle(frame, generation) : undefined))
      .catch(reportFailure);
  }

  #handle(frame, generation) {
    switch (frame.type) {
      case E2E_FRAME.SNAPSHOT_OUT: return this.#applySnapshot(frame, generation);
      case E2E_FRAME.UPDATE: return this.#applyUpdate(frame, generation);
      case E2E_FRAME.SYNCED: return this.#onSynced(frame);
      case E2E_FRAME.ACK: return this.#onAck(frame);
      case E2E_FRAME.REJECT: return this.#onReject(frame);
      case E2E_FRAME.RESUMED: return this.#resend((entry) => entry.held);
      default: return undefined;
    }
  }

  /** Decrypts and applies one log frame. Resolves a REMOTE outcome, or null when the socket is gone. */
  async #applyRemote(ciphertext, aad, generation) {
    let plaintext;
    try {
      plaintext = await this.#cipher.decryptFrame(this.#key.dek, aad, ciphertext);
    } catch {
      return generation === this.#generation ? REMOTE.UNDECRYPTABLE : null;
    }
    if (generation !== this.#generation) return null;
    try {
      Y.applyUpdate(this.doc, plaintext, this);
      return REMOTE.APPLIED;
    } catch {
      return REMOTE.INVALID;
    }
  }

  // Every member of an epoch holds the same key, so an entry that does not decrypt under it is unreadable to all:
  // it counts as covered and empty and never blocks snapshots or rotation. One that decrypts but does not apply may
  // carry content another page can read, so it is skipped and blocks them.
  async #applyUpdate({ seq, ciphertext }, generation) {
    if (seq <= this.#coverage.appliedSeq) return;
    const outcome = await this.#applyRemote(ciphertext, this.#aad(AAD_KIND.UPDATE), generation);
    if (outcome === null) return;
    if (outcome === REMOTE.INVALID) this.#skip(seq);
    else this.#coverage.cover(seq);
    if (outcome === REMOTE.UNDECRYPTABLE) this.#reportLoss(seq);
    this.#policy.noteLogEntry(ciphertext.byteLength);
    this.#afterProgress();
  }

  async #applySnapshot({ seq, ciphertext }, generation) {
    // Always applied: a snapshot may carry a peer's edit that never was a log entry (one too large to append).
    const outcome = await this.#applyRemote(ciphertext, this.#aad(AAD_KIND.SNAPSHOT, seq), generation);
    if (outcome === null) return;
    this.#unappliedSnapshots -= 1;
    if (outcome === REMOTE.APPLIED) this.#appliedSnapshotBase = seq;
    else this.#skip(seq);
    this.#coverage.coverThrough(seq);
    this.#awaitingPeerSnapshot = false;
    this.#policy.logPruned();
    this.#afterProgress();
  }

  #skip(seq) {
    this.#coverage.skip(seq);
    this.#reportLoss(seq);
  }

  // Logs the first entry this connection could not use; later ones are counted and logged once when it closes.
  #reportLoss(seq) {
    if (this.#lossReported) {
      this.#suppressedSkips += 1;
      return;
    }
    this.#lossReported = true;
    console.warn(SKIPPED_LOG, { seq });
    this.#dispatch(E2E_SKIPPED_EVENT, { seq });
  }

  #flushSkipCount() {
    if (this.#suppressedSkips === 0) return;
    console.warn(SKIPPED_SUPPRESSED_LOG, { count: this.#suppressedSkips });
    this.#suppressedSkips = 0;
  }

  #onSynced({ seq }) {
    this.#coverage.noteHead(seq);
    this.#replayDone = true;
    this.#resend(() => true);
    this.#afterProgress();
  }

  #onAck({ seq, clientRef }) {
    this.#coverage.cover(seq);
    const entry = this.#pending.get(clientRef);
    this.#policy.noteLogEntry((entry?.update.byteLength ?? 0) + E2E_CIPHERTEXT_OVERHEAD_BYTES);
    if (entry && this.#provesSnapshot(entry)) this.#snapshotAccepted();
    if (this.#pending.acknowledge(clientRef)) this.#emitDelivery();
    this.#afterProgress();
  }

  #onReject({ code, clientRef }) {
    const entry = this.#pending.get(clientRef);
    if (clientRef === 0) this.#snapshotRejected(code);
    else if (entry && code === E2E_REJECT.RATE) this.#retryLater(entry);
    else if (entry && code === E2E_REJECT.FROZEN) entry.held = true;
    else if (entry && code === E2E_REJECT.QUOTA) this.#onQuota(entry);
  }

  #onQuota(entry) {
    // Any answer to an append sent after the snapshot means the relay finished that snapshot first.
    if (this.#provesSnapshot(entry)) this.#snapshotAccepted();
    entry.held = true;
    this.#policy.reachQuota();
    this.#scheduleSnapshot();
  }

  #retryLater(entry) {
    const generation = this.#generation;
    const id = this.#timers.setTimeout(() => {
      this.#retryTimers.delete(id);
      if (generation === this.#generation && this.#pending.get(entry.clientRef) === entry) this.#sendEntries([entry]);
    }, backoffMs(entry.retries));
    entry.retries += 1;
    this.#retryTimers.add(id);
  }

  #afterProgress() {
    if (this.#replayDone && this.wsconnected && this.#pending.size === 0) this.synced = true;
    this.#publishE2ESynced();
    this.#scheduleSnapshot();
  }

  // ---- send: local updates with acknowledged delivery ---------------------------------------------

  #queueLocalUpdate(update) {
    const oversized = update.byteLength + APPEND_OVERHEAD_BYTES > this.#appendFrameBytes;
    const entry = this.#pending.add(update, { oversized });
    this.#emitDelivery();
    if (oversized) this.#scheduleSnapshot();
    else this.#sendEntries([entry]);
  }

  #emitDelivery() {
    this.emit('delivery', [this.#pending.size]);
  }

  #resend(selected) {
    const entries = this.#pending.list().filter(selected);
    entries.forEach((entry) => { entry.held = false; });
    this.#sendEntries(entries);
  }

  /** Encrypts and sends entries in order. Entries wait for SYNCED; oversized and held ones are not sent. */
  #sendEntries(entries) {
    if (!this.#replayDone || !this.wsconnected) return;
    for (const entry of entries) {
      if (entry.oversized || entry.held) continue;
      this.#queueOutgoing(async (generation) => {
        const ciphertext = await this.#cipher.encryptFrame(this.#key.dek, this.#aad(AAD_KIND.UPDATE), entry.update);
        if (generation !== this.#generation || this.#pending.get(entry.clientRef) !== entry || entry.held) return;
        entry.sentSerial = this.#send(encodeFrame(E2E_FRAME.APPEND, { clientRef: entry.clientRef, ciphertext }));
      });
    }
  }

  // ---- snapshots (Deviation 11) --------------------------------------------------------------------

  #snapshotBlocked() {
    return !this.#replayDone || !this.wsconnected || this.#snapshot !== null || this.#awaitingPeerSnapshot
      || this.#unappliedSnapshots > 0 || this.#coverage.skippedSeq !== null || !this.#coverage.caughtUp;
  }

  #scheduleSnapshot() {
    if (this.#snapshotTimer !== null || this.#snapshotBlocked()) return;
    if (!this.#policy.wants({ forced: this.#pending.hasOversized() })) return;
    const delay = this.#policy.waitMs(this.#timers.now()) + this.#random() * SNAPSHOT_JITTER_MAX_MS;
    this.#snapshotTimer = this.#timers.setTimeout(() => {
      this.#snapshotTimer = null;
      this.#trySnapshot();
    }, delay);
  }

  /** Runs after the jitter: every condition is checked again before the state is captured. */
  #trySnapshot() {
    if (this.#snapshotBlocked() || !this.#policy.wants({ forced: this.#pending.hasOversized() })) return;
    if (this.#policy.waitMs(this.#timers.now()) > 0) {
      this.#scheduleSnapshot();
      return;
    }
    if (this.#coverage.appliedSeq <= this.#appliedSnapshotBase) {
      this.#advanceLog();
      return;
    }
    this.#captureSnapshot();
  }

  /** A snapshot must advance the relay's base. With nothing new in the log, append the empty update first. */
  #advanceLog() {
    if (this.#policy.quotaReached) {
      this.#announceRoomFull();
      return;
    }
    if (this.#pending.list().some((entry) => !entry.oversized && !entry.held)) return;
    this.#sendEntries([this.#pending.add(EMPTY_UPDATE)]);
    this.#emitDelivery();
  }

  #captureSnapshot() {
    // The state and its baseSeq are taken in one synchronous step, so the snapshot never claims a seq it lacks.
    const baseSeq = this.#coverage.appliedSeq;
    const state = Y.encodeStateAsUpdate(this.doc);
    const knownBase = this.#appliedSnapshotBase;
    const inflight = { baseSeq, knownBase, covered: this.#pending.refs(), serial: Number.POSITIVE_INFINITY };
    this.#snapshot = inflight;
    this.#policy.attempted(this.#timers.now());
    this.#queueOutgoing(async (generation) => {
      const ciphertext = await this.#cipher.encryptFrame(this.#key.dek, this.#aad(AAD_KIND.SNAPSHOT, baseSeq), state);
      if (generation !== this.#generation || this.#snapshot !== inflight) return;
      if (ciphertext.byteLength > this.#maxSnapshotBytes) {
        this.#snapshot = null;
        this.#announceRoomFull();
        return;
      }
      inflight.serial = this.#send(encodeFrame(E2E_FRAME.SNAPSHOT, { seq: baseSeq, knownBase, ciphertext }));
      this.#sendEntries([this.#pending.add(EMPTY_UPDATE)]);
      this.#emitDelivery();
    });
  }

  #provesSnapshot(entry) {
    return this.#snapshot !== null && entry.sentSerial > this.#snapshot.serial;
  }

  #snapshotAccepted() {
    const { baseSeq, covered } = this.#snapshot;
    this.#snapshot = null;
    this.#appliedSnapshotBase = baseSeq;
    this.#roomFullAnnounced = false;
    this.#policy.logPruned();
    this.#pending.removeAll(covered);
    this.#emitDelivery();
    this.#resend((entry) => entry.held);
  }

  // The captured entries stay pending: only proof of an accepted snapshot removes them.
  #snapshotRejected(code) {
    if (this.#snapshot === null) return;
    const { knownBase } = this.#snapshot;
    this.#snapshot = null;
    if (code === E2E_REJECT.QUOTA) this.#announceRoomFull();
    // Another snapshot is stored or on its way: build the next one on top of it once it has been applied here.
    // When the winner already arrived (its SNAPSHOT_OUT reaches us before our REJECT), nothing more is coming.
    else if (code === E2E_REJECT.STALE_SNAPSHOT && this.#appliedSnapshotBase <= knownBase) this.#awaitingPeerSnapshot = true;
    else this.#scheduleSnapshot();
  }

  #announceRoomFull() {
    if (this.#roomFullAnnounced) return;
    this.#roomFullAnnounced = true;
    this.#dispatch(E2E_ROOM_FULL_EVENT);
  }

  // ---- awareness -----------------------------------------------------------------------------------

  /** Falling behind is advertised at once; catching up only after it held for the settle time. */
  #publishE2ESynced() {
    if (!this.e2eSynced) {
      if (this.#syncedTimer !== null) this.#timers.clearTimeout(this.#syncedTimer);
      this.#syncedTimer = null;
      this.#advertiseSynced(false);
      return;
    }
    if (this.#syncedTimer !== null || this.awareness.getLocalState()?.[E2E_SYNCED_FIELD] === true) return;
    this.#syncedTimer = this.#timers.setTimeout(() => {
      this.#syncedTimer = null;
      this.#advertiseSynced(this.e2eSynced);
    }, this.#syncedSettleMs);
  }

  #advertiseSynced(value) {
    const state = this.awareness.getLocalState();
    if (state && state[E2E_SYNCED_FIELD] !== value) this.awareness.setLocalStateField(E2E_SYNCED_FIELD, value);
  }

  /** Sends this page's own awareness state; changes made while one send is encrypting coalesce into the next. */
  #sendAwareness() {
    if (!this.wsconnected) return;
    if (this.#awarenessBusy) {
      this.#awarenessDirty = true;
      return;
    }
    this.#awarenessBusy = true;
    const generation = this.#generation;
    const update = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
    this.#cipher.encryptFrame(this.#key.dek, this.#aad(AAD_KIND.EPHEMERAL), update).then((ciphertext) => {
      if (generation === this.#generation && ciphertext.byteLength <= E2E_EPHEMERAL_MAX_BYTES) {
        this.#send(encodeFrame(E2E_FRAME.EPHEMERAL, { ciphertext }));
      }
    }).catch(reportFailure).finally(() => {
      this.#awarenessBusy = false;
      if (!this.#awarenessDirty) return;
      this.#awarenessDirty = false;
      this.#sendAwareness();
    });
  }

  #receiveAwareness(ciphertext, generation) {
    this.#cipher.decryptFrame(this.#key.dek, this.#aad(AAD_KIND.EPHEMERAL), ciphertext).then((plaintext) => {
      if (generation === this.#generation) applyAwarenessUpdate(this.awareness, plaintext, this);
    }).catch(() => { /* Unreadable or malformed presence is dropped; it carries no document state. */ });
  }
}
