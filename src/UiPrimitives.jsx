import React from 'react';
import {
  BUTTON_VARIANT, MENU_ITEM_VARIANT, SURFACE_KIND,
  buttonClass, menuItemClass, dividerClass, surfaceClass,
} from './ui-variants.js';
import './ui.css';

export function Button({ variant = BUTTON_VARIANT.DEFAULT, disabledLook, className, children, ...rest }) {
  return (
    <button
      type="button"
      className={[buttonClass(variant), className].filter(Boolean).join(' ')}
      aria-disabled={disabledLook || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}

export function MenuItem({ icon, label, variant = MENU_ITEM_VARIANT.DEFAULT, checked, disabled, onClick, checkIcon }) {
  return (
    <button
      type="button"
      className={menuItemClass(variant)}
      disabled={disabled}
      onClick={onClick}
      aria-pressed={checked == null ? undefined : checked}
    >
      {icon != null && <span className="rb-menu-item__icon">{icon}</span>}
      <span className="rb-menu-item__label">{label}</span>
      {checked && checkIcon}
    </button>
  );
}

export function Divider({ orientation }) {
  return <div aria-hidden className={dividerClass(orientation)} />;
}

export function Surface({ kind = SURFACE_KIND.POPOVER, className, children, ...rest }) {
  return <div className={[surfaceClass(kind), className].filter(Boolean).join(' ')} {...rest}>{children}</div>;
}
