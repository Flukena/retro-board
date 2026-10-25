import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { MOBILE_LAYOUT_QUERY, APP_VIEWPORT_CONTENT } from './mobile-layout.js';

const readSource = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');

test('mobile chrome reserves a left rail and separate zoom/minimap lanes with safe areas', () => {
  const css = readSource('./mobile-layout.css');
  assert.match(css, /--rb-mobile-touch-target-px:\s*44px/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /\.rb-tool-dock\.rb-tool-dock\s*\{[^}]*width:\s*var\(--rb-mobile-rail-width-px\)/);
  assert.match(css, /\.rb-zoom-controls\.rb-zoom-controls\s*\{[^}]*bottom:\s*var\(--rb-mobile-zoom-bottom-px\)/);
  assert.match(css, /\.rb-minimap\.rb-minimap\s*\{[^}]*bottom:\s*var\(--rb-mobile-minimap-bottom-px\)/);
});

test('mobile header keeps every control reachable and template picker is a bounded bottom sheet', () => {
  const css = readSource('./mobile-layout.css');
  assert.match(css, /\.rb-topbar-scroll\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.rb-template-popover\.rb-template-popover[\s\S]*?position:\s*fixed/);
  assert.match(css, /max-height:\s*65dvh/);
  assert.match(css, /overscroll-behavior:\s*contain/);
  assert.match(readSource('../chrome/TopBar.jsx'), /import '\.\.\/ui\/mobile-layout.css'/);
});

test('mobile sticky creation emits one action without changing desktop tool selection', async () => {
  await withChromeModule('/src/client/chrome/ToolDock.jsx', ({ ToolDock, TOOL_ID }) => {
    let added = 0;
    const withoutSticky = ToolDock({});
    const withSticky = ToolDock({ onAddSticky: () => { added += 1; } });
    const tiles = (tree) => tree.props.children[0].props.children;
    const sticky = tiles(withSticky).find((child) => child?.props?.toolId === 'sticky');
    assert.ok(sticky);
    assert.equal(sticky.props.className, 'rb-dock-tile rb-mobile-only');
    assert.equal(tiles(withoutSticky).some((child) => child?.props?.toolId === 'sticky'), false);
    sticky.props.onClick();
    assert.equal(added, 1);
    assert.equal(Object.values(TOOL_ID).includes('sticky'), false);
  });
});

test('layout query covers narrow screens and touch tablets without changing wide desktop layout', () => {
  assert.equal(MOBILE_LAYOUT_QUERY, '(max-width: 767px), (max-width: 1024px) and (pointer: coarse)');
  const css = readSource('./mobile-layout.css');
  assert.ok(css.includes(`@media ${MOBILE_LAYOUT_QUERY}`));
});

test('mobile selection toolbar stays inside the viewport and keeps all actions scrollable', () => {
  const css = readSource('./mobile-layout.css');
  assert.match(css, /\.rb-selection-toolbar\.rb-selection-toolbar\s*\{[^}]*left:\s*var\(--rb-mobile-canvas-left-px\)/);
  assert.match(css, /\.rb-selection-toolbar\.rb-selection-toolbar\s*\{[^}]*right:\s*var\(--rb-mobile-right-px\)/);
  assert.match(css, /\.rb-selection-toolbar\.rb-selection-toolbar\s*\{[^}]*top:\s*auto/);
  assert.match(css, /\.rb-selection-toolbar\.rb-selection-toolbar\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.rb-selection-toolbar button\s*\{[^}]*min-height:\s*var\(--rb-mobile-touch-target-px\)/);
  assert.match(css, /\.rb-selection-toolbar > \*\s*\{[^}]*flex-shrink:\s*0/);
  assert.match(css, /:root:has\(\.rb-selection-toolbar\)/);
  assert.match(css, /\.rb-font-color-picker\.rb-font-color-picker\s*\{[^}]*position:\s*fixed/);
});

test('mobile resize handles enlarge hit areas while keeping small visible knobs', () => {
  const css = readSource('./mobile-layout.css');
  assert.match(css, /\[data-mobile-resize="true"\]\s*\{[^}]*--rb-resize-target-px:\s*var\(--rb-mobile-touch-target-px\)/);
  assert.match(css, /\[data-mobile-resize="true"\]\s*\{[^}]*--rb-resize-bg:\s*transparent/);
  assert.match(css, /\[data-mobile-resize="true"\]\s*\{[^}]*--rb-resize-border:\s*none/);
  assert.match(css, /\[data-mobile-resize="true"\]::after\s*\{[^}]*width:\s*var\(--rb-mobile-resize-knob-px\)/);
  assert.match(css, /\[data-mobile-resize="true"\]::after\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.rb-desktop-only\s*\{[^}]*display:\s*none/);
});

test('mobile rail reserves room for the full Templates label and keeps tool labels on one line', () => {
  const css = readSource('./mobile-layout.css');
  assert.match(css, /--rb-mobile-rail-width-px:\s*76px/);
  assert.match(css, /\.rb-tool-dock__body\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.rb-dock-tile__label\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.rb-dock-tile__label\s*\{[^}]*overflow-wrap:\s*normal/);
  assert.match(css, /\.rb-dock-tile__label > svg\[aria-hidden="true"\]\s*\{[^}]*display:\s*none/);
});

test('landing preserves safe-area viewport coverage and uses usable mobile controls', () => {
  const viewport = Object.fromEntries(APP_VIEWPORT_CONTENT.split(', ').map((entry) => entry.split('=')));
  assert.equal(viewport['viewport-fit'], 'cover');
  assert.equal(viewport['maximum-scale'], '1.0');
  assert.equal(viewport['minimum-scale'], '1.0');
  assert.equal(viewport['user-scalable'], 'no');
  assert.match(readSource('../app/Landing.jsx'), /meta.setAttribute\([\s\S]*?'content',\s*APP_VIEWPORT_CONTENT/);
  const css = readSource('../app/landing.css');
  assert.ok(css.includes(`@media ${MOBILE_LAYOUT_QUERY}`));
  assert.match(css, /--landing-control-font-size:\s*16px/);
  assert.match(css, /--landing-control-height:\s*44px/);
  assert.match(css, /env\(safe-area-inset-top/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /\.rb-landing__page button\s*\{[^}]*min-height:\s*var\(--landing-control-height\)/);
});

test('mobile connection status leaves board controls tappable and retry reachable', () => {
  const css = readSource('./mobile-layout.css');
  assert.match(css, /\.rb-sync-banner\.rb-sync-banner\s*\{[^}]*bottom:\s*auto/);
  assert.match(css, /\.rb-sync-banner\.rb-sync-banner\s*\{[^}]*top:\s*calc\(var\(--rb-mobile-top-px\)/);
  assert.match(css, /\.rb-sync-banner\.rb-sync-banner\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.rb-sync-banner\.rb-sync-banner\s*\{[^}]*max-height:\s*35dvh/);
  assert.match(css, /\.rb-sync-banner \.rb-btn\s*\{[^}]*pointer-events:\s*auto/);
  assert.match(css, /\.rb-sync-banner \.rb-btn\s*\{[^}]*min-height:\s*var\(--rb-mobile-touch-target-px\)/);
  assert.doesNotMatch(readSource('../session/SyncBanner.jsx'), /style=\{\{ bottom:/);
});

test('left tool rail is content-sized and scrolls its buttons within short viewports', () => {
  const css = readSource('../chrome/tool-dock.css');
  assert.match(css, /\.rb-tool-dock\s*\{[^}]*position:\s*fixed/);
  assert.match(css, /\.rb-tool-dock\s*\{[^}]*bottom:\s*auto/);
  assert.match(css, /\.rb-tool-dock__body\s*\{[^}]*flex-direction:\s*column/);
  assert.match(css, /\.rb-tool-dock__body\s*\{[^}]*max-height:\s*calc\(100dvh/);
  assert.match(css, /\.rb-tool-dock__body\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.rb-template-popover\s*\{[^}]*left:\s*calc\(100%/);
  const mobile = readSource('./mobile-layout.css');
  assert.match(mobile, /--rb-mobile-zoom-bottom-px:\s*var\(--rb-mobile-bottom-px\)/);
  for (const edge of ['left', 'top', 'bottom']) assert.ok(mobile.includes(`--rb-mobile-canvas-${edge}-px:`));
});

test('inline mobile text editing temporarily clears selection controls from the Done lane', () => {
  const css = readSource('./mobile-layout.css');
  assert.match(css, /:root:has\(\.rb-mobile-editor__input:focus\) \.rb-selection-toolbar\s*\{[^}]*display:\s*none/);
  for (const control of ['rb-zoom-controls', 'rb-minimap']) {
    assert.ok(css.includes(`:root:has(.rb-mobile-editor__input:focus) .${control}`));
  }
});

test('page boundaries suppress pull-to-refresh without blocking native content scrolling', () => {
  const html = readSource('../../../index.html');
  assert.match(html, /html, body, #root\s*\{[^}]*overscroll-behavior:\s*none/);
  assert.doesNotMatch(html, /touch-action:\s*none/);
  assert.match(readSource('../app/landing.css'), /\.rb-landing__page\s*\{[^}]*overflow:\s*auto/);
});
