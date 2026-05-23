import React from 'react';
import { createRoot } from 'react-dom/client';
import './storage-bridge.js';
import './theme.js'; // apply CSS variables on <html> before first paint
import RetroBoard from '../RetroBoard.jsx';
import Landing from './Landing.jsx';
import { parseRoute, rememberRecent, isBoardCreatedByMe } from './router.js';

const route = parseRoute();
const App = route.kind === 'board'
  ? <RetroBoard boardCode={route.code} boardToken={route.token} />
  : <Landing />;

if (route.kind === 'board' && isBoardCreatedByMe(route.code, route.token)) {
  // Only persist boards we created. Boards opened via a forwarded share link
  // are NOT auto-saved into recents — otherwise the secret token sits in
  // localStorage long after the user thought they "just took a look".
  rememberRecent(route.code, undefined, route.token);
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>{App}</React.StrictMode>,
);
