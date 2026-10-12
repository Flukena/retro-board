import React from 'react';
import { LayoutTemplate, MousePointer2, Type, Image, Trash2 } from 'lucide-react';
import { Button, Divider, MenuItem, Surface } from './UiPrimitives.jsx';
import { DIVIDER_ORIENTATION } from './ui-variants.js';
import { PALETTE, DOCK_TILE_INDEX } from './palette.js';
import {
  DOCK_INSET_PX, DOCK_TILE_H_PX, DOCK_PADDING_PX, CHROME_BORDER_PX,
  CHROME_ICON_SIZE_PX, Z,
} from './chrome-layout.js';
import { t } from './i18n.js';
import './tool-dock.css';

export const TOOL_ID = Object.freeze({ SELECT: 'select', TEXT: 'text', ZONE: 'zone', IMAGE: 'image' });
const TEMPLATE_TOOL_ID = 'templates';
const TOOL_ICONS = Object.freeze({
  [TOOL_ID.SELECT]: MousePointer2,
  [TOOL_ID.TEXT]: Type,
  [TOOL_ID.ZONE]: LayoutTemplate,
  [TOOL_ID.IMAGE]: Image,
});

function DockTile({ toolId, icon: Icon, label, ...props }) {
  return (
    <button type="button" className="rb-dock-tile" data-tool={toolId} {...props}>
      <span className="rb-dock-tile__icon" style={{ background: PALETTE[DOCK_TILE_INDEX[toolId]].bg }}>
        <Icon size={CHROME_ICON_SIZE_PX.TOOL} />
      </span>
      <span>{label}</span>
    </button>
  );
}

export function ToolTile({ toolId, active, onTool }) {
  return (
    <DockTile
      toolId={toolId}
      icon={active ? MousePointer2 : TOOL_ICONS[toolId]}
      label={t(active ? `tool.${toolId}.placeholder` : `tool.${toolId}`)}
      title={t(active ? `tool.${toolId}.active` : `tool.${toolId}.title`)}
      aria-pressed={active}
      onClick={() => onTool(toolId)}
    />
  );
}

function TemplatePopover({ rows, onApplyTemplate, onDeleteCustomTemplate, onSaveTemplate, onClose }) {
  return (
    <>
      <div className="rb-template-backdrop" onClick={onClose} style={{ zIndex: Z.POPOVER_BACKDROP }} />
      <Surface
        className="rb-template-popover"
        data-board-shortcuts="off"
        style={{ zIndex: Z.POPOVER }}
      >
        <div className="rb-template-heading">{t('tmpl.builtin')}</div>
        {rows.builtin.map((row) => (
          <MenuItem key={row.id} label={row.name} onClick={() => onApplyTemplate(row.id)} />
        ))}
        {rows.custom.length > 0 && <div className="rb-template-heading">{t('tmpl.custom')}</div>}
        {rows.custom.map((row) => (
          <div key={row.id} className="rb-template-custom">
            <MenuItem
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
              title={t('common.delete')}
              aria-label={t('common.delete')}
              onClick={() => onDeleteCustomTemplate(row.id)}
            >
              <Trash2 size={CHROME_ICON_SIZE_PX.SMALL} />
            </Button>
          </div>
        ))}
        <Divider orientation={DIVIDER_ORIENTATION.HORIZONTAL} />
        <MenuItem label={t('tmpl.save')} onClick={onSaveTemplate} />
      </Surface>
    </>
  );
}

export function ToolDock({
  creationMode, templatesOpen, rows, onTool, onTemplatesOpenChange,
  onApplyTemplate, onDeleteCustomTemplate, onSaveTemplate,
}) {
  return (
    <div
      className="rb-tool-dock"
      style={{
        bottom: DOCK_INSET_PX,
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
          aria-expanded={templatesOpen}
          onClick={() => onTemplatesOpenChange(!templatesOpen)}
        />
        <Divider orientation={DIVIDER_ORIENTATION.VERTICAL} />
        {Object.values(TOOL_ID).map((toolId) => (
          <ToolTile
            key={toolId}
            toolId={toolId}
            active={creationMode === toolId}
            onTool={onTool}
          />
        ))}
      </div>
      {templatesOpen && (
        <TemplatePopover
          rows={rows}
          onApplyTemplate={onApplyTemplate}
          onDeleteCustomTemplate={onDeleteCustomTemplate}
          onSaveTemplate={onSaveTemplate}
          onClose={() => onTemplatesOpenChange(false)}
        />
      )}
    </div>
  );
}
