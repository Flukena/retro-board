import { actionItemsOf } from './action-item.js';
import { effectiveOwnerZone } from './board-ownership.js';
import { isStickyHiddenForUser } from './board-visibility.js';
import { RESULT_TOP_SIZE, compareStableText, compareVoteRank } from './vote-ranking.js';

// Card text always follows a list or heading marker, so only inline syntax needs escaping.
const MARKDOWN_SPECIAL_RE = /[\\`*_[\]<>|~]/g;
const WHITESPACE_RE = /\s+/g;
const UNASSIGNED_ZONE_KEY = '';

/** Card text as one Markdown-safe line: whitespace collapsed, syntax escaped. */
export const markdownInline = (value) => String(value ?? '')
  .replace(WHITESPACE_RE, ' ')
  .trim()
  .replace(MARKDOWN_SPECIAL_RE, '\\$&');

const voteCount = (votesByItem, id) => votesByItem.get(id)?.size ?? 0;

const rankStickies = (stickies, votesByItem) => [...stickies].sort((a, b) => compareVoteRank(
  voteCount(votesByItem, a.id), voteCount(votesByItem, b.id), a.id, b.id,
));

function groupByZone(stickies, items) {
  const groups = new Map();
  for (const sticky of stickies) {
    const key = effectiveOwnerZone(sticky, items)?.id ?? UNASSIGNED_ZONE_KEY;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sticky);
  }
  const zoneOrder = items.filter(item => item.type === 'zone' && groups.has(item.id));
  const ordered = zoneOrder.map(zone => ({ zone, stickies: groups.get(zone.id) }));
  if (groups.has(UNASSIGNED_ZONE_KEY)) ordered.push({ zone: null, stickies: groups.get(UNASSIGNED_ZONE_KEY) });
  return ordered;
}

function participantNames(participants, stickies) {
  const names = new Set();
  for (const participant of participants) if (participant.name?.trim()) names.add(participant.name.trim());
  for (const sticky of stickies) if (sticky.authorName?.trim()) names.add(sticky.authorName.trim());
  return [...names].sort(compareStableText);
}

const cardLine = (sticky, votesByItem, labels) => {
  const votes = voteCount(votesByItem, sticky.id);
  const text = markdownInline(sticky.text) || labels.emptyCard;
  return votes > 0 ? `${text} (${labels.votes(votes)})` : text;
};

function topSection(stickies, votesByItem, labels) {
  const voted = rankStickies(stickies, votesByItem).filter(sticky => voteCount(votesByItem, sticky.id) > 0)
    .slice(0, RESULT_TOP_SIZE);
  if (!voted.length) return [];
  return ['', `## ${labels.topVoted}`, ...voted.map((sticky, index) => `${index + 1}. ${cardLine(sticky, votesByItem, labels)}`)];
}

function zoneSections(stickies, items, votesByItem, labels) {
  const lines = ['', `## ${labels.cards}`];
  for (const { zone, stickies: zoneStickies } of groupByZone(stickies, items)) {
    const heading = zone ? markdownInline(zone.title) || labels.untitledZone : labels.unassigned;
    lines.push('', `### ${heading}`);
    for (const sticky of rankStickies(zoneStickies, votesByItem)) lines.push(`- ${cardLine(sticky, votesByItem, labels)}`);
  }
  return lines;
}

function actionLine(row, labels) {
  const text = row.hidden ? labels.hiddenCard : markdownInline(row.text) || labels.emptyCard;
  const details = [row.owner && markdownInline(row.owner), row.due].filter(Boolean).join(' · ');
  return `- [${row.done ? 'x' : ' '}] ${text}${details ? ` — ${details}` : ''}`;
}

function actionSection(items, viewer, labels) {
  const rows = actionItemsOf(items, viewer);
  return ['', `## ${labels.actionItems}`, ...(rows.length ? rows.map(row => actionLine(row, labels)) : [labels.noActionItems])];
}

/**
 * Markdown summary of a retro for pasting into chat or docs. Cards hidden from
 * this viewer are left out of the card lists and only counted.
 */
export function buildRetroSummary({ title, dateText, items, votesByItem, userId, allRevealed, participants = [], labels }) {
  const viewer = { userId, allRevealed };
  const stickies = items.filter(item => item.type === 'sticky');
  const visible = stickies.filter(sticky => !isStickyHiddenForUser(sticky, items, allRevealed, userId));
  const hiddenCount = stickies.length - visible.length;
  const names = participantNames(participants, visible);
  const lines = [
    `# ${markdownInline(title) || labels.untitledBoard}`,
    '',
    `**${labels.date}:** ${dateText}`,
    ...(names.length ? [`**${labels.participants}:** ${names.map(markdownInline).join(', ')}`] : []),
    ...topSection(visible, votesByItem, labels),
    ...(visible.length ? zoneSections(visible, items, votesByItem, labels) : []),
    ...(hiddenCount ? ['', `_${labels.hiddenCount(hiddenCount)}_`] : []),
    ...actionSection(items, viewer, labels),
  ];
  return `${lines.join('\n')}\n`;
}
