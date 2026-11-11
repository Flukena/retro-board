import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { ORIGIN, cookiePair, lockedRelay, signInSetCookie } from './locked-room-harness.mjs';
import { installBrowserStandIn } from './browser-stand-in.mjs';
import { E2EProvider } from '../client/session/e2e-provider.js';
import { attachE2ERoom } from '../client/session/e2e-room.js';
import { KEY_ROTATED_EVENT, clearRoomKey, getRoomKey, unlockRoom } from '../client/room-lock/lock-session.js';
import { deriveRoomSecrets, unwrapRoomKey } from '../client/room-lock/e2e-crypto.js';

// Captured before any test swaps in the browser stand-in: peers and checks talk to the relay without the page's jar.
const relayFetch = globalThis.fetch;
const STATUS = Object.freeze({ OK: 200, CREATED: 201, CONFLICT: 409 });
const PROVIDER_OPTIONS = Object.freeze({ random: () => 0, syncedSettleMs: 0 });

/** Holds a page's inbound socket messages while `held`, then delivers them in order on release. */
export class InboundGate {
  held = false;
  #queue = [];

  deliver(handler) {
    if (this.held) this.#queue.push(handler);
    else handler();
  }

  hold() { this.held = true; }

  release() {
    this.held = false;
    this.#queue.splice(0).forEach((handler) => handler());
  }
}

/** A WebSocket class that sends the page Origin and the cookie `cookie(url)` returns when it connects. */
export function cookieSocket(cookie, gate = null) {
  return class CookieSocket extends WebSocket {
    constructor(url) {
      super(url, { origin: ORIGIN, headers: { cookie: cookie(url) } });
    }

    get onmessage() { return super.onmessage; }

    set onmessage(handler) {
      super.onmessage = gate ? (event) => gate.deliver(() => handler(event)) : handler;
    }
  };
}

const postJson = (relay, path, body, cookie) => relayFetch(`${relay.url}${path}`, {
  method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});

/** A peer's two-step exchange with `password`: its own room cookie and the room key it unwraps. Throws on a refusal. */
export async function peerSession(relay, room, password) {
  const first = await postJson(relay, '/api/room-session', { code: room.code, token: room.token });
  assert.equal(first.status, STATUS.CONFLICT);
  const hint = await first.json();
  const { kek, authKey } = await deriveRoomSecrets(password, hint.salt, hint.kdf);
  const second = await postJson(relay, '/api/room-session', { code: room.code, token: room.token, authKey });
  if (second.status !== STATUS.OK) throw Object.assign(new Error('peer exchange refused'), { status: second.status });
  const { roomHandle, lock } = await second.json();
  const dek = await unwrapRoomKey(kek, lock.wrappedDek, lock.wrapIv);
  return { cookie: cookiePair(second.headers.get('set-cookie')), key: { roomHandle, keyEpoch: lock.keyEpoch, dek } };
}

/**
 * A real relay with a locked room created by a signed-in owner, and this process as the owner's page: the browser
 * stand-in (with the account cookie) and the real lock-session, unlocked with `password`. Its window is an event
 * target, so lock-session and the providers talk through it as in the browser.
 */
export async function ownerBoard(t, { roomLock, password, relayEnv = {} }) {
  const env = await lockedRelay(t, relayEnv);
  const ownerSetCookie = await signInSetCookie(env);
  const created = await postJson(env.relay, '/api/rooms', { lock: roomLock.lock }, cookiePair(ownerSetCookie));
  assert.equal(created.status, STATUS.CREATED, env.relay.output());
  const room = await created.json();
  const browser = installBrowserStandIn(t, env.relay.url, null, { cookies: [ownerSetCookie] });
  const events = new EventTarget();
  Object.assign(globalThis.window, {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  });
  t.after(clearRoomKey);
  await unlockRoom({ code: room.code, token: room.token, password, lockHint: { salt: roomLock.lock.salt, kdf: roomLock.lock.kdf } });
  const pages = [];
  t.after(() => pages.forEach(({ provider, doc }) => { provider.destroy(); doc.destroy(); }));
  const wsBase = `${env.relay.wsUrl}/rooms`;
  // `rotations` counts the 4001 closes the page saw.
  const track = (page, target) => {
    pages.push(page);
    target.addEventListener(KEY_ROTATED_EVENT, () => { page.rotations += 1; });
    return page;
  };
  return {
    env, room, browser, relayFetch,
    /** The owner's board page: the real provider and rotation source, keyed through lock-session. */
    openOwnerPage({ gate = null } = {}) {
      const doc = new Y.Doc();
      const provider = new E2EProvider(wsBase, getRoomKey().roomHandle, doc, {
        key: getRoomKey(), WebSocketImpl: cookieSocket(browser.cookieHeader, gate), eventTarget: globalThis.window, ...PROVIDER_OPTIONS,
      });
      const storage = attachE2ERoom({ provider, ydoc: doc, eventTarget: globalThis.window, getRoomKey, clearUndo: () => {} });
      return track({ rotations: 0, doc, provider, storage }, globalThis.window);
    },
    /** Another member's page with its own cookie; `reunlock(password)` re-runs its exchange after a rotation. */
    async openPeerPage(peerPassword) {
      let session = await peerSession(env.relay, room, peerPassword);
      const doc = new Y.Doc();
      const target = new EventTarget();
      const provider = new E2EProvider(wsBase, session.key.roomHandle, doc, {
        key: session.key, WebSocketImpl: cookieSocket(() => session.cookie), eventTarget: target, ...PROVIDER_OPTIONS,
      });
      const page = track({ rotations: 0, doc, provider }, target);
      page.reunlock = async (nextPassword) => {
        session = await peerSession(env.relay, room, nextPassword);
        provider.setKey(session.key);
        return session.key;
      };
      page.key = () => session.key;
      return page;
    },
  };
}
