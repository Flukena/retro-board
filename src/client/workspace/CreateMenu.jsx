import React, { useRef, useState } from 'react';
import { ChevronDown, LayoutTemplate, Lock, Plus, Spade } from 'lucide-react';
import { t } from '../ui/i18n.js';
import { useDismiss } from '../ui/useDismiss.js';
import { Button, Divider, MenuItem } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT, DIVIDER_ORIENTATION, buttonClass } from '../ui/ui-variants.js';
import { DISPLAY_NAME_MAX_LENGTH } from '../../domain/security-boundaries.js';
import { useCreateBoard } from '../app/use-create-board.js';
import CreateBoardError from '../app/CreateBoardError.jsx';
import FormatChips from '../app/FormatChips.jsx';
import { CreateLockedRoomForm } from '../room-lock/CreateLockedRoom.jsx';
import { canOfferLockedRoom } from '../room-lock/create-locked-room-controller.js';
import { useLockedRoomForm } from '../room-lock/use-locked-room-form.js';
import { createMenuActions } from './create-menu-actions.js';

const TRIGGER_ICON_SIZE_PX = 18;
const ITEM_ICON_SIZE_PX = 18;

/** Which inline panel the open menu shows under its items. */
export const CREATE_PANEL = Object.freeze({ NONE: 'none', NEW: 'new', LOCKED: 'locked', TEMPLATE: 'template' });

function ItemLabel({ title, description }) {
  return (
    <>
      <span className="rb-workspace-create__item-title">{title}</span>
      <span className="rb-workspace-create__item-desc">{description}</span>
    </>
  );
}

function CreateItem({ Icon, titleKey, descKey, disabled, expanded, onClick }) {
  return (
    <MenuItem role="menuitem" icon={<Icon size={ITEM_ICON_SIZE_PX} aria-hidden="true" />}
      label={<ItemLabel title={t(titleKey)} description={t(descKey)} />}
      disabled={disabled} aria-expanded={expanded} onClick={onClick} />
  );
}

function NameField({ value, onChange }) {
  return (
    <input className="rb-input rb-workspace__field rb-workspace-create__name" aria-label={t('workspace.create.name')}
      placeholder={t('workspace.create.name')} value={value} maxLength={DISPLAY_NAME_MAX_LENGTH}
      onChange={(event) => onChange(event.target.value)} />
  );
}

function NewPanel({ creating, onCreate }) {
  const [name, setName] = useState('');
  const submit = (event) => { event.preventDefault(); onCreate(name); };
  return (
    <form className="rb-workspace-create__panel" onSubmit={submit}>
      <NameField value={name} onChange={setName} />
      <Button type="submit" variant={BUTTON_VARIANT.PRIMARY} disabled={creating}>{t('workspace.create.submit')}</Button>
    </form>
  );
}

function LockedPanel({ creating, onCreateLocked }) {
  const [name, setName] = useState('');
  const { formId, form, failed, busy, onChange, onSubmit } = useLockedRoomForm({ name, createBoard: onCreateLocked });
  return (
    <div className="rb-workspace-create__panel">
      <NameField value={name} onChange={setName} />
      <CreateLockedRoomForm formId={formId} form={form} failed={failed} busy={busy} disabled={creating}
        onChange={onChange} onSubmit={onSubmit} />
    </div>
  );
}

function CreatePanel({ panel, creating, onCreate, onStartFormat, onCreateLocked }) {
  if (panel === CREATE_PANEL.NEW) return <NewPanel creating={creating} onCreate={onCreate} />;
  if (panel === CREATE_PANEL.LOCKED) return <LockedPanel creating={creating} onCreateLocked={onCreateLocked} />;
  if (panel === CREATE_PANEL.TEMPLATE) {
    return <div className="rb-workspace-create__panel"><FormatChips onStart={onStartFormat} disabled={creating} /></div>;
  }
  return null;
}

/** The "new board" trigger and, when open, its menu of every room kind: pure, so each state renders on its own. */
export function CreateMenuView({
  open, panel, session, creating, createError, triggerRef,
  onToggle, onPanel, onCreate, onStartFormat, onCreatePoker, onCreateLocked,
}) {
  const showLocked = canOfferLockedRoom(session);
  const expandedFor = (target) => panel === target;
  return (
    <>
      <button type="button" ref={triggerRef} className={`${buttonClass(BUTTON_VARIANT.PRIMARY)} rb-workspace-create__trigger`}
        aria-haspopup="menu" aria-expanded={open} aria-label={t('workspace.create')} onClick={onToggle}>
        <Plus size={TRIGGER_ICON_SIZE_PX} aria-hidden="true" />
        <span className="rb-workspace-create__trigger-label">{t('workspace.create')}</span>
        <ChevronDown size={TRIGGER_ICON_SIZE_PX} aria-hidden="true" className="rb-workspace-create__chevron" />
      </button>
      {open && (
        <div className="rb-surface rb-workspace-create__menu" role="menu" aria-label={t('workspace.create')}>
          <CreateItem Icon={Plus} titleKey="workspace.create.new" descKey="workspace.create.newDesc"
            disabled={creating} expanded={expandedFor(CREATE_PANEL.NEW)} onClick={() => onPanel(CREATE_PANEL.NEW)} />
          <CreateItem Icon={LayoutTemplate} titleKey="workspace.create.template" descKey="workspace.create.templateDesc"
            disabled={creating} expanded={expandedFor(CREATE_PANEL.TEMPLATE)} onClick={() => onPanel(CREATE_PANEL.TEMPLATE)} />
          <CreateItem Icon={Spade} titleKey="workspace.create.poker" descKey="workspace.create.pokerDesc"
            disabled={creating} onClick={onCreatePoker} />
          {showLocked && (
            <CreateItem Icon={Lock} titleKey="workspace.create.locked" descKey="workspace.create.lockedDesc"
              disabled={creating} expanded={expandedFor(CREATE_PANEL.LOCKED)} onClick={() => onPanel(CREATE_PANEL.LOCKED)} />
          )}
          {panel !== CREATE_PANEL.NONE && <Divider orientation={DIVIDER_ORIENTATION.HORIZONTAL} />}
          <CreatePanel panel={panel} creating={creating} onCreate={onCreate} onStartFormat={onStartFormat}
            onCreateLocked={onCreateLocked} />
          <CreateBoardError error={createError} className="rb-workspace-create__error" />
        </div>
      )}
    </>
  );
}

/** The masthead's create control for a signed-in account; the room itself is made by the relay. */
export default function CreateMenu({ session }) {
  const { creating, createError, createBoard } = useCreateBoard();
  const actions = createMenuActions(createBoard);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState(CREATE_PANEL.NONE);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const close = () => { setOpen(false); setPanel(CREATE_PANEL.NONE); };
  // Closing unmounts the focused item, so focus returns to the trigger first.
  const dismiss = () => {
    const root = rootRef.current;
    if (root?.contains(root.ownerDocument.activeElement)) triggerRef.current?.focus();
    close();
  };
  useDismiss(open, rootRef, dismiss);
  const toggle = () => (open ? close() : setOpen(true));
  const togglePanel = (next) => setPanel((current) => (current === next ? CREATE_PANEL.NONE : next));
  return (
    <div className="rb-workspace-create" ref={rootRef}>
      <CreateMenuView open={open} panel={panel} session={session} creating={creating} createError={createError}
        triggerRef={triggerRef} onToggle={toggle} onPanel={togglePanel}
        onCreate={actions.blank} onStartFormat={actions.template} onCreatePoker={actions.poker}
        onCreateLocked={actions.locked} />
    </div>
  );
}
