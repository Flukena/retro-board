import test from 'node:test';
import assert from 'node:assert/strict';
import { isInAppBrowser } from './in-app-browser.js';

const LINE_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/13.9.0';
const FACEBOOK = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/440.0.0.0]';
const FACEBOOK_IOS = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/440.0]';
const INSTAGRAM = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 Instagram 300.0';
const MESSENGER = 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36 Messenger';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

test('isInAppBrowser detects LINE and Facebook but not Chrome or Safari', () => {
  for (const ua of [LINE_IOS, FACEBOOK, FACEBOOK_IOS, INSTAGRAM, MESSENGER]) assert.equal(isInAppBrowser(ua), true, ua);
  for (const ua of [CHROME, SAFARI, '', undefined, null]) assert.equal(isInAppBrowser(ua), false, String(ua));
});
