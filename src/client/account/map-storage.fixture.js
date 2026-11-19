// A Map-backed stand-in for localStorage, shared by the account tests.
export const mapStorage = (map = new Map()) => ({
  getItem: (key) => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => { map.set(key, String(value)); },
  removeItem: (key) => { map.delete(key); },
});
