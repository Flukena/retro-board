import React from 'react';
import { createPortal } from 'react-dom';
import {
  BUTTON_VARIANT, MENU_ITEM_VARIANT, SURFACE_KIND,
  buttonClass, menuItemClass, dividerClass, surfaceClass,
  ICON_BUTTON_VARIANT, iconButtonClass, choiceChipClass, choiceChipState,
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

/** A navigation link that looks like a Button of the same variant. */
export function ButtonLink({ variant = BUTTON_VARIANT.DEFAULT, className, children, ...rest }) {
  return <a className={[buttonClass(variant), className].filter(Boolean).join(' ')} {...rest}>{children}</a>;
}

export function MenuItem({ icon, label, variant = MENU_ITEM_VARIANT.DEFAULT, checked, disabled, onClick, checkIcon, ...rest }) {
  return (
    <button
      type="button"
      className={menuItemClass(variant)}
      disabled={disabled}
      onClick={onClick}
      aria-pressed={checked == null ? undefined : checked}
      {...rest}
    >
      {icon != null && <span className="rb-menu-item__icon">{icon}</span>}
      <span className="rb-menu-item__label">{label}</span>
      {checked && checkIcon}
    </button>
  );
}

/** A navigation link that looks like a MenuItem of the same variant. */
export function MenuLink({ icon, label, variant = MENU_ITEM_VARIANT.DEFAULT, ...rest }) {
  return (
    <a className={menuItemClass(variant)} {...rest}>
      {icon != null && <span className="rb-menu-item__icon">{icon}</span>}
      <span className="rb-menu-item__label">{label}</span>
    </a>
  );
}

export function Divider({ orientation }) {
  return <div aria-hidden className={dividerClass(orientation)} />;
}

export function Surface({ kind = SURFACE_KIND.POPOVER, className, children, ...rest }) {
  return <div className={[surfaceClass(kind), className].filter(Boolean).join(' ')} {...rest}>{children}</div>;
}

export function IconButton({ variant = ICON_BUTTON_VARIANT.DEFAULT, className, children, ...rest }) {
  return (
    <button
      type="button"
      className={[iconButtonClass(variant), className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ChoiceChip({ selected, children, ...rest }) {
  return (
    <button
      type="button"
      className={choiceChipClass(choiceChipState(selected))}
      aria-pressed={selected}
      {...rest}
    >
      {children}
    </button>
  );
}

export function portalToBody(content) {
  return globalThis.document ? createPortal(content, document.body) : content;
}
