import { BOARD_MODE } from '../../domain/public-wall-contract.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/native-selection.css';
import '../ui/theme.js'; // apply CSS variables on <html> before first paint
import RetroBoard from '../../../RetroBoard.jsx';
import { establishPublicRoomSession } from '../public-wall/public-room-session.js';
import HomeRoute from './HomeRoute.jsx';
import LegalPage from '../legal/LegalPage.jsx';
import TemplatePage from '../templates/TemplatePage.jsx';
import NotFoundPage from './NotFoundPage.jsx';
import { NOT_FOUND_TITLE_KEY, seoPageForPath } from '../seo/seo-pages.js';
import { usePageHead } from '../seo/use-page-head.js';
import { BoardErrorBoundary } from './BoardErrorBoundary.jsx';
import { SyncBanner } from '../session/SyncBanner.jsx';
import RoomDeletedBoundary from '../session/RoomDeletedBoundary.jsx';
import { languageReady, setLang, useLang } from '../ui/i18n.js';
import RoomBootstrapScreen from './RoomBootstrapScreen.jsx';
import { ROOM_BOOTSTRAP_STATUS, useRoomBootstrap } from './use-room-bootstrap.js';
import PokerBootstrap from '../poker/PokerBootstrap.jsx';
import PokerGuidePage from '../poker/PokerGuidePage.jsx';
import AgileGuidePage from '../guide/AgileGuidePage.jsx';
import {
  ROOM_KIND, isBoardCreatedByMe, parseRoute, recentBoardName, rememberRecent,
} from './router.js';
import {
  ROOM_SESSION_ERROR,
  RoomSessionError,
} from '../session/room-session.js';
import RoomPasswordScreen from '../room-lock/RoomPasswordScreen.jsx';
import ReunlockDialog from '../room-lock/ReunlockDialog.jsx';
import RoomLockDialogs from '../room-lock/RoomLockDialogs.jsx';
import { establishBoardSession, getRoomKey, unlockRoom } from '../room-lock/lock-session.js';
import { showRememberFailure } from '../room-lock/room-lock-dialog-store.js';

const route = parseRoute();
// A language-prefixed page (/th/...) is shown in that language from the first paint.
const routeLanguageReady = route.lang ? setLang(route.lang) : null;

function BoardBootstrap({ code, token, mode = BOARD_MODE.PRIVATE }) {
  const state = useRoomBootstrap(async () => {
    if (mode === BOARD_MODE.PUBLIC) await establishPublicRoomSession();
    else {
      if (!token) throw new RoomSessionError(ROOM_SESSION_ERROR.INVALID);
      await establishBoardSession(code, token);
    }
    // The storage module creates its WebsocketProvider as a side effect.
    // Import it only after the server has issued the board-scoped cookie.
    await import('../session/storage-bridge.js');
    if (isBoardCreatedByMe(code, token)) {
      // Forwarded links are deliberately not persisted as recents because
      // doing so would retain their long-lived fragment capability.
      rememberRecent(code, undefined, token);
    }
  }, `${mode}:${code}:${token}`);

  if (state.status === ROOM_BOOTSTRAP_STATUS.READY) {
    const pendingTitle = isBoardCreatedByMe(code, token) ? recentBoardName(code, token) : null;
    return (
      <>
        <SyncBanner />
        <RetroBoard boardCode={code} boardToken={token} mode={mode} pendingTitle={pendingTitle} />
        {getRoomKey() && <><ReunlockDialog /><RoomLockDialogs /></>}
      </>
    );
  }
  if (state.status === ROOM_SESSION_ERROR.LOCKED) {
    // The board boots only after the password opens it; retry then runs the rest of the bootstrap.
    const unlock = async (password, remember) => {
      const result = await unlockRoom({ code, token, password, lockHint: state.lock, remember });
      showRememberFailure(result, remember);
      state.retry();
    };
    return <RoomPasswordScreen onUnlock={unlock} />;
  }
  return (
    <RoomBootstrapScreen
      publicFull={mode === BOARD_MODE.PUBLIC && state.status === ROOM_SESSION_ERROR.RATE_LIMITED}
      status={state.status}
      retryAfterSeconds={state.retryAfterSeconds}
      onRetry={state.retry}
    />
  );
}

const ROUTE_VIEWS = {
  // Every private room view ends on the deleted screen once its owner deletes it; the Public Wall is never deleted.
  board: () => (
    <RoomDeletedBoundary code={route.code} token={route.token} kind={ROOM_KIND.BOARD}>
      <BoardBootstrap code={route.code} token={route.token} />
    </RoomDeletedBoundary>
  ),
  public: () => <BoardBootstrap mode={BOARD_MODE.PUBLIC} />,
  poker: () => (
    <RoomDeletedBoundary code={route.code} token={route.token} kind={ROOM_KIND.POKER}>
      <PokerBootstrap code={route.code} token={route.token} />
    </RoomDeletedBoundary>
  ),
  pokerGuide: () => <PokerGuidePage />,
  agileGuide: () => <AgileGuidePage />,
  legal: () => <LegalPage page={route.page} />,
  template: () => <TemplatePage slug={route.slug} />,
  notFound: () => <NotFoundPage />,
};
const renderRoute = ROUTE_VIEWS[route.kind] ?? (() => <HomeRoute landingTitleKey={pageTitleKey} />);

// Subscribes once for every page, so switching language re-renders the whole view,
// not only the component that owns the language button.
function App() {
  useLang();
  return renderRoute();
}
// Boards name their own tab; content pages use their search title.
const pageTitleKey = route.kind === 'notFound' ? NOT_FOUND_TITLE_KEY : seoPageForPath(window.location.pathname)?.titleKey ?? null;

function PageHead() {
  usePageHead(pageTitleKey);
  return null;
}
// The home view sets its own title (the workspace has a different one), so it is the only head there.
const NoHead = () => null;
const RouteHead = ROUTE_VIEWS[route.kind] ? PageHead : NoHead;

// A saved or path language (/ja/...) loads first, so the page never flashes English.
Promise.all([languageReady, routeLanguageReady]).then(() => createRoot(document.getElementById('root')).render(
  <React.StrictMode><BoardErrorBoundary><RouteHead /><App /></BoardErrorBoundary></React.StrictMode>,
));
