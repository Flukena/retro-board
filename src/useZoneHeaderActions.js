import { useRef } from 'react';
import { createZoneHeaderActions } from './zone-header-actions.js';

export function useZoneHeaderActions(context) {
  const latest = useRef(context);
  latest.current = context;
  const actions = useRef(null);
  if (!actions.current) {
    actions.current = createZoneHeaderActions(() => {
      const current = latest.current;
      return { isAdmin: current.isAdmin, board: current.boardRef.current,
        selectZone: current.setSelectedId, clearEditing: current.updateFocusedText,
        openTimerSetup: current.setTimerSetupOpen, stopTimer: current.adminStopTimer,
        updateZone: current.updateItem };
    });
  }
  return actions.current;
}
