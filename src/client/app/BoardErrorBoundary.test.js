import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('boundary preserves a healthy board and offers translated reload after a render error', async () => {
  await withChromeModule('/src/client/app/BoardErrorBoundary.jsx', ({ BoardErrorBoundary }, { setLang, t }) => {
    const child = React.createElement('p', null, 'Healthy board');
    const boundary = new BoardErrorBoundary({ children: child });
    assert.equal(boundary.render(), child);
    boundary.state = BoardErrorBoundary.getDerivedStateFromError(new Error('broken child'));
    for (const language of ['en', 'th']) {
      setLang(language);
      const markup = renderToStaticMarkup(boundary.render());
      assert.ok(markup.includes(t('resilience.error.title')));
      assert.ok(markup.includes(t('resilience.reload')));
      assert.ok(markup.includes('role="alert"'));
      assert.ok(!markup.includes('Healthy board'));
    }
  });
});

// Minimal host DOM for React DOM's real renderer. It implements storage and
// tree operations only; React itself performs reconciliation and error capture.
const ELEMENT_NODE_TYPE = 1;
const DOCUMENT_NODE_TYPE = 9;
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
class HostElement extends EventTarget {
  nodeType = ELEMENT_NODE_TYPE;
  namespaceURI = HTML_NAMESPACE;
  childNodes = [];
  attributes = new Map();
  style = {};
  parentNode = null;
  #text = '';

  constructor(name, ownerDocument) {
    super();
    this.tagName = name.toUpperCase();
    this.nodeName = this.tagName;
    this.ownerDocument = ownerDocument;
  }

  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent() { return this.#text + this.childNodes.map((child) => child.textContent).join(''); }
  set textContent(value) { this.#text = value; this.childNodes = []; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; }
  removeChild(child) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
}
class HostIFrame extends HostElement {}

function createHostDocument() {
  const document = new EventTarget();
  document.nodeType = DOCUMENT_NODE_TYPE;
  document.createElement = (name) => new HostElement(name, document);
  document.body = document.createElement('body');
  document.activeElement = document.body;
  return document;
}

function ThrowingDescendant() {
  throw new Error('boundary regression fixture');
}

test('React catches a throwing descendant and mounts the translated recovery screen', async (context) => {
  const oldWindow = globalThis.window;
  globalThis.window = { HTMLIFrameElement: HostIFrame };
  context.after(() => {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  });
  await withChromeModule('/src/client/app/BoardErrorBoundary.jsx', ({ BoardErrorBoundary }, { setLang, t }) => {
    const document = createHostDocument();
    for (const language of ['th', 'en']) {
      setLang(language);
      const container = document.createElement('div');
      const root = createRoot(container);
      try {
        assert.doesNotThrow(() => flushSync(() => root.render(
          React.createElement(BoardErrorBoundary, null, React.createElement(ThrowingDescendant)),
        )));
        assert.ok(container.textContent.includes(t('resilience.error.title')));
        assert.ok(container.textContent.includes(t('resilience.reload')));
        const panel = container.firstChild.firstChild;
        assert.equal(panel.attributes.get('role'), 'alert');
      } finally {
        flushSync(() => root.unmount());
      }
    }
  });
});
