export const keyOf = (scope, key, clientId) => `${scope}|${clientId}|${key}`;
export const userKey = (clientId, key) => keyOf('u', key, clientId);
export const userKeyPrefix = clientId => userKey(clientId, '');

export function parseKvKey(mapKey) {
  const first = mapKey.indexOf('|');
  const second = mapKey.indexOf('|', first + 1);
  if (first < 0 || second < 0) return null;
  return { scope: mapKey.slice(0, first), clientId: mapKey.slice(first + 1, second), key: mapKey.slice(second + 1) };
}
