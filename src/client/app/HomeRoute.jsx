import React, { useEffect, useState } from 'react';
import Landing from './Landing.jsx';
import Workspace from '../workspace/Workspace.jsx';
import CreateMenu from '../workspace/CreateMenu.jsx';
import { isSignedIn } from '../account/account-api.js';
import { readSignedInHint } from '../account/signed-in-hint.js';
import { usePageHead } from '../seo/use-page-head.js';
import { useAccountSession } from '../account/use-account-session.js';
import { documentTitleFor } from './document-title.js';
import { HOME_HINT_CLASS, HOME_VIEW, homeViewFor } from './home-view.js';
import './home.css';

const WORKSPACE_TITLE_KEY = 'workspace.title';

/**
 * `/` and its language-prefixed homes: the guest landing, or "My boards" for a signed-in person. Signing out
 * switches back at once. This view owns the tab title and <html lang>: the workspace names itself, the
 * landing keeps the page's own search title (`landingTitleKey`).
 */
export default function HomeRoute({ landingTitleKey = null }) {
  // Read once: the account answer, not later hint changes, decides any switch after the first paint.
  const [hinted] = useState(readSignedInHint);
  const session = useAccountSession();
  // React now owns the page, so the head script's hide-the-landing mark has done its job.
  useEffect(() => { document.documentElement.classList.remove(HOME_HINT_CLASS); }, []);
  const view = homeViewFor({ hinted, session });
  const isWorkspace = view === HOME_VIEW.WORKSPACE;
  usePageHead(isWorkspace ? WORKSPACE_TITLE_KEY : landingTitleKey, isWorkspace ? documentTitleFor : undefined);
  if (!isWorkspace) return <Landing />;
  // The create menu reads the whole session: its status and the account's entitlements. A hinted page
  // shows the workspace before the account answer, and creating waits for that answer.
  return <Workspace canCreate={isSignedIn(session)} createAction={<CreateMenu session={session} />} />;
}
