import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRetroSummary, markdownInline } from './retro-summary.js';

const LABELS = Object.freeze({
  untitledBoard: 'Retro', date: 'Date', participants: 'Participants', topVoted: 'Top voted',
  cards: 'Cards', untitledZone: 'Untitled zone', unassigned: 'No zone', actionItems: 'Action items',
  noActionItems: 'No action items', hiddenCard: 'Hidden card', emptyCard: '(empty)',
  votes: n => `${n} votes`, hiddenCount: n => `${n} hidden cards not shown`,
});

const zone = (id, title, x) => ({ id, type: 'zone', title, x, y: 0, w: 400, h: 400 });
const sticky = (id, text, x, fields = {}) => ({
  id, type: 'sticky', text, x, y: 100, w: 200, h: 180, authorId: `author-${id}`, authorName: `Author ${id}`, ...fields,
});
const votes = entries => new Map(entries.map(([id, count]) => [id, new Set(Array.from({ length: count }, (_, i) => `u${i}`))]));

const summarize = (items, votesByItem = new Map(), extra = {}) => buildRetroSummary({
  title: 'Sprint 42', dateText: '4 Nov 2026', items, votesByItem, userId: 'viewer', allRevealed: false,
  labels: LABELS, ...extra,
});

const section = (markdown, heading) => {
  const start = markdown.indexOf(`## ${heading}`);
  if (start < 0) return '';
  const next = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, next < 0 ? undefined : next);
};

test('top voted lists at most three voted cards, most votes first, ties broken by id', () => {
  const items = [sticky('b', 'Bee', 0), sticky('a', 'Ay', 0), sticky('c', 'Sea', 0), sticky('d', 'Dee', 0), sticky('e', 'None', 0)];
  const top = section(summarize(items, votes([['d', 1], ['b', 3], ['a', 3], ['c', 2]])), 'Top voted');
  assert.deepEqual(top.trim().split('\n').slice(1), ['1. Ay (3 votes)', '2. Bee (3 votes)', '3. Sea (2 votes)']);
});

test('without any votes there is no top voted section', () => {
  assert.equal(section(summarize([sticky('a', 'Ay', 0)]), 'Top voted'), '');
});

test('cards are grouped under the zone that contains them, unzoned cards last', () => {
  const items = [zone('z1', 'Went well', 0), zone('z2', 'To improve', 1000), sticky('a', 'Tests', 1100), sticky('b', 'Pairing', 50), sticky('c', 'Loose', 5000)];
  const cards = section(summarize(items), 'Cards');
  const order = ['### Went well', '- Pairing', '### To improve', '- Tests', '### No zone', '- Loose'].map(line => cards.indexOf(line));
  assert.ok(order.every(index => index >= 0), cards);
  assert.deepEqual([...order].sort((x, y) => x - y), order);
});

test('markdown syntax in card text is escaped and newlines collapse to one line', () => {
  assert.equal(markdownInline('**bold** [link](x)\n_next_'), '\\*\\*bold\\*\\* \\[link\\](x) \\_next\\_');
  const markdown = summarize([sticky('a', '# not a heading\n<b>', 0)]);
  assert.match(markdown, /^- # not a heading \\<b\\>$/m);
});

test('private cards hidden from the viewer are left out and only counted', () => {
  const items = [sticky('a', 'Public idea', 0), sticky('s', 'Secret salary', 0, { private: true })];
  const markdown = summarize(items, votes([['s', 5]]));
  assert.doesNotMatch(markdown, /Secret salary/);
  assert.doesNotMatch(markdown, /Author s/);
  assert.match(markdown, /_1 hidden cards not shown_/);
});

test('action items become a checklist with owner and due date', () => {
  const items = [
    sticky('a', 'Fix flaky CI', 0, { actionItem: true, actionOwner: 'Nok', actionDue: '2026-11-30' }),
    sticky('b', 'Write runbook', 0, { actionItem: true, actionDone: true }),
  ];
  const actions = section(summarize(items), 'Action items');
  assert.deepEqual(actions.trim().split('\n').slice(1), ['- [ ] Fix flaky CI — Nok · 2026-11-30', '- [x] Write runbook']);
  assert.match(section(summarize([sticky('c', 'x', 0)]), 'Action items'), /No action items/);
});

test('participants merge online names and card authors without duplicates', () => {
  const markdown = summarize([sticky('a', 'x', 0, { authorName: 'Ada' })], new Map(), { participants: [{ name: 'Ada' }, { name: 'Bo' }] });
  assert.match(markdown, /^\*\*Participants:\*\* Ada, Bo$/m);
  assert.match(markdown, /^# Sprint 42$/m);
});
