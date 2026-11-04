import React from 'react';
import { SmilePlus, X } from 'lucide-react';
import { MOOD_SCALE } from '../../domain/mood-check.js';
import { ModalShell } from '../ui/ModalShell.jsx';
import { Button } from '../ui/UiPrimitives.jsx';
import { MODAL_SIZE } from '../ui/ui-variants.js';
import { CHROME_ICON_SIZE_PX, FOLLOW_BANNER_H_PX } from '../chrome/chrome-layout.js';
import { t } from '../ui/i18n.js';
import '../voting/vote-results-card.css';
import './mood-check.css';

const TITLE_ICON_SIZE_PX = 22;
const moodLabel = (score) => t(`mood.score.${score}`);

/** Asks this person for one score; Skip hides it until they choose Answer in the banner. */
export function MoodCheckDialog({ onAnswer, onSkip }) {
  return (
    <ModalShell size={MODAL_SIZE.SM} labelledBy="mood-check-title" onDismiss={onSkip}>
      <div className="rb-dialog__header">
        <div className="rb-dialog__heading">
          <SmilePlus size={TITLE_ICON_SIZE_PX} color="var(--accent)" />
          <div id="mood-check-title" className="rb-dialog__title">{t('mood.question')}</div>
        </div>
      </div>
      <p className="rb-mood-note">{t('mood.anonymous')}</p>
      <div className="rb-mood-scale" role="group" aria-label={t('mood.question')} style={{ '--rb-mood-count': MOOD_SCALE.length }}>
        {MOOD_SCALE.map(({ score, emoji }) => (
          <button key={score} type="button" className="rb-mood-choice" title={moodLabel(score)} onClick={() => onAnswer(score)}>
            <span className="rb-mood-emoji" aria-hidden="true">{emoji}</span>
            <span className="rb-mood-choice__label">{moodLabel(score)}</span>
          </button>
        ))}
      </div>
      <div className="rb-mood-actions">
        <Button onClick={onSkip}>{t('mood.skip')}</Button>
      </div>
    </ModalShell>
  );
}

/** While a round is open: how many answered; Answer for someone who skipped; Close for the admin. */
export function MoodBanner({ banner, onReopen, onClose }) {
  return (
    <div role="status" className="rb-follow-banner" style={{ '--rb-follow-banner-height': `${FOLLOW_BANNER_H_PX}px` }}>
      <SmilePlus size={CHROME_ICON_SIZE_PX.TOOL} color="var(--accent)" />
      <span className="rb-follow-name">{t('mood.answered', { n: banner.count })}</span>
      {!banner.answered && <Button className="rb-btn--pill" onClick={onReopen}>{t('mood.answer')}</Button>}
      {banner.canClose && <Button className="rb-btn--pill" onClick={onClose}>{t('mood.close')}</Button>}
    </div>
  );
}

/** Anonymous histogram of a closed round. */
export function MoodResultCard({ summary, onDismiss }) {
  const largest = Math.max(1, ...summary.histogram);
  return (
    <section className="rb-results" role="region" aria-label={t('mood.result')}>
      <header className="rb-results__header">
        <div className="rb-results__heading">
          <div className="rb-results__eyebrow">{t('mood.answered', { n: summary.count })}</div>
          <h3 className="rb-results__title">{t('mood.result')}</h3>
        </div>
        <button type="button" className="rb-btn rb-btn--icon-sm rb-results__close" onClick={onDismiss} aria-label={t('common.close')}>
          <X size={CHROME_ICON_SIZE_PX.SMALL} />
        </button>
      </header>
      <ol className="rb-results__top rb-mood-histogram">
        {MOOD_SCALE.map(({ score, emoji }, index) => (
          <li key={score} className="rb-results__rank">
            <span className="rb-mood-emoji" title={moodLabel(score)} aria-hidden="true">{emoji}</span>
            <div className="rb-results__rank-body">
              <span className="rb-results__card-title">{moodLabel(score)}</span>
              <div className="rb-results__track" aria-hidden="true">
                <span style={{ '--rb-result-share': summary.histogram[index] / largest }} />
              </div>
            </div>
            <strong className="rb-results__votes">{summary.histogram[index]}</strong>
          </li>
        ))}
      </ol>
      <p className="rb-mood-average">{t('mood.average', { n: summary.average })}</p>
    </section>
  );
}
