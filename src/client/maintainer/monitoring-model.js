export const HISTORY_LIMIT_SAMPLES = 720;
export const WARNING_USAGE_RATIO = 0.8;
export const CRITICAL_USAGE_RATIO = 0.95;
const MILLISECONDS_PER_SECOND = 1000;
const HISTORY_GAP_MS = 15 * MILLISECONDS_PER_SECOND;

export function selectRooms(rooms, query, filter, sort) {
  const search = query.trim().toLowerCase();
  const matches = room => ({
    all: true, active: room.connections > 0, blocked: Boolean(room.blockedUntil),
    resident: room.resident, cold: !room.resident,
  })[filter];
  const value = room => ({ connections: room.connections, uploads: room.uploadBytes, document: room.documentBytesUpperBound })[sort];
  return rooms.filter(room => room.handle.toLowerCase().includes(search) && matches(room)).sort((left, right) => {
    if (sort === 'handle') return left.handle.localeCompare(right.handle);
    const difference = (value(right) ?? -1) - (value(left) ?? -1);
    return difference || left.handle.localeCompare(right.handle);
  });
}

export function appendHistory(history, data) {
  const at = Date.parse(data.at);
  if (!Number.isFinite(at)) return history;
  const last = history.at(-1);
  if (last?.at === at) return history;
  const retained = last && at < last.at ? [] : history;
  return [...retained, {
    at, clients: data.rooms.reduce((total, room) => total + room.connections, 0),
    memory: data.memory.rss, database: data.databaseBytes, uploads: data.uploadBytes,
  }].slice(-HISTORY_LIMIT_SAMPLES);
}

export function resourceAlerts(data) {
  const resources = [
    ['database', data.databaseBytes, data.limits.databaseBytes],
    ['uploads', data.uploadBytes, data.limits.uploadBytes],
    ['activeDocuments', data.activeDocumentBytes, data.limits.activeDocumentBytes],
    ['heap', data.memory.heapUsed, data.memory.heapLimit],
    ['backlog', data.pendingStoreBytes, data.limits.pendingStoreBytes],
    ['backlog', data.pendingStoreOps, data.limits.pendingStoreOps],
  ];
  const alerts = new Map();
  for (const [resource, used, limit] of resources) {
    if (!(limit > 0) || used / limit < WARNING_USAGE_RATIO) continue;
    const severity = used / limit >= CRITICAL_USAGE_RATIO ? 'critical' : 'warning';
    if ((alerts.get(resource)?.percent ?? 0) >= Math.round(used / limit * 100)) continue;
    alerts.set(resource, { resource, severity, percent: Math.round(used / limit * 100) });
  }
  return [...alerts.values()];
}

export function chartSegments(history, field, width, height) {
  const maximum = Math.max(1, ...history.map(point => point[field]));
  const start = history[0]?.at ?? 0;
  const span = Math.max(1, (history.at(-1)?.at ?? start) - start);
  const segments = [];
  for (const [index, point] of history.entries()) {
    if (!index || point.at - history[index - 1].at > HISTORY_GAP_MS) segments.push([]);
    const x = (point.at - start) / span * width;
    const y = height - point[field] / maximum * height;
    segments.at(-1).push(`${x},${y}`);
  }
  return { segments: segments.map(segment => segment.join(' ')), maximum };
}
