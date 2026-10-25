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

test('cloning hidden content carries concealment even before a sticky override existed', async () => {
  const { stickyCloneRevealOverride } = await import('./board-visibility.js');
  const sticky = { id: 'private', type: 'sticky', x: 0, y: 0, private: true };
  assert.deepEqual(stickyCloneRevealOverride(sticky, [sticky], false), { revealed: false });
  assert.deepEqual(stickyCloneRevealOverride(sticky, [sticky], true), {});
  assert.deepEqual(stickyCloneRevealOverride({ ...sticky, revealed: false }, [sticky], true), { revealed: false });
  assert.deepEqual(stickyCloneRevealOverride({ ...sticky, private: false }, [sticky], false), {});
});
