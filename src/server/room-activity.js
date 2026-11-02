export const ROOM_ACTIVITY_META = 'retro-room-activity-v1';
export const ACTIVITY_FLUSH_INTERVAL_MS = 60_000;
const timestamp = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const decodeActivity = value => ({
  createdAt: timestamp(value?.createdAt),
  lastSessionAt: timestamp(value?.lastSessionAt),
  lastActiveAt: timestamp(value?.lastActiveAt),
  trackedSinceAt: timestamp(value?.trackedSinceAt),
});
const hasAnyTime = (record) => Object.values(record).some((time) => time !== null);

// One pending record per registered room; writes coalesce across tabs and events.
export class RoomActivity {
  #records = new Map();
  #dirty = new Set();
  #storage;
  #flushing;
  #timer;

  constructor(storage) { this.#storage = storage; }
  get(docName) { return this.#records.get(docName) ?? decodeActivity(null); }
  // A room from before activity tracking gets the time tracking began, so its
  // idle time is measured from a known point instead of guessed or ignored.
  async hydrate(docName, now = Date.now()) {
    let record = decodeActivity(await this.#storage.getMeta(docName, ROOM_ACTIVITY_META));
    if (!hasAnyTime(record)) {
      record = { ...record, trackedSinceAt: now };
      await this.#storage.setMeta(docName, ROOM_ACTIVITY_META, record);
    }
    this.#records.set(docName, record);
  }
  async create(docName, now = Date.now()) {
    const record = { ...decodeActivity(null), createdAt: now };
    await this.#storage.setMeta(docName, ROOM_ACTIVITY_META, record);
    this.#records.set(docName, record);
  }
  forget(docName) { this.#records.delete(docName); this.#dirty.delete(docName); }
  touch(docName, { session = false, now = Date.now() } = {}) {
    if (!this.#records.has(docName)) return;
    const prior = this.get(docName);
    const lastActiveAt = Math.max(prior.lastActiveAt ?? 0, now);
    const lastSessionAt = session ? Math.max(prior.lastSessionAt ?? 0, now) : prior.lastSessionAt;
    if (lastActiveAt === prior.lastActiveAt && lastSessionAt === prior.lastSessionAt) return;
    this.#records.set(docName, { ...prior, lastActiveAt, lastSessionAt });
    this.#dirty.add(docName);
  }
  flush() {
    this.#flushing ??= this.#writePending().finally(() => { this.#flushing = null; });
    return this.#flushing;
  }
  async #writePending() {
    for (const docName of [...this.#dirty]) {
      const record = this.get(docName);
      await this.#storage.setMeta(docName, ROOM_ACTIVITY_META, record);
      if (this.get(docName) === record) this.#dirty.delete(docName);
    }
  }
  watch(wss, onFailure) {
    this.#timer = setInterval(() => {
      for (const conn of wss.clients) this.touch(conn.activityDocName);
      void this.flush().catch(onFailure);
    }, ACTIVITY_FLUSH_INTERVAL_MS);
    this.#timer.unref();
    wss.on('connection', (conn, req) => {
      const docName = req.wsSecurityContext?.docName;
      conn.activityDocName = docName;
      this.touch(docName, { session: true });
      conn.once('close', () => this.touch(docName));
    });
  }
  async stop() {
    clearInterval(this.#timer);
    await this.flush();
    if (this.#dirty.size) await this.flush();
  }
}
