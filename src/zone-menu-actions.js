const HANDOFF_ACTIONS = ['vote', 'exportCsv', 'saveTemplate', 'remove', 'bringToFront', 'sendToBack'];

export function createZoneMenuActions(actions, closeMenu) {
  const menuActions = { ...actions };
  for (const name of HANDOFF_ACTIONS) {
    menuActions[name] = (...args) => {
      closeMenu();
      return actions[name](...args);
    };
  }
  return menuActions;
}
