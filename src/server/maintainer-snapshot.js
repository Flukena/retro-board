import { getHeapStatistics } from 'node:v8';

const MILLISECONDS_PER_SECOND = 1000;
const OPERATIONAL_COLLECTIONS = new Set(['items', 'kv', 'meta', '__drawingPreviews']);

function collectionCounts(doc) {
  return Object.fromEntries([...doc.share]
    .filter(([name]) => OPERATIONAL_COLLECTIONS.has(name))
    .map(([name, collection]) => [name, collection.size ?? collection.length ?? null]));
}

// Never hydrate cold rooms or include capabilities, document keys, or user data.
export function maintainerRooms({ registry, docs, connections, blockedRooms, roomUsage, now = Date.now() }) {
  return [...registry.registeredRoomsByHandle].map(([handle, docName]) => {
    // An encrypted room's content is ciphertext the relay cannot read: list it, never inspect it.
    const encrypted = registry.isLocked(docName);
    const doc = encrypted ? undefined : docs.get(docName);
    const usage = registry.roomUploadUsage.get(docName);
    return {
      handle,
      createdAt: registry.activity?.get(docName).createdAt ?? null,
      lastSessionAt: registry.activity?.get(docName).lastSessionAt ?? null,
      trackedSinceAt: registry.activity?.get(docName).trackedSinceAt ?? null,
      lastActiveAt: (connections.get(docName) ?? 0) > 0 ? now : registry.activity?.get(docName).lastActiveAt ?? null,
      connections: connections.get(docName) ?? 0,
      resident: Boolean(doc),
      blockedUntil: (blockedRooms.get(docName) ?? 0) > now ? blockedRooms.get(docName) : null,
      documentBytesUpperBound: doc ? roomUsage.get(doc)?.upperBytes ?? null : null,
      uploadBytes: usage?.bytes ?? 0,
      uploadFiles: usage?.files ?? 0,
      collections: doc ? collectionCounts(doc) : null,
      encrypted,
      // The retention class only: the owner account is user data and never listed here.
      retention: registry.ownershipOf(docName).retention,
    };
  });
}

export function maintainerSnapshot({ registry, docs, connections, blockedRooms, roomUsage, ...status }) {
  return {
    at: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    memory: { ...process.memoryUsage(), heapLimit: getHeapStatistics().heap_size_limit },
    ...status,
    rooms: maintainerRooms({ registry, docs, connections, blockedRooms, roomUsage }),
    refreshSeconds: MAINTAINER_REFRESH_MS / MILLISECONDS_PER_SECOND,
  };
}

export const MAINTAINER_REFRESH_MS = 5000;
