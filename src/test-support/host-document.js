// Minimal host DOM for React DOM's real renderer. It implements storage and
// tree operations only; React itself performs reconciliation, effects and error capture.
const ELEMENT_NODE_TYPE = 1;
const DOCUMENT_NODE_TYPE = 9;
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const CLASS_ATTRIBUTE = 'class';

/** The `class` attribute read and written as a set of names, like Element.classList. */
class HostClassList {
  #element;

  constructor(element) { this.#element = element; }

  #names() { return (this.#element.attributes.get(CLASS_ATTRIBUTE) ?? '').split(/\s+/).filter(Boolean); }
  #write(names) { this.#element.setAttribute(CLASS_ATTRIBUTE, names.join(' ')); }
  contains(name) { return this.#names().includes(name); }
  add(name) { if (!this.contains(name)) this.#write([...this.#names(), name]); }
  remove(name) { this.#write(this.#names().filter((existing) => existing !== name)); }
}

class HostElement extends EventTarget {
  nodeType = ELEMENT_NODE_TYPE;
  namespaceURI = HTML_NAMESPACE;
  childNodes = [];
  attributes = new Map();
  style = {};
  parentNode = null;
  classList = new HostClassList(this);
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

/** React DOM checks focused frames with `instanceof window.HTMLIFrameElement`. */
export class HostIFrame extends HostElement {}

export function createHostDocument() {
  const document = new EventTarget();
  document.nodeType = DOCUMENT_NODE_TYPE;
  document.createElement = (name) => new HostElement(name, document);
  document.documentElement = document.createElement('html');
  document.body = document.createElement('body');
  document.activeElement = document.body;
  return document;
}
