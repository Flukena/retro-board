import { withSsrModule } from './ssr-load.js';

// Chrome subjects and their translations must share the same Vite module instances.
export function withChromeModule(path, check, options) {
  return withSsrModule(path, async (subject, { load }) => {
    await check(subject, await load('/src/client/ui/i18n.js'), { load });
  }, options);
}
