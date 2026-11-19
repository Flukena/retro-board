import { readVoteResultParticipants } from '../../../domain/vote-result-participants.js';
import { readPlayerPresence, normalizePlayerCursor, normalizePlayerView } from '../player-cursors.js';

export function createAwarenessPresence({ provider, motionPublisher, emitter }) {
  // ---------------------------------------------------------------------------
  // Presence — via Yjs awareness.
  //
  // The old design stored the entire {userId -> {name, lastSeen}} map under a
  // single shared Y.Map key. Every client read-modify-wrote the whole blob on
  // each heartbeat tick, so concurrent heartbeats LWW-trampled each other and
  // users disappeared from peers' lists ("same link, looks like different
  // rooms"). Awareness gives each connection its own slot — writes are
  // conflict-free, and slots auto-clear when the WebSocket drops.
  // ---------------------------------------------------------------------------
  const presenceEmitter = new EventTarget();
  const busyEmitter = new EventTarget();
  const editingEmitter = new EventTarget();
  const selectionEmitter = new EventTarget();
  const AWARENESS_MAX_ITEM_IDS = 256;
  const AWARENESS_MAX_ITEM_ID_LENGTH = 128;
  const localBusySources = {
    text: new Set(),
    geometry: new Set(),
  };
  const normalizeBusyIds = (ids) => Array.from(new Set(
    (Array.isArray(ids) || ids instanceof Set ? Array.from(ids) : [])
      .filter((id) => typeof id === 'string'
        && id.length > 0
        && id.length <= AWARENESS_MAX_ITEM_ID_LENGTH),
  )).sort().slice(0, AWARENESS_MAX_ITEM_IDS);
  const setLocalBusyItems = (source, ids) => {
    if (!provider || (source !== 'text' && source !== 'geometry')) return;
    const normalized = normalizeBusyIds(ids);
    localBusySources[source] = new Set(source === 'text' ? normalized.slice(0, 1) : normalized);
    const busyItems = normalizeBusyIds([
      ...localBusySources.text,
      ...localBusySources.geometry,
    ]);
    const editingItemId = Array.from(localBusySources.text)[0] || null;
    const localState = provider.awareness.getLocalState() || {};
    const current = normalizeBusyIds(localState.busyItems);
    const busyUnchanged = current.length === busyItems.length
      && current.every((id, i) => id === busyItems[i]);
    if (busyUnchanged && (localState.editingItemId || null) === editingItemId) return;
    provider.awareness.setLocalState({
      ...localState,
      busyItems: busyItems.length ? busyItems : null,
      editingItemId,
    });
  };
  const readRemoteBusyOwners = () => {
    const out = new Map();
    if (!provider) return out;
    provider.awareness.getStates().forEach((state, awarenessClientId) => {
      if (awarenessClientId === provider.awareness.clientID) return;
      normalizeBusyIds(state?.busyItems).forEach((itemId) => {
        let owners = out.get(itemId);
        if (!owners) { owners = new Map(); out.set(itemId, owners); }
        owners.set(awarenessClientId, state?.user || null);
      });
    });
    return out;
  };
  const remoteBusySignature = (busy) => Array.from(busy.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([itemId, owners]) => `${itemId}:${Array.from(owners.keys()).sort((a, b) => a - b).join(',')}`)
    .join('|');
  let lastRemoteBusySignature = '';
  const readRemoteEditingOwners = () => {
    const out = new Map();
    if (!provider) return out;
    provider.awareness.getStates().forEach((state, awarenessClientId) => {
      if (awarenessClientId === provider.awareness.clientID) return;
      const itemId = typeof state?.editingItemId === 'string' ? state.editingItemId : '';
      if (!itemId) return;
      let owners = out.get(itemId);
      if (!owners) { owners = new Map(); out.set(itemId, owners); }
      owners.set(awarenessClientId, state?.user || null);
    });
    return out;
  };
  const remoteIdentitySignature = (editing) => Array.from(editing.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([itemId, owners]) => `${itemId}:${Array.from(owners.entries())
      .sort(([a], [b]) => a - b)
      .map(([clientId, user]) => `${clientId}:${user?.userId || ''}:${user?.name || ''}`)
      .join(',')}`)
    .join('|');
  let lastRemoteEditingSignature = '';
  const readRemoteSelectionOwners = () => {
    const out = new Map();
    if (!provider) return out;
    provider.awareness.getStates().forEach((state, awarenessClientId) => {
      if (awarenessClientId === provider.awareness.clientID) return;
      normalizeBusyIds(state?.selectedItems).forEach((itemId) => {
        let owners = out.get(itemId);
        if (!owners) { owners = new Map(); out.set(itemId, owners); }
        owners.set(awarenessClientId, state?.user || null);
      });
    });
    return out;
  };
  let lastRemoteSelectionSignature = '';
  const readPresenceMap = () => readPlayerPresence(
    provider?.awareness.getStates() || new Map(), provider?.awareness.meta,
  );

  if (provider) {
    provider.awareness.on('change', () => {
      const busy = readRemoteBusyOwners();
      const signature = remoteBusySignature(busy);
      if (signature !== lastRemoteBusySignature) {
        lastRemoteBusySignature = signature;
        busyEmitter.dispatchEvent(new CustomEvent('change', { detail: busy }));
      }
      const editing = readRemoteEditingOwners();
      const editingSignature = remoteIdentitySignature(editing);
      if (editingSignature !== lastRemoteEditingSignature) {
        lastRemoteEditingSignature = editingSignature;
        editingEmitter.dispatchEvent(new CustomEvent('change', { detail: editing }));
      }
      const selection = readRemoteSelectionOwners();
      const selectionSignature = remoteIdentitySignature(selection);
      if (selectionSignature !== lastRemoteSelectionSignature) {
        lastRemoteSelectionSignature = selectionSignature;
        selectionEmitter.dispatchEvent(new CustomEvent('change', { detail: selection }));
      }
      const presence = readPresenceMap();
      presenceEmitter.dispatchEvent(new CustomEvent('change', { detail: presence }));
      // Fan into the main change emitter so existing storage.on('change')
      // handlers (RetroBoard's applyRemoteBoard router) keep receiving
      // presence updates the same way they used to.
      emitter.dispatchEvent(new CustomEvent('change', {
        detail: { scope: 's', key: 'presence', value: presence },
      }));
    });
  }

  const writeLegacyPresence = (value) => {
    // Backward-compat shim: callers still pass the FULL pmap. The only
    // entry we actually own is the one with the freshest lastSeen — that's
    // the one this client just refreshed in its heartbeat. Lift it into
    // our awareness slot so peers see it without LWW-trampling.
    if (provider) {
      let mine = null;
      Object.values(value).forEach((p) => {
        if (!p || typeof p !== 'object') return;
        if (!mine || (p.lastSeen || 0) > (mine.lastSeen || 0)) mine = p;
      });
      if (mine) provider.awareness.setLocalStateField('user', mine);
    }
  };

  return {
    readPresenceMap,
    writeLegacyPresence,
    methods: {
      getPresenceSnapshot() { return readPresenceMap(); },
      getVoteResultParticipants(atTime = Date.now()) { return readVoteResultParticipants(provider?.awareness, atTime); },
      onPresenceChange(handler) {
        presenceEmitter.addEventListener('change', handler);
        return () => presenceEmitter.removeEventListener('change', handler);
      },
      offPresenceChange(handler) { presenceEmitter.removeEventListener('change', handler); },
      setLocalBusyItems,
      findRemoteBusyItem(ids) {
        const busy = readRemoteBusyOwners();
        for (const itemId of normalizeBusyIds(ids)) {
          const owners = busy.get(itemId);
          if (!owners) continue;
          const [clientID, user] = owners.entries().next().value;
          return { itemId, clientID, user };
        }
        return null;
      },
      getRemoteBusyItems() { return readRemoteBusyOwners(); },
      onBusyChange(handler) {
        busyEmitter.addEventListener('change', handler);
        return () => busyEmitter.removeEventListener('change', handler);
      },
      offBusyChange(handler) { busyEmitter.removeEventListener('change', handler); },
      getRemoteEditingItems() { return readRemoteEditingOwners(); },
      onEditingChange(handler) {
        editingEmitter.addEventListener('change', handler);
        return () => editingEmitter.removeEventListener('change', handler);
      },
      offEditingChange(handler) { editingEmitter.removeEventListener('change', handler); },
      setLocalSelectedItems(ids) {
        if (!provider) return;
        const selectedItems = normalizeBusyIds(ids);
        const localState = provider.awareness.getLocalState() || {};
        const current = normalizeBusyIds(localState.selectedItems);
        const unchanged = current.length === selectedItems.length
          && current.every((id, index) => id === selectedItems[index]);
        if (unchanged) return;
        provider.awareness.setLocalStateField(
          'selectedItems',
          selectedItems.length ? selectedItems : null,
        );
      },
      getRemoteSelectedItems() { return readRemoteSelectionOwners(); },
      onSelectionChange(handler) {
        selectionEmitter.addEventListener('change', handler);
        return () => selectionEmitter.removeEventListener('change', handler);
      },
      offSelectionChange(handler) { selectionEmitter.removeEventListener('change', handler); },
      setLocalCursor(cursor) {
        if (!motionPublisher) return;
        if (cursor == null) { motionPublisher.set('cursor', null); return; }
        const normalized = normalizePlayerCursor({ ...cursor, updatedAt: Date.now() });
        if (normalized) motionPublisher.set('cursor', normalized);
      },
      setLocalView(view) {
        if (!motionPublisher) return;
        if (view == null) { motionPublisher.set('view', null); return; }
        const normalized = normalizePlayerView({ ...view, updatedAt: Date.now() });
        if (normalized) motionPublisher.set('view', normalized);
      },

    },
  };
}
