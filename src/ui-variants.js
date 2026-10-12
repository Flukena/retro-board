export const BUTTON_VARIANT = Object.freeze({ DEFAULT: 'default', ACTIVE: 'active' });
export const MENU_ITEM_VARIANT = Object.freeze({ DEFAULT: 'default', DANGER: 'danger' });
export const DIVIDER_ORIENTATION = Object.freeze({ VERTICAL: 'vertical', HORIZONTAL: 'horizontal' });

const BUTTON_CLASSES = Object.freeze({
  [BUTTON_VARIANT.DEFAULT]: 'rb-btn',
  [BUTTON_VARIANT.ACTIVE]: 'rb-btn rb-btn--active',
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
