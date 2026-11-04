import { BOARD_MODE } from '../../domain/public-wall-contract.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/native-selection.css';
import '../ui/theme.js'; // apply CSS variables on <html> before first paint
import RetroBoard from '../../../RetroBoard.jsx';
import { establishPublicRoomSession } from '../public-wall/public-room-session.js';
import Landing from './Landing.jsx';
import LegalPage from '../legal/LegalPage.jsx';
import TemplatePage from '../templates/TemplatePage.jsx';
import NotFoundPage from './NotFoundPage.jsx';
import { NOT_FOUND_TITLE_KEY, seoPageForPath } from '../seo/seo-pages.js';
import { usePageHead } from '../seo/use-page-head.js';
import { BoardErrorBoundary } from './BoardErrorBoundary.jsx';
import { SyncBanner } from '../session/SyncBanner.jsx';
import { languageReady, setLang, useLang } from '../ui/i18n.js';
import RoomBootstrapScreen from './RoomBootstrapScreen.jsx';
import { ROOM_BOOTSTRAP_STATUS, useRoomBootstrap } from './use-room-bootstrap.js';
import PokerBootstrap from '../poker/PokerBootstrap.jsx';
import PokerGuidePage from '../poker/PokerGuidePage.jsx';
import AgileGuidePage from '../guide/AgileGuidePage.jsx';
import {
  isBoardCreatedByMe, parseRoute, recentBoardName, rememberRecent,
} from './router.js';
import {
  ROOM_SESSION_ERROR,
  RoomSessionError,
  establishRoomSession,
} from '../session/room-session.js';

const route = parseRoute();
// A language-prefixed page (/th/...) is shown in that language from the first paint.
const routeLanguageReady = route.lang ? setLang(route.lang) : null;

function BoardBootstrap({ code, token, mode = BOARD_MODE.PRIVATE }) {
  const state = useRoomBootstrap(async () => {
    if (mode === BOARD_MODE.PUBLIC) await establishPublicRoomSession();
    else {
      if (!token) throw new RoomSessionError(ROOM_SESSION_ERROR.INVALID);
      await establishRoomSession(code, token);
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
    return <><SyncBanner /><RetroBoard boardCode={code} boardToken={token} mode={mode} pendingTitle={pendingTitle} /></>;
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
  board: () => <BoardBootstrap code={route.code} token={route.token} />,
  public: () => <BoardBootstrap mode={BOARD_MODE.PUBLIC} />,
  poker: () => <PokerBootstrap code={route.code} token={route.token} />,
  pokerGuide: () => <PokerGuidePage />,
  agileGuide: () => <AgileGuidePage />,
  legal: () => <LegalPage page={route.page} />,
  template: () => <TemplatePage slug={route.slug} />,
  notFound: () => <NotFoundPage />,
};
const renderRoute = ROUTE_VIEWS[route.kind] ?? (() => <Landing />);

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

// A saved or path language (/ja/...) loads first, so the page never flashes English.
Promise.all([languageReady, routeLanguageReady]).then(() => createRoot(document.getElementById('root')).render(
  <React.StrictMode><BoardErrorBoundary><PageHead /><App /></BoardErrorBoundary></React.StrictMode>,
));
