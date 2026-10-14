const HTTP_RATE_LIMIT_STATUS = 429;
const HTTP_UNAVAILABLE_STATUS = 503;
const HTTP_STORAGE_CAPACITY_STATUS = 507;
const HTTP_REJECTION_STATUSES = new Set([HTTP_RATE_LIMIT_STATUS, HTTP_UNAVAILABLE_STATUS, HTTP_STORAGE_CAPACITY_STATUS]);
const HTTP_REASON = 'http';
const UPGRADE_REASON = 'upgrade';
const STORAGE_BACKLOG_REASON = 'storage-backlog';
const POLICY_CLOSE_CODE = 1008;
const SUMMARY_LOG = '[yjs] rejection summary';

export const createRejectionCounters = (log) => {
  const counts = new Map();
  let changed = false;
  const increment = (reason, status) => {
    const key = `${reason}:${status}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    changed = true;
  };
  const observeResponse = (res) => {
    res.once('finish', () => {
      if (HTTP_REJECTION_STATUSES.has(res.statusCode)) increment(HTTP_REASON, res.statusCode);
    });
  };
  const flush = () => {
    if (!changed) return;
    log(SUMMARY_LOG, Object.fromEntries(counts));
    changed = false;
  };
  const upgrade = (status) => increment(UPGRADE_REASON, status);
  const storageBacklog = () => increment(STORAGE_BACKLOG_REASON, POLICY_CLOSE_CODE);
  const observeBacklog = (pendingOpsCount, pendingBytes, maxOpsCount, maxBytes) => {
    if (pendingOpsCount >= maxOpsCount || pendingBytes >= maxBytes) storageBacklog();
  };
  return { increment, upgrade, storageBacklog, observeBacklog, observeResponse, flush };
};
