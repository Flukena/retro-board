import React, { useState } from 'react';
import {
  LayoutTemplate, Trash2, Lock, Unlock, Type, BringToFront, SendToBack,
} from 'lucide-react';
import { IconButton, Surface } from './UiPrimitives.jsx';
import { ICON_BUTTON_VARIANT, SURFACE_KIND } from './ui-variants.js';
import { Z } from './chrome-layout.js';
import { PALETTE, FONT_COLORS } from './palette.js';
import {
  fontSizeForItem, clampFontSize, canDecreaseFontSize, canIncreaseFontSize,
  FONT_SIZE_STEP_PX, selectionToolbarSections,
} from './selection-toolbar-model.js';
import { t } from './i18n.js';
import './selection-toolbar.css';

const TOOLBAR_ICON_SIZE_PX = 15;
const WHITE_FONT_COLOR = '#ffffff';

function ToolbarSurface({ anchor, children }) {
  return (
    <Surface
      kind={SURFACE_KIND.TOOLBAR}
      className="rb-selection-toolbar"
      style={{ left: anchor.x, top: anchor.y, zIndex: Z.SELECTION_TOOLBAR }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {children}
    </Surface>
  );
}

export function GroupSelectionToolbar({ anchor, lockedCount, canUnlock, onUnlockAll, zoneCount = 0, onSaveTemplate }) {
  const title = lockedCount > 0
    ? t('selection.unlockAll', { n: lockedCount }) : t('selection.nothingLocked');
  return (
    <ToolbarSurface anchor={anchor}>
      <IconButton
        className="rb-selection-toolbar__unlock"
        onClick={onUnlockAll}
        disabled={!canUnlock}
        title={title}
      >
        <Unlock size={TOOLBAR_ICON_SIZE_PX} />
        <span>{t('selection.unlockAll', { n: lockedCount })}</span>
      </IconButton>
      {zoneCount > 0 && <SaveTemplateButton onSaveTemplate={onSaveTemplate} />}
    </ToolbarSurface>
  );
}

function SaveTemplateButton({ onSaveTemplate }) {
  const label = t('selection.saveTemplate');
  return (
    <IconButton onClick={onSaveTemplate} title={label} aria-label={label}>
      <LayoutTemplate size={TOOLBAR_ICON_SIZE_PX} />
    </IconButton>
  );
}

export function ColorSwatches({ colorIndex, can, onColor }) {
  return (
    <div className="rb-selection-toolbar__swatches">
      {PALETTE.map((color, index) => (
        <button
          key={color.name}
          type="button"
          className="rb-color-swatch"
          aria-label={t(`color.${color.name}`)}
          disabled={!can}
          onClick={() => can && onColor(index)}
          style={{ background: color.bg, borderColor: colorIndex === index ? 'var(--text)' : color.border }}
        />
      ))}
    </div>
  );
}

export function FontSizeControl({ item, can, onFontSize }) {
  const size = fontSizeForItem(item);
  return (
    <div className="rb-selection-toolbar__font-size">
      <IconButton
        onClick={() => can && onFontSize(clampFontSize(size - FONT_SIZE_STEP_PX))}
        disabled={!canDecreaseFontSize(size, can)}
        title={t('font.decrease')} aria-label={t('font.decrease')}
      >
        {t('font.decreaseGlyph')}
      </IconButton>
      <span>{size}</span>
      <IconButton
        onClick={() => can && onFontSize(clampFontSize(size + FONT_SIZE_STEP_PX))}
        disabled={!canIncreaseFontSize(size, can)}
        title={t('font.increase')} aria-label={t('font.increase')}
      >
        {t('font.increaseGlyph')}
      </IconButton>
    </div>
  );
}

export function FontColorSwatches({ fontColor, onFontColor, onClose }) {
  return (
    <Surface
      className="rb-font-color-picker"
      style={{ zIndex: Z.TOOLBAR_POPOVER }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {FONT_COLORS.map((color) => (
        <button
          key={color.label}
          type="button"
          className="rb-font-color-swatch"
          aria-pressed={(fontColor ?? null) === color.value}
          onClick={() => { onFontColor(color.value); onClose(); }}
          title={t(`font.color.${color.label}`)}
          style={{ background: color.swatch }}
        />
      ))}
    </Surface>
  );
}

export function FontColorPicker({ fontColor, can, onFontColor }) {
  const [fontColorOpen, setFontColorOpen] = useState(false);
  return (
    <div className="rb-selection-toolbar__popover-anchor">
      <IconButton
        onClick={() => can && setFontColorOpen((open) => !open)}
        disabled={!can}
        title={t('font.color')}
      >
        <Type size={TOOLBAR_ICON_SIZE_PX} style={{
          color: fontColor || 'currentColor',
          filter: fontColor === WHITE_FONT_COLOR ? 'drop-shadow(0 0 1px var(--text-mid))' : 'none',
        }} />
      </IconButton>
      {fontColorOpen && (
        <>
          <div
            className="rb-font-color-backdrop"
            style={{ zIndex: Z.TOOLBAR_POPOVER_BACKDROP }}
            onMouseDown={() => setFontColorOpen(false)}
          />
          <FontColorSwatches
            fontColor={fontColor}
            onFontColor={onFontColor}
            onClose={() => setFontColorOpen(false)}
          />
        </>
      )}
    </div>
  );
}

export function SelectionToolbar({ anchor, item, can, canDelete,
  onColor, onFontSize, onFontColor, onTogglePrivate, onBringToFront, onSendToBack, onDelete }) {
  const sections = selectionToolbarSections(item.type);
  return (
    <ToolbarSurface anchor={anchor}>
      {sections.palette && <ColorSwatches colorIndex={item.colorIndex} can={can} onColor={onColor} />}
      {sections.fontSize && <FontSizeControl item={item} can={can} onFontSize={onFontSize} />}
      {sections.fontColor && <FontColorPicker fontColor={item.fontColor} can={can} onFontColor={onFontColor} />}
      {sections.privacy && (
        <IconButton
          onClick={() => can && onTogglePrivate()}
          disabled={!can}
          title={item.private ? t('sticky.privacyToggle.off') : t('sticky.privacyToggle.on')}
        >
          {item.private ? <Lock size={TOOLBAR_ICON_SIZE_PX} /> : <Unlock size={TOOLBAR_ICON_SIZE_PX} />}
        </IconButton>
      )}
      <IconButton onClick={() => can && onBringToFront()} disabled={!can} title={t('selection.bringToFront')}>
        <BringToFront size={TOOLBAR_ICON_SIZE_PX} />
      </IconButton>
      <IconButton onClick={() => can && onSendToBack()} disabled={!can} title={t('selection.sendToBack')}>
        <SendToBack size={TOOLBAR_ICON_SIZE_PX} />
      </IconButton>
      <IconButton
        variant={ICON_BUTTON_VARIANT.DANGER}
        onClick={onDelete}
        disabled={!canDelete}
        title={item.locked ? t('zone.lockedDeleteTitle') : t('common.delete')}
      >
        <Trash2 size={TOOLBAR_ICON_SIZE_PX} />
      </IconButton>
    </ToolbarSurface>
  );
}
