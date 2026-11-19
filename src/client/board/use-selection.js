import { useState, useRef, useEffect, useCallback } from 'react';
export function createSelectionController({ selectedIdsRef, setSelectedIds, focusedTextIdRef, setFocusedTextId, storage }) {
const mirror = (selectedIds) => { selectedIdsRef.current = selectedIds; };
const selectOne = (id) => {
    setSelectedIds(id == null ? new Set() : new Set([id]));
  };
const focus = (next) => {
    focusedTextIdRef.current = next;
    setFocusedTextId(next);
    const itemId = typeof next === 'string' ? next.split(':')[0] : null;
    storage.setLocalBusyItems('text', itemId ? [itemId] : []);
  };
return { mirror, selectOne, focus, dispose() {} };
}

// Keep these three seams at their original coordinator positions.
export function useSelection() {
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => { createSelectionController({ selectedIdsRef }).mirror(selectedIds); }, [selectedIds]);
  return { selectedIds, setSelectedIds, selectedIdsRef };
}

export function useFocusedSelection(storage, setFocusedTextId) {
  const focusedTextIdRef = useRef(null);
  const updateFocusedText = useCallback(createSelectionController({ storage, setFocusedTextId, focusedTextIdRef }).focus, []);
  return { focusedTextIdRef, updateFocusedText };
}

export function useSingleSelection(selectedIds, setSelectedIds) {
  const selectedId = selectedIds.size === 1 ? [...selectedIds][0] : null;
  const setSelectedId = useCallback(createSelectionController({ setSelectedIds }).selectOne, []);
  return { selectedId, setSelectedId };
}
