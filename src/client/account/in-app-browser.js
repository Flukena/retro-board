// Embedded browsers that Google refuses to sign in from (error 403 disallowed_useragent).
const IN_APP_BROWSER_PATTERN = /\bLine\/|FBAN|FBAV|FB_IAB|Messenger|Instagram/;

export function isInAppBrowser(userAgent) {
  return IN_APP_BROWSER_PATTERN.test(String(userAgent ?? ''));
}
