import test from 'node:test';
import assert from 'node:assert/strict';
import { isStickyHiddenForUser } from './board-visibility.js';

test('private sticky visibility respects author, board reveal and nested-zone override', () => {
  const outer = { id: 'outer', type: 'zone', x: 0, y: 0, w: 500, h: 500, revealed: false };
  const inner = { id: 'inner', type: 'zone', x: 10, y: 10, w: 300, h: 300, parentZoneId: 'outer' };
  const sticky = { id: 'sticky', type: 'sticky', x: 20, y: 20, w: 100, h: 100,
    parentZoneId: 'inner', private: true, authorId: 'author' };
  const items = [outer, inner, sticky];
  assert.equal(isStickyHiddenForUser(sticky, items, true, 'viewer'), true);
  assert.equal(isStickyHiddenForUser(sticky, items, false, 'author'), false);
  assert.equal(isStickyHiddenForUser(sticky, [outer, { ...inner, revealed: true }, sticky], false, 'viewer'), false);
  assert.equal(isStickyHiddenForUser({ ...sticky, private: false }, items, false, 'viewer'), false);
});
