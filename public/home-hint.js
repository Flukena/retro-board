// Runs in <head> before the stylesheet: on the home page of a browser that was signed in last
// time, mark <html> so home.css hides the guest landing and the workspace appears without a flash.
// Values and the path rule mirror src/client/account/signed-in-hint.js, src/client/app/home-view.js
// and isLandingPath in src/client/app/router.js; src/client/app/home-view.test.js runs this file
// against them. Reads storage only, never writes it.
(() => {
  const HINT_KEY = 'rb_signed_in';
  const HINT_VALUE = '1';
  const HINT_CLASS = 'rb-home-hinted';
  // '/', '/index.html', and the same under a non-English language prefix (English has none).
  const LANDING_PATH = /^(?:\/(?:th|zh|ja|ko|es|pt|de|fr|vi|id))?(?:\/|\/index\.html)?$/;
  if (!LANDING_PATH.test(location.pathname)) return;
  try {
    if (localStorage.getItem(HINT_KEY) === HINT_VALUE) document.documentElement.classList.add(HINT_CLASS);
  } catch {
    // Storage is blocked: show the landing, as for any guest.
  }
})();
