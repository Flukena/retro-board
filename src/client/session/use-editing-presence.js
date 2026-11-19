import { useEffect, useState } from 'react';

const CHANNEL_METHODS = {
  editing: { read: 'getRemoteEditingItems', subscribe: 'onEditingChange' },
  selection: { read: 'getRemoteSelectedItems', subscribe: 'onSelectionChange' },
};

export function createEditingPresenceChannel(storage, kind, publish) {
  const { read, subscribe } = CHANNEL_METHODS[kind];
  const refresh = (event) => {
    const next = event?.detail instanceof Map ? event.detail : storage[read]();
    publish(new Map(next));
  };
  refresh();
  const unsubscribe = storage[subscribe](refresh);
  return { dispose: () => unsubscribe?.() };
}

export function createLocalEditingPresence(storage) {
  return {
    publishSelected: (ids) => storage.setLocalSelectedItems(ids),
    dispose: () => {
      storage.setLocalBusyItems('text', []);
      storage.setLocalSelectedItems([]);
    },
  };
}

// State and subscription wrappers are separate so the coordinator preserves hook order.
export function useEditingPresenceState(storage) {
  const [remoteEditingItems, setRemoteEditingItems] = useState(() => storage.getRemoteEditingItems());
  const [remoteSelectedItems, setRemoteSelectedItems] = useState(() => storage.getRemoteSelectedItems());
  return { remoteEditingItems, setRemoteEditingItems, remoteSelectedItems, setRemoteSelectedItems };
}

export function useEditingPresence({ loaded, storage, selectedIds, setRemoteEditingItems, setRemoteSelectedItems }) {
  useEffect(() => {
    if (!loaded) return undefined;
    const channel = createEditingPresenceChannel(storage, 'editing', setRemoteEditingItems);
    return () => channel.dispose();
  }, [loaded]);
  useEffect(() => {
    if (!loaded) return undefined;
    const channel = createEditingPresenceChannel(storage, 'selection', setRemoteSelectedItems);
    return () => channel.dispose();
  }, [loaded]);
  useEffect(() => {
    if (!loaded) return;
    createLocalEditingPresence(storage).publishSelected(selectedIds);
  }, [loaded, selectedIds]);
}
