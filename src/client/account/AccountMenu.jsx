import React, { useRef, useState } from 'react';
import { ChevronDown, LogIn, LogOut, Trash2, Copy, RefreshCw, LayoutGrid } from 'lucide-react';
import { t, useLang } from '../ui/i18n.js';
import { Button, MenuItem, MenuLink, Surface, portalToBody } from '../ui/UiPrimitives.jsx';
import { ConfirmDialog } from '../ui/Modals.jsx';
import { Toast } from '../ui/Toast.jsx';
import { useDismiss } from '../ui/useDismiss.js';
import { BUTTON_VARIANT, MENU_ITEM_VARIANT, SURFACE_KIND } from '../ui/ui-variants.js';
import { TOPBAR_ICON_SIZE_PX } from '../chrome/chrome-layout.js';
import { ACCOUNT_STATUS, signInHref } from './account-api.js';
import { isInAppBrowser } from './in-app-browser.js';
import { useAccountMenu } from './use-account-menu.js';
import { myBoardsHrefFor } from './my-boards-link.js';
import './account.css';

const PLAN_KEYS = Object.freeze({ free: 'account.plan.free', pro: 'account.plan.pro' });
const DELETE_ICON_SIZE_PX = 20;

export function SignedOutControl({ inApp, href, onCopyLink }) {
  if (inApp) {
    return (
      <div className="rb-account__notice" role="note">
        <span>{t('account.inAppBrowser')}</span>
        <Button className="rb-btn--pill" onClick={onCopyLink}>
          <Copy size={TOPBAR_ICON_SIZE_PX.TOGGLE} aria-hidden="true" />
          {t('account.copyLink')}
        </Button>
      </div>
    );
  }
  return (
    <a className="rb-btn rb-btn--pill rb-account__signin" href={href}>
      <LogIn size={TOPBAR_ICON_SIZE_PX.TOGGLE} aria-hidden="true" />
      {t('account.signIn')}
    </a>
  );
}

function PlanBadge({ plan }) {
  return <span className="rb-account__plan">{t(PLAN_KEYS[plan] ?? PLAN_KEYS.free)}</span>;
}

// The first character of the name (or email), shown instead of the name where space is tight.
const initialOf = (account) => [...(account.name || account.email || '')][0]?.toUpperCase() ?? '';

/** `myBoardsHref` null leaves out the My boards link, for pages that already are My boards. */
export function SignedInMenu({ account, open, myBoardsHref = null, onToggle, onSignOut, onSignOutAll, onAskDelete }) {
  return (
    <>
      <Button className="rb-btn--pill rb-account__trigger" onClick={onToggle} aria-haspopup="menu" aria-expanded={open} aria-label={t('account.menu')}>
        <span className="rb-account__initial" aria-hidden="true">{initialOf(account)}</span>
        <span className="rb-account__name">{account.name || account.email}</span>
        <PlanBadge plan={account.plan} />
        <ChevronDown size={TOPBAR_ICON_SIZE_PX.TOGGLE} aria-hidden="true" />
      </Button>
      {open && (
        <Surface kind={SURFACE_KIND.POPOVER} className="rb-account__menu" role="menu">
          {account.email && <div className="rb-account__email">{account.email}</div>}
          {myBoardsHref && <MenuLink icon={<LayoutGrid size={TOPBAR_ICON_SIZE_PX.TOGGLE} />} label={t('account.myBoards')} href={myBoardsHref} />}
          <MenuItem icon={<LogOut size={TOPBAR_ICON_SIZE_PX.TOGGLE} />} label={t('account.signOut')} onClick={onSignOut} />
          <MenuItem icon={<LogOut size={TOPBAR_ICON_SIZE_PX.TOGGLE} />} label={t('account.signOutAll')} onClick={onSignOutAll} />
          <MenuItem icon={<Trash2 size={TOPBAR_ICON_SIZE_PX.TOGGLE} />} label={t('account.delete')} variant={MENU_ITEM_VARIANT.DANGER} onClick={onAskDelete} />
        </Surface>
      )}
    </>
  );
}

// Stateless view so every status renders on its own in tests.
export function AccountMenuView({ session, inApp, href, open = false, confirmingDelete = false, myBoardsHref = null, ...actions }) {
  if (session.status === ACCOUNT_STATUS.SIGNED_OUT) return <SignedOutControl inApp={inApp} href={href} onCopyLink={actions.onCopyLink} />;
  if (session.status === ACCOUNT_STATUS.UNAVAILABLE) {
    return (
      <Button className="rb-btn--pill" onClick={actions.onRetry}>
        <RefreshCw size={TOPBAR_ICON_SIZE_PX.TOGGLE} aria-hidden="true" />
        {t('account.retry')}
      </Button>
    );
  }
  if (session.status !== ACCOUNT_STATUS.SIGNED_IN) return null;
  return (
    <>
      <SignedInMenu account={session.account} open={open} myBoardsHref={myBoardsHref} {...actions} />
      {confirmingDelete && portalToBody(
        <ConfirmDialog
          icon={<Trash2 size={DELETE_ICON_SIZE_PX} color="var(--danger)" />}
          title={t('account.delete')}
          body={t('account.deleteConfirm')}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('account.delete')}
          confirmVariant={BUTTON_VARIANT.DANGER}
          onCancel={actions.onCancelDelete}
          onConfirm={actions.onConfirmDelete}
        />
      )}
    </>
  );
}

const HIDDEN_STATUSES = Object.freeze([null, ACCOUNT_STATUS.DISABLED]);

// The prerender renders this menu with no session and no page URL, so the path is read only once signed in.
const currentMyBoardsHref = (status) => (
  status === ACCOUNT_STATUS.SIGNED_IN ? myBoardsHrefFor(status, location.pathname) : null
);

// Wrapper and toast mount only when something shows, so guests on a relay
// without sign-in get no empty box (and no extra flex gap in the masthead).
export function AccountFrame({ status, rootRef, toast, onCloseToast, children }) {
  if (HIDDEN_STATUSES.includes(status)) return null;
  return (
    <div className="rb-account" ref={rootRef}>
      {children}
      <Toast toast={toast} onClose={onCloseToast} />
    </div>
  );
}

export default function AccountMenu() {
  useLang();
  const { session, toast, closeToast, reload, run, copyLink } = useAccountMenu();
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const rootRef = useRef(null);
  useDismiss(open, rootRef, () => setOpen(false));
  const afterRun = async (name) => { setOpen(false); await run(name); };
  const confirmDelete = async () => { if (await run('deleteAccount')) setConfirmingDelete(false); };
  return (
    <AccountFrame status={session.status} rootRef={rootRef} toast={toast} onCloseToast={closeToast}>
      <AccountMenuView
        session={session}
        inApp={isInAppBrowser(navigator.userAgent)}
        href={session.status === ACCOUNT_STATUS.SIGNED_OUT ? signInHref() : ''}
        open={open}
        confirmingDelete={confirmingDelete}
        myBoardsHref={currentMyBoardsHref(session.status)}
        onToggle={() => setOpen(!open)}
        onSignOut={() => void afterRun('logout')}
        onSignOutAll={() => void afterRun('logoutAll')}
        onAskDelete={() => { setOpen(false); setConfirmingDelete(true); }}
        onCancelDelete={() => setConfirmingDelete(false)}
        onConfirmDelete={() => void confirmDelete()}
        onCopyLink={() => void copyLink()}
        onRetry={() => void reload()}
      />
    </AccountFrame>
  );
}
