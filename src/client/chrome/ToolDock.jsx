import React from 'react';
import { LayoutTemplate, SquareDashed, MousePointer2, Type, Image, Trash2, Pencil, ChevronDown, StickyNote, X } from 'lucide-react';
import { Button, Divider, MenuItem, Surface } from '../ui/UiPrimitives.jsx';
import { DIVIDER_ORIENTATION } from '../ui/ui-variants.js';
import { PALETTE, DOCK_TILE_INDEX } from '../ui/palette.js';
import {
  DOCK_INSET_PX, DOCK_TILE_H_PX, DOCK_PADDING_PX, CHROME_BORDER_PX,
  CHROME_ICON_SIZE_PX, Z,
} from './chrome-layout.js';
import { t } from '../ui/i18n.js';
import { TemplateThumbnail } from '../templates/TemplateThumbnail.jsx';
import './tool-dock.css';

export const TOOL_ID = Object.freeze({ SELECT: 'select', TEXT: 'text', ZONE: 'zone', IMAGE: 'image', DRAW: 'draw' });
const TEMPLATE_TOOL_ID = 'templates';
const TOOL_ICONS = Object.freeze({
  [TOOL_ID.SELECT]: MousePointer2,
  [TOOL_ID.TEXT]: Type,
  [TOOL_ID.ZONE]: SquareDashed,
  [TOOL_ID.IMAGE]: Image,
  [TOOL_ID.DRAW]: Pencil,
});

function DockTile({ toolId, icon: Icon, label, chevron = false, paletteIndex = DOCK_TILE_INDEX[toolId], ...props }) {
  return (
    <button type="button" className="rb-dock-tile" data-tool={toolId} {...props}>
      <span className="rb-dock-tile__icon" style={{ background: PALETTE[paletteIndex].bg }}>
        <Icon size={CHROME_ICON_SIZE_PX.TOOL} />
      </span>
      <span className="rb-dock-tile__label">
        {label}
        {chevron && <ChevronDown size={CHROME_ICON_SIZE_PX.SMALL} aria-hidden="true" />}
      </span>
    </button>
  );
}

export function ToolTile({ toolId, active, onTool }) {
  const activeCreation = active && toolId !== TOOL_ID.SELECT && toolId !== TOOL_ID.DRAW;
  return (
    <DockTile
      toolId={toolId}
      icon={activeCreation ? MousePointer2 : TOOL_ICONS[toolId]}
      label={t(activeCreation ? `tool.${toolId}.placeholder` : `tool.${toolId}`)}
      title={t(activeCreation ? `tool.${toolId}.active` : `tool.${toolId}.title`)}
      aria-pressed={active}
      onClick={() => onTool(toolId)}
    />
  );
}

export function TemplatePopover({ selectedZoneCount = 0, rows, onApplyTemplate, onDeleteCustomTemplate, onRenameCustomTemplate, onSaveTemplate, onClose }) {
  return (
    <>
      <div className="rb-template-backdrop" onClick={onClose} style={{ zIndex: Z.POPOVER_BACKDROP }} />
      <Surface
        className="rb-template-popover"
        data-board-shortcuts="off"
        role="dialog"
        aria-label={t('tmpl.btn')}
        style={{ zIndex: Z.POPOVER }}
      >
        <div className="rb-template-heading">{t('tmpl.builtin')}</div>
        {rows.builtin.map((row) => (
          <MenuItem key={row.id} icon={<TemplateThumbnail zones={row.zones} />} label={row.name} onClick={() => onApplyTemplate(row.id)} />
        ))}
        {rows.custom.length > 0 && <div className="rb-template-heading">{t('tmpl.custom')}</div>}
        {rows.custom.map((row) => (
          <div key={row.id} className="rb-template-custom">
            <MenuItem
              icon={<TemplateThumbnail zones={row.zones} />}
              label={(
                <>
                  {row.name}
                  <span className="rb-template-count">{t('tmpl.zoneCount', { n: row.zoneCount })}</span>
                </>
              )}
              onClick={() => onApplyTemplate(row.id)}
            />
            <Button
              className="rb-btn--icon-sm"
              title={t('tmpl.rename')}
              aria-label={t('tmpl.rename')}
              onClick={() => onRenameCustomTemplate(row.id)}
            >
              <Pencil size={CHROME_ICON_SIZE_PX.SMALL} />
            </Button>
            <Button
              className="rb-btn--icon-sm"
              title={t('common.delete')}
              aria-label={t('common.delete')}
              onClick={() => onDeleteCustomTemplate(row.id)}
            >
              <Trash2 size={CHROME_ICON_SIZE_PX.SMALL} />
            </Button>
          </div>
        ))}
        <Divider orientation={DIVIDER_ORIENTATION.HORIZONTAL} />
        <MenuItem label={t('tmpl.saveSelection')} disabled={selectedZoneCount === 0} onClick={onSaveTemplate} />
        {selectedZoneCount === 0 && <div className="rb-template-popover__hint">{t('tmpl.selectZonesHint')}</div>}
        <Button className="rb-template-close rb-mobile-only" onClick={onClose}>
          <X size={CHROME_ICON_SIZE_PX.SMALL} />{t('common.close')}
        </Button>
      </Surface>
    </>
  );
}

export function ToolDock({
  creationMode, templatesOpen, rows, selectedZoneCount = 0, onTool, onTemplatesOpenChange,
  onApplyTemplate, onDeleteCustomTemplate, onRenameCustomTemplate, onSaveTemplate, onAddSticky,
}) {
  return (
    <div
      className="rb-tool-dock"
      style={{
        zIndex: templatesOpen ? Z.POPOVER : Z.DOCK,
        '--rb-dock-inset-px': `${DOCK_INSET_PX}px`,
        '--rb-dock-tile-height': `${DOCK_TILE_H_PX}px`,
        '--rb-dock-padding': `${DOCK_PADDING_PX}px`,
        '--rb-chrome-border': `${CHROME_BORDER_PX}px`,
      }}
    >
      <div className="rb-tool-dock__body" style={{ zIndex: Z.DOCK }}>
        <DockTile
          toolId={TEMPLATE_TOOL_ID}
          icon={LayoutTemplate}
          label={t('tmpl.btn')}
          title={t('tmpl.btn')}
          aria-label={t('tmpl.btn')}
          chevron
          aria-expanded={templatesOpen}
          onClick={() => onTemplatesOpenChange(!templatesOpen)}
        />
        {onAddSticky && <DockTile
          toolId="sticky"
          icon={StickyNote}
          paletteIndex={DOCK_TILE_INDEX.text}
          label={t('tool.sticky')}
          title={t('tool.sticky.title')}
          aria-label={t('tool.sticky.title')}
          onClick={onAddSticky}
        />}
        <Divider orientation={DIVIDER_ORIENTATION.VERTICAL} />
        {Object.values(TOOL_ID).map((toolId) => (
          <ToolTile
            key={toolId}
            toolId={toolId}
            active={creationMode === toolId || (toolId === TOOL_ID.SELECT && creationMode == null)}
            onTool={onTool}
          />
        ))}
      </div>
      {templatesOpen && (
        <TemplatePopover
          rows={rows}
          selectedZoneCount={selectedZoneCount}
          onApplyTemplate={onApplyTemplate}
          onDeleteCustomTemplate={onDeleteCustomTemplate}
          onRenameCustomTemplate={onRenameCustomTemplate}
          onSaveTemplate={onSaveTemplate}
          onClose={() => onTemplatesOpenChange(false)}
        />
      )}
    </div>
  );
}
