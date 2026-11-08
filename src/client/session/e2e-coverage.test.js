import test from 'node:test';
import assert from 'node:assert/strict';
import { SeqCoverage } from './e2e-coverage.js';

test('appliedSeq advances only over contiguous seqs from updates and own ACKs', () => {
  const coverage = new SeqCoverage();
  coverage.cover(2);
  assert.equal(coverage.appliedSeq, 0, 'a gap at seq 1 holds it back');
  assert.equal(coverage.head, 2);
  coverage.cover(1);
  assert.equal(coverage.appliedSeq, 2);
  assert.equal(coverage.caughtUp, true);
  coverage.noteHead(4);
  assert.equal(coverage.caughtUp, false);
});

test('a skipped seq is remembered but does not stall later seqs', () => {
  const coverage = new SeqCoverage();
  coverage.cover(1);
  coverage.skip(2);
  coverage.cover(3);
  coverage.skip(4);
  assert.equal(coverage.appliedSeq, 4);
  assert.equal(coverage.skippedSeq, 2, 'the first skip is kept');
});

test('a snapshot covers through its baseSeq; restart rebuilds from the next replay', () => {
  const coverage = new SeqCoverage();
  coverage.cover(7);
  coverage.coverThrough(5);
  assert.equal(coverage.appliedSeq, 5);
  coverage.cover(6);
  assert.equal(coverage.appliedSeq, 7);
  coverage.coverThrough(3);
  assert.equal(coverage.appliedSeq, 7, 'an older snapshot never moves it back');
  coverage.restart();
  assert.equal(coverage.appliedSeq, 0);
  assert.equal(coverage.head, 0);
});
