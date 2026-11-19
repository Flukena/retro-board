import { evictOldestBucket, refillTokens, tokenWaitSeconds } from './relay-rate-bucket.js';
import { MILLISECONDS_PER_HOUR, MILLISECONDS_PER_MINUTE } from './relay-config.js';
const MINUTES_PER_HOUR = MILLISECONDS_PER_HOUR / MILLISECONDS_PER_MINUTE;
const GLOBAL_BUCKET_KEY = 'global';
const ADMISSION_TOKEN_COST = 1;

export function createAdmissionLimits(config, rateBuckets, readNow = () => Date.now()) {
  const {
    COLD_ROOM_OPENS_PER_IP_PER_MINUTE,
    COLD_ROOM_OPENS_PER_ROOM_PER_MINUTE,
    COLD_ROOM_OPEN_IP_BURST,
    COLD_ROOM_OPEN_ROOM_BURST,
    GLOBAL_COLD_ROOM_OPENS_PER_MINUTE,
    GLOBAL_COLD_ROOM_OPEN_BURST,
    GLOBAL_ROOM_CREATES_PER_MINUTE,
    GLOBAL_ROOM_CREATE_BURST,
    GLOBAL_SESSION_EXCHANGES_PER_MINUTE,
    GLOBAL_SESSION_EXCHANGE_BURST,
    GLOBAL_WS_UPGRADES_PER_MINUTE,
    GLOBAL_WS_UPGRADE_BURST,
    MAX_BUCKETS,
    ROOM_CREATES_PER_HOUR,
    ROOM_CREATE_BURST,
    SESSION_EXCHANGES_PER_MINUTE,
    SESSION_EXCHANGE_BURST,
    SESSION_FAILURES_PER_HOUR,
    SESSION_FAILURE_BURST,
    WS_UPGRADES_PER_IP_PER_MINUTE,
    WS_UPGRADES_PER_ROOM_PER_MINUTE,
    WS_UPGRADE_IP_BURST,
    WS_UPGRADE_ROOM_BURST,
  } = config;
  const getRateBucket = (map, key, burst, perHour) => {
    const now = readNow();
    let bucket = map.get(key);
    if (!bucket) {
      evictOldestBucket(map, MAX_BUCKETS);
      bucket = { tokens: burst, last: now, lastSeen: now };
      map.set(key, bucket);
    }
    bucket.tokens = refillTokens(bucket.tokens, burst, now - bucket.last, perHour, MILLISECONDS_PER_HOUR);
    bucket.last = now;
    bucket.lastSeen = now;
    return bucket;
  };
  const takeCreateToken = (ip) => {
    const ipBucket = getRateBucket(rateBuckets.roomCreate, ip, ROOM_CREATE_BURST, ROOM_CREATES_PER_HOUR);
    const globalRefillPerHour = GLOBAL_ROOM_CREATES_PER_MINUTE * MILLISECONDS_PER_HOUR / MILLISECONDS_PER_MINUTE;
    const globalBucket = getRateBucket(
      rateBuckets.roomCreateGlobal,
      GLOBAL_BUCKET_KEY,
      GLOBAL_ROOM_CREATE_BURST,
      globalRefillPerHour,
    );
    const wait = Math.max(tokenWaitSeconds(ipBucket.tokens, ROOM_CREATES_PER_HOUR), tokenWaitSeconds(globalBucket.tokens, globalRefillPerHour));
    if (wait) return wait;
    ipBucket.tokens -= ADMISSION_TOKEN_COST;
    globalBucket.tokens -= ADMISSION_TOKEN_COST;
    return 0;
  };
  const takeSessionExchangeToken = (ip) => {
    const ipBucket = getRateBucket(
      rateBuckets.sessionExchange,
      ip,
      SESSION_EXCHANGE_BURST,
      SESSION_EXCHANGES_PER_MINUTE * MINUTES_PER_HOUR,
    );
    const globalBucket = getRateBucket(
      rateBuckets.sessionExchangeGlobal,
      GLOBAL_BUCKET_KEY,
      GLOBAL_SESSION_EXCHANGE_BURST,
      GLOBAL_SESSION_EXCHANGES_PER_MINUTE * MINUTES_PER_HOUR,
    );
    if (ipBucket.tokens < ADMISSION_TOKEN_COST || globalBucket.tokens < ADMISSION_TOKEN_COST) return false;
    ipBucket.tokens -= ADMISSION_TOKEN_COST;
    globalBucket.tokens -= ADMISSION_TOKEN_COST;
    return true;
  };
  const failureAttemptAvailable = (ip) => (
    getRateBucket(rateBuckets.sessionFailure, ip, SESSION_FAILURE_BURST, SESSION_FAILURES_PER_HOUR).tokens >= ADMISSION_TOKEN_COST
  );
  const recordSessionFailure = (ip) => {
    const bucket = getRateBucket(rateBuckets.sessionFailure, ip, SESSION_FAILURE_BURST, SESSION_FAILURES_PER_HOUR);
    bucket.tokens = Math.max(0, bucket.tokens - ADMISSION_TOKEN_COST);
  };

  const takeWsUpgradeToken = (ip, docName, coldRoom) => {
    const reservations = [
      getRateBucket(
        rateBuckets.wsUpgradeIp,
        ip,
        WS_UPGRADE_IP_BURST,
        WS_UPGRADES_PER_IP_PER_MINUTE * MINUTES_PER_HOUR,
      ),
      getRateBucket(
        rateBuckets.wsUpgradeRoom,
        docName,
        WS_UPGRADE_ROOM_BURST,
        WS_UPGRADES_PER_ROOM_PER_MINUTE * MINUTES_PER_HOUR,
      ),
      getRateBucket(
        rateBuckets.wsUpgradeGlobal,
        GLOBAL_BUCKET_KEY,
        GLOBAL_WS_UPGRADE_BURST,
        GLOBAL_WS_UPGRADES_PER_MINUTE * MINUTES_PER_HOUR,
      ),
    ];
    if (coldRoom) {
      reservations.push(
        getRateBucket(
          rateBuckets.coldRoomOpenIp,
          ip,
          COLD_ROOM_OPEN_IP_BURST,
          COLD_ROOM_OPENS_PER_IP_PER_MINUTE * MINUTES_PER_HOUR,
        ),
        getRateBucket(
          rateBuckets.coldRoomOpenRoom,
          docName,
          COLD_ROOM_OPEN_ROOM_BURST,
          COLD_ROOM_OPENS_PER_ROOM_PER_MINUTE * MINUTES_PER_HOUR,
        ),
        getRateBucket(
          rateBuckets.coldRoomOpenGlobal,
          GLOBAL_BUCKET_KEY,
          GLOBAL_COLD_ROOM_OPEN_BURST,
          GLOBAL_COLD_ROOM_OPENS_PER_MINUTE * MINUTES_PER_HOUR,
        ),
      );
    }
    if (reservations.some((bucket) => bucket.tokens < ADMISSION_TOKEN_COST)) return false;
    for (const bucket of reservations) bucket.tokens -= ADMISSION_TOKEN_COST;
    return true;
  };

  return { takeCreateToken, takeSessionExchangeToken, failureAttemptAvailable, recordSessionFailure, takeWsUpgradeToken };
}
