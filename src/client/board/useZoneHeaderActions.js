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
        canModify: current.canModifyOwnedItem, canDelete: current.canDeleteItem,
        clearEditing: current.updateFocusedText,
        openTimerSetup: current.setTimerSetupZoneId, stopTimer: current.adminStopTimer,
        updateZone: current.updateItem, startTimer: current.adminStartTimer,
        exportCsv: current.exportZoneCsv, openSaveTemplate: current.openSaveTemplate,
        bringToFront: current.bringToFront, sendToBack: current.sendToBack,
        deleteItemsIfAllowed: current.deleteItemsIfAllowed };
    });
  }
  return actions.current;
}
