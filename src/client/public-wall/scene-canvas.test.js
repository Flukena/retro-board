import test from 'node:test';
import assert from 'node:assert/strict';
import { readScene } from './scene-canvas.js';
import { GRID_DOT_RADIUS_PX } from '../board/grid-background.js';

const TEXT_NODE = 3;
const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const BASE_STYLE = Object.freeze({
  display: 'block', visibility: 'visible', opacity: '1', backgroundColor: TRANSPARENT, backgroundImage: 'none',
  backgroundSize: 'auto', backgroundPosition: '0px 0px', borderTopLeftRadius: '0px', borderTopWidth: '0px',
  borderTopStyle: 'none', borderTopColor: TRANSPARENT, boxShadow: 'none', paddingTop: '0px', paddingRight: '0px',
  paddingBottom: '0px', paddingLeft: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
  fontStyle: 'normal', fontWeight: '400', fontSize: '16px', fontFamily: 'Sarabun', lineHeight: 'normal',
  color: 'rgb(0, 0, 0)', textAlign: 'start', whiteSpace: 'normal', objectFit: 'fill', gridDot: '',
  overflowX: 'visible', overflowY: 'visible', contain: 'none', position: 'static', zIndex: 'auto',
  transform: 'none', filter: 'none', isolation: 'auto',
});

class FakeElement {
  constructor(document, { tag = 'DIV', rect, offsetWidth = rect.width, style = {}, text = null, src = null }) {
    Object.assign(this, { ownerDocument: document, tagName: tag, offsetWidth, rect, parentElement: null, children: [] });
    this.style = { ...BASE_STYLE, ...style };
    this.childNodes = text === null ? [] : [{ nodeType: TEXT_NODE, nodeValue: text }];
    this.src = src;
  }
  append(...children) {
    for (const child of children) { child.parentElement = this; this.children.push(child); this.childNodes.push(child); }
    return this;
  }
  getBoundingClientRect() { return this.rect; }
  getAttribute(name) { return name === 'src' ? this.src : null; }
  closest(selector) {
    if (selector !== 'svg') return null;
    for (let node = this; node; node = node.parentElement) if (node.tagName === 'svg') return node;
    return null;
  }
  querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); }
}

function fakeDocument() {
  const document = { baseURI: 'https://retroroom.party/' };
  document.defaultView = { getComputedStyle: element => ({ ...element.style,
    getPropertyValue: name => (name === '--grid-dot' ? element.style.gridDot : '') }) };
  return document;
}
const rect = (x, y, width, height) => ({ x, y, left: x, top: y, width, height });

test('cards are measured relative to the scene, scaled to the 1200px snapshot and kept in DOM order', () => {
  const document = fakeDocument();
  // The scene is shown at half size, so every client pixel is two snapshot pixels.
  const root = new FakeElement(document, { rect: rect(100, 50, 600, 360), offsetWidth: 1200, style: { backgroundColor: 'rgb(250, 248, 244)' } });
  const back = new FakeElement(document, { rect: rect(110, 60, 50, 40), offsetWidth: 100, style: { backgroundColor: 'rgb(254, 243, 199)' } });
  const front = new FakeElement(document, { rect: rect(120, 70, 50, 40), offsetWidth: 100, style: { backgroundColor: 'rgb(187, 247, 208)' } });
  root.append(back, front);
  const scene = readScene(root);
  assert.equal(scene.width, 1200); assert.equal(scene.background, 'rgb(250, 248, 244)');
  assert.deepEqual(scene.plates.map(({ x, y, w, h, background }) => ({ x, y, w, h, background })), [
    { x: 20, y: 20, w: 100, h: 80, background: 'rgb(254, 243, 199)' },
    { x: 40, y: 40, w: 100, h: 80, background: 'rgb(187, 247, 208)' },
  ]);
});

test('lengths from CSS follow the board zoom of each card', () => {
  const document = fakeDocument();
  const root = new FakeElement(document, { rect: rect(0, 0, 1200, 720) });
  // 200 CSS px rendered 100 px wide: the card sits in a world scaled to 0.5.
  const card = new FakeElement(document, { rect: rect(0, 0, 100, 90), offsetWidth: 200, text: 'hello  world',
    style: { backgroundColor: 'red', borderTopLeftRadius: '4px', boxShadow: 'rgba(0, 0, 0, 0.5) 0px 16px 18px -14px',
      paddingTop: '14px', paddingLeft: '14px', paddingRight: '14px', paddingBottom: '14px', fontSize: '20px', lineHeight: '30px',
      fontWeight: '500', color: 'rgb(31, 41, 55)' } });
  root.append(card);
  const [plate] = readScene(root).plates;
  assert.equal(plate.radius, 2);
  assert.deepEqual(plate.shadows, [{ color: 'rgba(0, 0, 0, 0.5)', offsetX: 0, offsetY: 8, blur: 9, spread: -7 }]);
  assert.deepEqual(plate.text, { content: 'hello world', font: 'normal 500 10px Sarabun', color: 'rgb(31, 41, 55)',
    lineHeight: 15, align: 'start', box: { x: 7, y: 7, w: 86, h: 76 }, clip: null, wrap: true });
});

test('pre-wrapped card text keeps its line breaks and spaces', () => {
  const document = fakeDocument();
  const root = new FakeElement(document, { rect: rect(0, 0, 1200, 720) });
  root.append(new FakeElement(document, { rect: rect(0, 0, 100, 100), text: 'a\n  b', style: { whiteSpace: 'pre-wrap' } }),
    new FakeElement(document, { rect: rect(0, 0, 100, 100), text: 'Retro  A', style: { whiteSpace: 'nowrap' } }));
  const [preWrapped, noWrap] = readScene(root).plates;
  assert.equal(preWrapped.text.content, 'a\n  b'); assert.equal(preWrapped.text.wrap, true);
  assert.equal(noWrap.text.content, 'Retro A'); assert.equal(noWrap.text.wrap, false);
});

test('hidden, transparent, icon and empty elements are not painted and opacity multiplies down the tree', () => {
  const document = fakeDocument();
  const root = new FakeElement(document, { rect: rect(0, 0, 1200, 720) });
  const faded = new FakeElement(document, { rect: rect(0, 0, 100, 100), style: { opacity: '0.5', backgroundColor: 'red' } });
  faded.append(new FakeElement(document, { rect: rect(0, 0, 50, 50), style: { opacity: '0.5', backgroundColor: 'blue' } }));
  const icon = new FakeElement(document, { tag: 'svg', rect: rect(0, 0, 10, 10), style: { backgroundColor: 'green' } });
  icon.append(new FakeElement(document, { rect: rect(0, 0, 10, 10), style: { backgroundColor: 'green' } }));
  root.append(faded, icon,
    new FakeElement(document, { rect: rect(0, 0, 10, 10), style: { display: 'none', backgroundColor: 'green' } }),
    new FakeElement(document, { rect: rect(0, 0, 10, 10), style: { visibility: 'hidden', backgroundColor: 'green' } }),
    new FakeElement(document, { rect: rect(0, 0, 10, 10), style: { opacity: '0', backgroundColor: 'green' } }),
    new FakeElement(document, { rect: rect(0, 0, 10, 10) }));
  assert.deepEqual(readScene(root).plates.map(({ background, alpha }) => [background, alpha]), [['red', 0.5], ['blue', 0.25]]);
});

test('borders are kept only when visible and images point at their same-origin public URL', () => {
  const document = fakeDocument();
  const root = new FakeElement(document, { rect: rect(0, 0, 1200, 720) });
  const src = `/yjs-public/rooms/${'A'.repeat(32)}/images/0000000a.png`;
  root.append(
    new FakeElement(document, { rect: rect(0, 0, 100, 100), style: { borderTopWidth: '2px', borderTopStyle: 'solid', borderTopColor: 'orange' } }),
    new FakeElement(document, { rect: rect(0, 0, 100, 100), style: { borderTopWidth: '2px', borderTopStyle: 'none', borderTopColor: 'orange', backgroundColor: 'red' } }),
    new FakeElement(document, { tag: 'IMG', rect: rect(0, 0, 100, 100), src, style: { objectFit: 'cover' } }));
  const [bordered, plain, image] = readScene(root).plates;
  assert.deepEqual(bordered.border, { width: 2, color: 'orange', style: 'solid' });
  assert.equal(plain.border, null);
  assert.deepEqual(image.image, { url: `https://retroroom.party${src}`, fit: 'cover' });
});

test('the board grid uses the scene dot colour, tile size and offset', () => {
  const document = fakeDocument();
  const root = new FakeElement(document, { rect: rect(0, 0, 1200, 720), style: {
    backgroundImage: 'radial-gradient(circle, rgba(110, 80, 40, 0.16) 1px, transparent 1px)',
    backgroundSize: '24px 24px', backgroundPosition: '-30px 12px', gridDot: 'rgba(110,80,40,0.16)' } });
  assert.deepEqual(readScene(root).grid, { color: 'rgba(110,80,40,0.16)', pitch: 24, offsetX: -30, offsetY: 12, radius: GRID_DOT_RADIUS_PX });
  root.style.backgroundImage = 'none';
  assert.equal(readScene(root).grid, null);
});

test('overflow-hidden and paint-contained elements clip what they contain, not themselves', () => {
  const document = fakeDocument();
  const root = new FakeElement(document, { rect: rect(0, 0, 1200, 720) });
  const card = new FakeElement(document, { rect: rect(10, 10, 100, 100), style: { contain: 'layout style paint', backgroundColor: 'red' } });
  const body = new FakeElement(document, { rect: rect(20, 20, 50, 40), text: 'long text', style: { overflowX: 'hidden', overflowY: 'hidden' } });
  card.append(body);
  root.append(card, new FakeElement(document, { rect: rect(300, 300, 10, 10), style: { backgroundColor: 'blue' } }));
  const [cardPlate, bodyPlate, outside] = readScene(root).plates;
  assert.equal(cardPlate.clip, null, 'a card is not clipped by its own containment');
  assert.deepEqual(bodyPlate.clip, { x: 10, y: 10, w: 100, h: 100 });
  assert.deepEqual(bodyPlate.text.clip, { x: 20, y: 20, w: 50, h: 40 }, 'text is clipped to the overflow-hidden body inside the card');
  assert.equal(outside.clip, null);
});

test('positioned elements with z-index paint above later cards, like a zone title above a text card', () => {
  const document = fakeDocument();
  const root = new FakeElement(document, { rect: rect(0, 0, 1200, 720) });
  const world = new FakeElement(document, { rect: rect(0, 0, 1200, 720), style: { transform: 'matrix(1, 0, 0, 1, 0, 0)' } });
  const zone = new FakeElement(document, { rect: rect(0, 0, 500, 300), style: { position: 'absolute', backgroundColor: 'zone' } });
  zone.append(new FakeElement(document, { rect: rect(10, 10, 100, 30), style: { position: 'absolute', zIndex: '4', backgroundColor: 'chip' } }));
  // A sticky forms its own stacking context, so its high-z child stays with it.
  const sticky = new FakeElement(document, { rect: rect(50, 50, 100, 100), style: { position: 'absolute', contain: 'paint', backgroundColor: 'sticky' } });
  sticky.append(new FakeElement(document, { rect: rect(50, 50, 10, 10), style: { position: 'absolute', zIndex: '9', backgroundColor: 'badge' } }));
  const label = new FakeElement(document, { rect: rect(12, 12, 80, 20), text: 'Sprint 42', style: { position: 'absolute' } });
  world.append(zone, sticky, label);
  root.append(world);
  const order = readScene(root).plates.map(plate => plate.background || plate.text.content);
  assert.deepEqual(order, ['zone', 'sticky', 'badge', 'Sprint 42', 'chip']);
});
