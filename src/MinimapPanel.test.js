import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';
import { targetsClass } from './scoped-class-test-helper.js';

const MODEL = { width: 220, height: 132, items: [], viewport: { x: 12, y: 8, w: 90, h: 60 } };

test('panel attaches owner refs, forwards events and leaves visibility to imperative writes', async () => {
  await withChromeModule('/src/MinimapPanel.jsx', ({ MinimapPanel }) => {
    const panelRef = React.createRef();
    const viewportRef = React.createRef();
    const calls = [];
    const onReveal = (event) => calls.push(event);
    const onNavigatePointerDown = (event) => calls.push(event);
    const onNavigateKeyDown = (event) => calls.push(event);
    const panel = MinimapPanel({ panelRef, viewportRef, model: MODEL, colors: [], zoomPercent: 100,
      onReveal, onNavigatePointerDown, onNavigateKeyDown });
    assert.equal(panel.ref, panelRef);
    assert.equal(Object.hasOwn(panel.props.style, 'opacity'), false);
    assert.equal(Object.hasOwn(panel.props.style, 'pointerEvents'), false);
    for (const name of ['onPointerEnter', 'onPointerLeave', 'onFocusCapture', 'onBlurCapture']) {
      assert.equal(panel.props[name], onReveal);
      panel.props[name](name);
    }
    const surface = panel.props.children[1];
    assert.equal(surface.props.onPointerDown, onNavigatePointerDown);
    assert.equal(surface.props.onKeyDown, onNavigateKeyDown);
    surface.props.onPointerDown('pointer');
    surface.props.onKeyDown('key');
    assert.deepEqual(calls, ['onPointerEnter', 'onPointerLeave', 'onFocusCapture', 'onBlurCapture', 'pointer', 'key']);
    const viewport = surface.props.children[1];
    assert.equal(viewport.ref, viewportRef);
    assert.equal(viewport.props['aria-hidden'], 'true');
    assert.equal(viewport.props.style.width, MODEL.viewport.w);
    assert.equal(viewport.props.style.height, MODEL.viewport.h);
    assert.equal(viewport.props.style.transform, 'translate3d(12px, 8px, 0)');
  });
});

test('navigation surface retains localized accessible controls and helper-derived zoom in th and en', async () => {
  await withChromeModule('/src/MinimapPanel.jsx', async ({ MinimapPanel }, { getLang, setLang, t }) => {
    const { minimapZoomPercent } = await import('./minimap.js');
    const originalLang = getLang();
    try {
      for (const language of ['th', 'en']) {
        setLang(language);
        const panel = MinimapPanel({ model: MODEL, colors: [], zoomPercent: minimapZoomPercent(1.235) });
        const surface = panel.props.children[1];
        assert.equal(surface.props.role, 'button');
        assert.equal(surface.props.tabIndex, 0);
        assert.equal(surface.props['aria-label'], t('minimap.navigate'));
        assert.equal(surface.props.title, t('minimap.navigate'));
        assert.equal(panel.props['aria-label'], t('minimap.title'));
        const header = renderToStaticMarkup(panel.props.children[0]);
        assert.ok(header.includes(t('minimap.title')));
        assert.match(header, />124%<\/span>/);
      }
    } finally {
      setLang(originalLang);
    }
  });
});

test('frame CSS preserves geometry ownership and uses a more specific focus rule', () => {
  const css = readFileSync(new URL('./minimap.css', import.meta.url), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const viewportClasses = new Set(['rb-minimap__viewport']);
  const viewportRules = rules.filter(([, selectors]) => selectors.split(',')
    .some((selector) => targetsClass(selector, 'rb-minimap__viewport', viewportClasses)));
  assert.ok(viewportRules.length > 0);
  for (const [, , declarations] of viewportRules) {
    assert.doesNotMatch(declarations, /(?:^|;)\s*(?:transform|width|height)\s*:/);
  }
  const panelRule = rules.find(([, selector]) => selector.trim() === '.rb-minimap');
  assert.match(panelRule[2], /opacity:\s*0\s*;/);
  assert.match(panelRule[2], /pointer-events:\s*none\s*;/);
  assert.match(css, /\.rb-minimap-surface:focus-visible\s*\{\s*outline:\s*3px solid var\(--accent\);/);
  assert.match(css, /@media\s*\(max-width:\s*700px\)\s*\{\s*\.rb-minimap\s*\{\s*transform:\s*scale\(0\.82\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.rb-minimap\s*\{\s*transition:\s*none/);
});
