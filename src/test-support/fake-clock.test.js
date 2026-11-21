import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClock } from './fake-clock.js';

test('fake clock runs due timers in deadline/insertion order, including nested work', () => {
  const clock = createFakeClock(100);
  const events = [];
  clock.setTimeout(() => { events.push(clock.now()); clock.setTimeout(() => events.push(clock.now()), 2); }, 4);
  clock.setTimeout(() => events.push('same deadline'), 4);
  clock.setTimeout(() => events.push('later'), 10);
  clock.advance(3);
  assert.deepEqual(events, []);
  clock.advance(3);
  assert.deepEqual(events, [104, 'same deadline', 106]);
  assert.equal(clock.now(), 106);
  assert.equal(clock.pendingCount(), 1);
});

test('fake clock cancels timers and rejects backward/nonfinite advances', () => {
  const clock = createFakeClock();
  const id = clock.setTimeout(() => assert.fail('cancelled timer ran'), 1);
  clock.clearTimeout(id);
  clock.advance(1);
  assert.equal(clock.pendingCount(), 0);
  for (const invalid of [-1, Infinity, NaN]) assert.throws(() => clock.advance(invalid), RangeError);
});
