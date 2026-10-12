export const BUTTON_VARIANT = Object.freeze({ DEFAULT: 'default', ACTIVE: 'active', PRIMARY: 'primary', DANGER: 'danger' });
export const MENU_ITEM_VARIANT = Object.freeze({ DEFAULT: 'default', DANGER: 'danger' });
export const DIVIDER_ORIENTATION = Object.freeze({ VERTICAL: 'vertical', HORIZONTAL: 'horizontal' });

export const ICON_BUTTON_VARIANT = Object.freeze({ DEFAULT: 'default', DANGER: 'danger' });
export const CHOICE_CHIP_STATE = Object.freeze({ DEFAULT: 'default', SELECTED: 'selected' });
export const SURFACE_KIND = Object.freeze({
  POPOVER: 'popover', TOOLBAR: 'toolbar', TOAST: 'toast', TOAST_WARN: 'toast-warn',
});
const SURFACE_CLASSES = Object.freeze({
  [SURFACE_KIND.POPOVER]: 'rb-surface rb-surface--popover',
  [SURFACE_KIND.TOOLBAR]: 'rb-surface rb-surface--toolbar',
  [SURFACE_KIND.TOAST]: 'rb-surface rb-surface--toast',
  [SURFACE_KIND.TOAST_WARN]: 'rb-surface rb-surface--toast-warn',
});
const ICON_BUTTON_CLASSES = Object.freeze({
  [ICON_BUTTON_VARIANT.DEFAULT]: 'rb-icon-btn',
  [ICON_BUTTON_VARIANT.DANGER]: 'rb-icon-btn rb-icon-btn--danger',
});
const CHOICE_CHIP_CLASSES = Object.freeze({
  [CHOICE_CHIP_STATE.DEFAULT]: 'rb-choice-chip',
  [CHOICE_CHIP_STATE.SELECTED]: 'rb-choice-chip rb-choice-chip--selected',
});

const BUTTON_CLASSES = Object.freeze({
  [BUTTON_VARIANT.DANGER]: 'rb-btn rb-btn--danger',
  [BUTTON_VARIANT.DEFAULT]: 'rb-btn',
  [BUTTON_VARIANT.ACTIVE]: 'rb-btn rb-btn--active',
  [BUTTON_VARIANT.PRIMARY]: 'rb-btn rb-btn--primary',
});
const MENU_ITEM_CLASSES = Object.freeze({
  [MENU_ITEM_VARIANT.DEFAULT]: 'rb-menu-item',
  [MENU_ITEM_VARIANT.DANGER]: 'rb-menu-item rb-menu-item--danger',
});
const DIVIDER_CLASSES = Object.freeze({
  [DIVIDER_ORIENTATION.VERTICAL]: 'rb-divider--vertical',
  [DIVIDER_ORIENTATION.HORIZONTAL]: 'rb-divider--horizontal',
});

function mappedClass(classes, value) {
  if (!Object.hasOwn(classes, value)) throw new Error(`Unknown UI variant: ${String(value)}`);
  return classes[value];
}

export function buttonClass(variant) { return mappedClass(BUTTON_CLASSES, variant); }
export function menuItemClass(variant) { return mappedClass(MENU_ITEM_CLASSES, variant); }
export function dividerClass(orientation) { return mappedClass(DIVIDER_CLASSES, orientation); }
export function topBarButtonVariant({ active }) {
  return active ? BUTTON_VARIANT.ACTIVE : BUTTON_VARIANT.DEFAULT;
}

export function surfaceClass(kind) { return mappedClass(SURFACE_CLASSES, kind); }

export function iconButtonClass(variant) { return mappedClass(ICON_BUTTON_CLASSES, variant); }
export function choiceChipClass(state) { return mappedClass(CHOICE_CHIP_CLASSES, state); }
export function choiceChipState(selected) {
  return selected ? CHOICE_CHIP_STATE.SELECTED : CHOICE_CHIP_STATE.DEFAULT;
}
export function toastSurfaceKind(type) {
  return type === 'warn' ? SURFACE_KIND.TOAST_WARN : SURFACE_KIND.TOAST;
}
