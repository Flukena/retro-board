import React, { useEffect, useState } from 'react';
import Landing from './Landing.jsx';
import Workspace from '../workspace/Workspace.jsx';
import CreateMenu from '../workspace/CreateMenu.jsx';
import { readSignedInHint } from '../account/signed-in-hint.js';
import { useAccountSession } from '../account/use-account-session.js';
import { HOME_HINT_CLASS, HOME_VIEW, homeViewFor } from './home-view.js';
import './home.css';

/** `/`: the guest landing, or "My boards" for a signed-in person. Signing out switches back at once. */
export default function HomeRoute() {
  // Read once: the account answer, not later hint changes, decides any switch after the first paint.
  const [hinted] = useState(readSignedInHint);
  const session = useAccountSession();
  // React now owns the page, so the head script's hide-the-landing mark has done its job.
  useEffect(() => { document.documentElement.classList.remove(HOME_HINT_CLASS); }, []);
  if (homeViewFor({ hinted, session }) === HOME_VIEW.LANDING) return <Landing />;
  // The create menu reads the whole session: its status and the account's entitlements.
  return <Workspace createAction={<CreateMenu session={session} />} />;
}
