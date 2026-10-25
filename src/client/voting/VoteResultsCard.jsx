import React from 'react';
import { X, Trophy, CircleCheck } from 'lucide-react';
import { CHROME_ICON_SIZE_PX } from '../chrome/chrome-layout.js';
import { Avatar } from '../ui/Avatar.jsx';
import { medalLook, zoneCardVars } from '../board/card-look.js';
import { PALETTE } from '../ui/palette.js';
import { isStickyHiddenForUser } from '../../domain/board-visibility.js';
import { formatRelativeTime } from '../ui/relative-time.js';
import { t } from '../ui/i18n.js';
import './vote-results-card.css';
import '../ui/chrome-animations.css';

function ResultHeader({ zone, now, onDismiss }) {
  const palette = PALETTE[zone.color] || PALETTE[0];
  return <header className="rb-results__header">
    <span className="rb-results__trophy" style={zoneCardVars(palette)} aria-hidden="true"><Trophy size={CHROME_ICON_SIZE_PX.TOOL} /></span>
    <div className="rb-results__heading">
      <div className="rb-results__eyebrow">{t('vote.result.eyebrow')}<span aria-hidden="true">{t('vote.result.timeSeparator')}</span>
        <time dateTime={new Date(zone.voteResults.finalizedAt).toISOString()}>{formatRelativeTime(zone.voteResults.finalizedAt, now)}</time>
      </div>
      <h3 className="rb-results__title" title={zone.title}>{zone.title}</h3>
    </div>
    <button type="button" className="rb-btn rb-btn--icon-sm rb-results__close" onClick={onDismiss} aria-label={t('common.close')}><X size={CHROME_ICON_SIZE_PX.SMALL} /></button>
  </header>;
}

function ResultStats({ result }) {
  const unlimited = result.voteLimit == null;
  return <div className="rb-results__stats">
    <div className="rb-results__stat" aria-label={t('vote.result.total', { n: result.totalVotes })}>
      <strong>{result.totalVotes}</strong><span>{t('vote.result.totalLabel')}</span>
    </div>
    <div className="rb-results__stat" aria-label={t('vote.result.voters', { n: result.voterCount, present: result.presentCount })}>
      <strong>{t('vote.result.quota', { votes: result.voterCount, limit: result.presentCount })}</strong><span>{t('vote.result.voted')}</span>
    </div>
    <div className="rb-results__stat" aria-label={unlimited ? t('vote.session.unlimited') : t('vote.result.limit', { n: result.voteLimit })}>
      <strong>{unlimited ? t('vote.result.infinity') : result.voteLimit}</strong><span>{t(unlimited ? 'vote.result.noLimit' : 'vote.result.perPerson')}</span>
    </div>
  </div>;
}

function RankedResult({ row, rank, topVotes, board, userId }) {
  const item = board.items.find((candidate) => candidate.id === row.itemId);
  const hidden = !item || isStickyHiddenForUser(item, board.items, board.allRevealed, userId);
  return <li className="rb-results__rank" style={medalLook(rank)}>
    <span className="rb-results__medal" aria-hidden="true">{rank}</span>
    <div className="rb-results__rank-body">
      <span className="rb-results__card-title">{hidden ? t('vote.result.unavailable') : item.text || t('vote.result.untitled')}</span>
      <div className="rb-results__track" aria-hidden="true"><span style={{ '--rb-result-share': topVotes > 0 ? row.votes / topVotes : 0 }} /></div>
    </div>
    <strong className="rb-results__votes" aria-label={t('vote.result.total', { n: row.votes })}>{row.votes}</strong>
  </li>;
}

function IncompleteVoters({ result }) {
  const hasLimit = result.voteLimit != null;
  const incomplete = result.participants.filter((person) => hasLimit ? person.votes < result.voteLimit : person.votes === 0);
  if (!incomplete.length && !result.omittedCount) return <section className="rb-results__complete">
    <CircleCheck size={CHROME_ICON_SIZE_PX.TOOL} aria-hidden="true" /><span>{t('vote.result.complete')}</span>
  </section>;
  return <section className="rb-results__participants">
    <div className="rb-results__participant-heading"><h4>{t(hasLimit ? 'vote.result.incomplete' : 'vote.result.notVoted')}</h4><span className="rb-results__badge">{incomplete.length}</span></div>
    <p className="rb-results__caption">{t('vote.result.presence')}</p>
    {incomplete.map((person) => <div className="rb-results__person" key={person.userId}>
      <Avatar id={person.userId} name={person.name} small />
      <span className="rb-results__name" title={person.name}>{person.name}</span>
      {hasLimit && <span className="rb-results__quota">{t('vote.result.quota', { votes: person.votes, limit: result.voteLimit })}</span>}
    </div>)}
    {result.omittedCount > 0 && <p className="rb-results__more">{t('vote.result.more', { n: result.omittedCount })}</p>}
  </section>;
}

export function VoteResultsCard({ zone, board, userId, now, onDismiss }) {
  const result = zone.voteResults;
  return <section className="rb-results" role="region" aria-label={t('vote.result.title', { title: zone.title })}>
    <ResultHeader zone={zone} now={now} onDismiss={onDismiss} />
    <ResultStats result={result} />
    {result.top.length ? <ol className="rb-results__top">{result.top.map((row, index) => <RankedResult key={row.itemId} row={row} rank={index + 1} topVotes={result.top[0].votes} board={board} userId={userId} />)}</ol>
      : <p className="rb-results__empty">{t('vote.result.empty')}</p>}
    {result.showNonVoters && <IncompleteVoters result={result} />}
  </section>;
}

export function VoteResultsCards({ zones, board, userId, now, onDismiss }) {
  if (!zones.length) return null;
  return <div className="rb-results-stack">{zones.map((zone) => <VoteResultsCard key={zone.voteResults.resultId} zone={zone} board={board} userId={userId} now={now}
    onDismiss={() => onDismiss(zone.voteResults.resultId)} />)}</div>;
}
