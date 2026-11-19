import React from 'react';
import { Unlock, AlertCircle, RotateCcw, Upload } from 'lucide-react';
import { ConfirmDialog, NameDialog, HelpDialog, CommentsDialog, AdminPinDialog, TemplateNameDialog, TEMPLATE_NAME_MODE } from './Modals.jsx';
import { MODAL_SIZE, BUTTON_VARIANT } from './ui-variants.js';
import { confirmThenPin } from './confirm-then-pin.js';
import { importWarningNotes } from './modal-model.js';
import { MoodCheckDialog } from '../board/MoodCheck.jsx';
import { ActionItemsDialog } from '../board/ActionItemsDialog.jsx';
import { PALETTE } from './palette.js';
import { t } from './i18n.js';
const EMPTY_COMMENTS = [];

// Help modal sections, in display order. `color` indexes PALETTE so each
// section's accent dot matches a real sticky-note color from the palette.
const HELP_SECTIONS = [
  { key: 'collab', color: 0 },
  { key: 'canvas', color: 2 },
  { key: 'zones', color: 3 },
  { key: 'reveal', color: 4 },
  { key: 'voting', color: 1 },
  { key: 'admin', color: 5 },
];

export function BoardDialogs({
  saveTemplateOpen, closeSaveDialog, saveCurrentAsTemplate, templateDraft, renameTarget,
  renameCustomTemplate, closeRenameDialog, nameModalOpen, nameDraft, setNameDraft,
  saveName, dismissName, userName, confirmUnlockAll, setConfirmUnlockAll,
  requireAdminPin, adminUnlockAll, confirmResetVotes, setConfirmResetVotes, adminResetVotes,
  pendingImport, importBusy, setPendingImport, confirmImport, mood,
  actionItems, canModifyOwnedItem, items, updateItem, setSelectedIds,
  fitToItems, commentsOpenReadable, commentsOpenItem, commentsByItem, editingAllowed,
  addCommentTo, deleteCommentFrom, setCommentsOpenFor, helpOpen, setHelpOpen,
  pinPromptCfg, confirmClear, setConfirmClear, adminClearBoard,
}) {
  return <>
      {saveTemplateOpen && <TemplateNameDialog mode={TEMPLATE_NAME_MODE.SAVE}
        onClose={closeSaveDialog} onSubmit={saveCurrentAsTemplate} zoneCount={templateDraft.length} />}
      {renameTarget && <TemplateNameDialog key={renameTarget.id} mode={TEMPLATE_NAME_MODE.RENAME}
        initialName={renameTarget.name} onSubmit={renameCustomTemplate} onClose={closeRenameDialog} />}
      {nameModalOpen && (
        <NameDialog draft={nameDraft} onDraftChange={setNameDraft} onSave={saveName} onClose={dismissName} hasName={Boolean(userName)} />
      )}
      {confirmUnlockAll && (
        <ConfirmDialog
          icon={<Unlock size={22} color="var(--accent)" />}
          title={t('unlockAll.confirm.head')}
          body={t('unlockAll.confirm.body')}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('unlockAll.confirm.ok')}
          onCancel={() => setConfirmUnlockAll(false)}
          onConfirm={() => confirmThenPin(setConfirmUnlockAll, requireAdminPin, adminUnlockAll)}
        />
      )}
      {confirmResetVotes && (
        <ConfirmDialog
          icon={<RotateCcw size={22} color="var(--accent)" />}
          title={t('reset.confirm.head')}
          body={<>{t('reset.confirm.body')}<br />{t('reset.confirm.body2')}</>}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('reset.confirm.ok')}
          onCancel={() => setConfirmResetVotes(false)}
          onConfirm={() => confirmThenPin(setConfirmResetVotes, requireAdminPin, adminResetVotes)}
        />
      )}
      {pendingImport && (
        <ConfirmDialog
          size={MODAL_SIZE.MD}
          icon={<Upload size={22} color="var(--accent)" />}
          title={t('import.confirm.head')}
          body={importBusy ? t('import.processing') : t('import.confirm.body', {
            n: pendingImport.items.length, file: pendingImport.name,
          })}
          notes={importWarningNotes(pendingImport).map(({ key, params }) => t(key, params))}
          cancelLabel={t('common.cancel')}
          confirmLabel={importBusy ? t('import.processing') : t('import.confirm.ok')}
          busy={importBusy}
          onCancel={() => setPendingImport(null)}
          onConfirm={confirmImport}
        />
      )}
      {mood.dialogOpen && <MoodCheckDialog onAnswer={mood.answer} onSkip={mood.skip} />}
      {actionItems.open && (
        <ActionItemsDialog rows={actionItems.rows} onClose={actionItems.hide}
          canEdit={(id) => canModifyOwnedItem(items.find((it) => it.id === id))}
          onPatch={updateItem} onLocate={(id) => { actionItems.hide(); setSelectedIds(new Set([id])); fitToItems([id]); }} />
      )}
      {commentsOpenReadable && (
        <CommentsDialog
          item={commentsOpenItem}
          comments={commentsByItem.get(commentsOpenItem.id) ?? EMPTY_COMMENTS}
          editingAllowed={editingAllowed}
          onAdd={(text) => addCommentTo(commentsOpenItem, text)}
          onDelete={(commentId) => deleteCommentFrom(commentsOpenItem.id, commentId)}
          onClose={() => setCommentsOpenFor(null)}
        />
      )}
      {helpOpen && (
        <HelpDialog
          sections={HELP_SECTIONS.map((section) => ({ ...section, color: PALETTE[section.color].border }))}
          onClose={() => setHelpOpen(false)}
        />
      )}
      {pinPromptCfg && (
        <AdminPinDialog
          isSetting={pinPromptCfg.isSetting}
          error={pinPromptCfg.error}
          onCancel={pinPromptCfg.onCancel}
          onSubmit={pinPromptCfg.onSuccess}
        />
      )}
      {confirmClear && (
        <ConfirmDialog
          icon={<AlertCircle size={22} color="var(--danger)" />}
          title={t('clear.confirm.head')}
          body={t('clear.confirm.body')}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('clear.confirm.ok')}
          confirmVariant={BUTTON_VARIANT.DANGER}
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => confirmThenPin(setConfirmClear, requireAdminPin, adminClearBoard)}
        />
      )}

  </>;
}
