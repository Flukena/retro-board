import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Lock, ThumbsUp, MessageSquare } from 'lucide-react';
import { BOARD_TEXT_MAX_LENGTH, stickyTextForDom } from './security-boundaries.js';
import { PALETTE, STICKY_AUTO_TEXT } from './palette.js';
import { stickyClassName, stickyCardVars, medalLook, COMMENT_CAROUSEL_MS } from './card-look.js';
import { DEFAULT_STICKY_WIDTH_PX as STICKY_W, DEFAULT_STICKY_HEIGHT_PX as STICKY_H } from './board-geometry.js';
import { useBrowserLayoutEffect } from './use-browser-layout-effect.js';
import { t } from './i18n.js';

// Let notes grow while typing, but keep a pasted essay from turning into a
// many-thousand-pixel card. At the cap the editor becomes internally scrollable.
const STICKY_AUTO_GROW_MAX_H = 900;

const autoGrownStickyHeight = (height, overflow) => {
  if (!Number.isFinite(overflow) || overflow <= 1) return height;
  return Math.min(STICKY_AUTO_GROW_MAX_H, Math.ceil(height + overflow));
};

const useContentOverflow = (value, enabled = true, layoutKey = '', onOverflow = null) => {
  const elementRef = useRef(null);
  const [overflows, setOverflows] = useState(false);

  useBrowserLayoutEffect(() => {
    const node = elementRef.current;
    if (!node || !enabled) {
      setOverflows(false);
      return undefined;
    }
    const measure = () => {
      const overflow = node.scrollHeight - node.clientHeight;
      setOverflows(overflow > 1);
      if (overflow > 1) onOverflow?.(overflow);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, layoutKey, onOverflow, value]);

  return [elementRef, overflows];
};

export const StickyCard = React.memo(function StickyCard({
  item, selected, remoteSelected, remoteSelectionHue, isEditing, isOwner, allRevealed, dense, compact,
  voted, voteCount, voteFlash, voteRank, votingAllowedNow, showVoteCount, inZone,
  commentCount, commentPreviews,
  // `lang` is unused inside the body, but its presence as a prop
  // forces a re-render when language changes so t() picks up new strings.
  lang,
  onStartDrag, onBeginFocus, onTextChange, onTextKeyDown, onTextBlur, onToggleVote,
  onOpenComments,
  editAreaRef, TextEditor,
}) {
  void lang;
  const it = item;
  const c = PALETTE[it.color] || PALETTE[0];
  const hideContent = it.private && !allRevealed && !isOwner;
  const visibleText = stickyTextForDom(it, hideContent);
  const w = it.w || STICKY_W;
  const h = it.h || STICKY_H;
  const rot = selected ? 0 : it.rotation;
  const top3 = voteRank != null;
  const [hovered, setHovered] = useState(false);
  const [commentPreviewIndex, setCommentPreviewIndex] = useState(0);
  const commentPreview = commentPreviews[commentPreviewIndex] ?? commentPreviews[0] ?? '';
  const showCommentPreview = !hideContent && !!commentPreview;
  const showCommentEntry = !hideContent && (commentCount > 0 || hovered);
  const overview = compact && w <= 400 && h <= 400
    && !selected && !remoteSelected && !isEditing && !hovered && !top3;
  const growToFit = useCallback((overflow, patch = null) => {
    const nextHeight = autoGrownStickyHeight(h, overflow);
    if (patch) {
      onTextChange(it.id, nextHeight > h ? { ...patch, h: nextHeight } : patch);
    } else if (nextHeight > h) {
      onTextChange(it.id, { h: nextHeight }, { silent: true });
    }
  }, [h, it.id, onTextChange]);
  const [contentRef, contentOverflows] = useContentOverflow(
    visibleText,
    !hideContent && !isEditing && !overview,
    `${it.fontSize || 15}:${h}:${showCommentPreview ? 1 : 0}:${top3 ? 1 : 0}`,
    growToFit,
  );
  useEffect(() => {
    setCommentPreviewIndex(0);
    if (hideContent || overview || commentPreviews.length < 2) return undefined;
    const timer = setInterval(() => {
      setCommentPreviewIndex((index) => (index + 1) % commentPreviews.length);
    }, COMMENT_CAROUSEL_MS);
    return () => clearInterval(timer);
  }, [commentPreviews, hideContent, overview]);
  if (overview) {
    return (
      <div
        className="rb-card-overview rb-card-overview--shadow-flat"
        onMouseDown={e => onStartDrag(e, it)}
        onDoubleClick={e => { e.stopPropagation(); if (!hideContent) onBeginFocus(it, 'text'); }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          left: it.x,
          top: it.y,
          width: w,
          height: h,
          ...stickyCardVars(c),
          transform: `rotate(${it.rotation || 0}deg)`,
          color: it.fontColor || STICKY_AUTO_TEXT,
          fontSize: it.fontSize || 15,
        }}
      >
        <div
          className="rb-card-overview__text"
          style={{ maxHeight: h - 48 }}
        >
          {hideContent ? t('sticky.hidden') : visibleText?.slice(0, 200)}
        </div>
        {showVoteCount && !hideContent && (voteCount > 0 || votingAllowedNow) && (
          <button
            type="button"
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onToggleVote(it); }}
            disabled={!votingAllowedNow && !voted}
            aria-label={voted ? t('vote.tooltip.unvote') : t('vote.tooltip.vote')}
            className={voted
              ? 'rb-card-overview__vote rb-card-overview__vote--voted'
              : 'rb-card-overview__vote'}
          >{voteCount}</button>
        )}
      </div>
    );
  }
  return (
    <div
      className={stickyClassName({ selected, remoteSelected, winner: top3, dense })}
      onMouseDown={(e) => { if (!isEditing) onStartDrag(e, it); }}
      onDoubleClick={(e) => { e.stopPropagation(); if (!hideContent) onBeginFocus(it, 'text'); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        left: it.x,
        top: it.y,
        width: w,
        height: h,
        ...stickyCardVars(c),
        transform: `rotate(${rot}deg)`,
        ['--rb-rot']: `${rot}deg`,
        ['--rb-selector-hue']: remoteSelectionHue,
        animation: remoteSelected
          ? undefined
          : top3
            ? (dense
              ? 'rb-glow 1.6s ease-in-out infinite'
              : 'rb-glow 1.6s ease-in-out infinite, rb-appear-rot 0.28s ease-out')
            : (dense ? undefined : 'rb-appear-rot 0.28s ease-out'),
        fontSize: it.fontSize || 15,
        // The rank badge protrudes 13px; remote auras also need unclipped paint.
        contain: top3 || remoteSelected ? 'layout style' : 'layout paint style',
      }}
    >
      <div className="rb-sticky__badges">
        {it.private && !allRevealed && isOwner && (
          <Lock size={14} className="rb-sticky__lock" />
        )}
        {showCommentEntry && (
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); if (!hideContent) onOpenComments(it); }}
            disabled={hideContent}
            title={t('comments.tooltip')}
            aria-label={t('comments.tooltip')}
            className="rb-sticky__comment-chip"
            style={{
              width: showCommentPreview ? '72%' : 'auto',
              maxWidth: showCommentPreview ? '72%' : (commentCount > 0 ? 54 : 40),
              padding: showCommentPreview ? '3px 6px' : '3px 7px',
              cursor: hideContent ? 'not-allowed' : 'pointer',
              opacity: hideContent ? 0.45 : (commentCount > 0 ? 0.92 : 0.65),
            }}
          >
            <MessageSquare size={12} className="rb-sticky__comment-icon" />
            {showCommentPreview && (
              <span className="rb-sticky__comment-preview">
                <span
                  key={`${commentPreviewIndex}:${commentPreview}`}
                  className={commentPreviews.length > 1
                    ? 'rb-sticky__comment-slide rb-sticky__comment-preview-slide'
                    : 'rb-sticky__comment-preview-slide'}
                >
                  {commentPreview}
                </span>
              </span>
            )}
            {commentCount > 0 && (
              <span className="rb-sticky__comment-count">
                {commentCount}
              </span>
            )}
          </button>
        )}
      </div>

      {top3 && (
        <div
          title={t('vote.rank', { n: voteRank })}
          role="img"
          aria-label={t('vote.rank', { n: voteRank })}
          className="rb-winner-medal"
          style={medalLook(voteRank)}
        >
          {voteRank}
        </div>
      )}

      <div
        ref={contentRef}
        className="rb-sticky__content"
        style={{
          userSelect: hideContent ? 'none' : 'auto',
          color: it.fontColor || STICKY_AUTO_TEXT,
          paddingTop: showCommentPreview ? 24 : (top3 ? 16 : 0),
        }}
      >
        {(() => {
          if (hideContent) return null;
          if (isEditing) {
            return (
              <TextEditor
                editorRef={editAreaRef}
                value={it.text || ''}
                maxLength={BOARD_TEXT_MAX_LENGTH}
                onValueChange={(value, metrics) => growToFit(
                  metrics.scrollHeight - metrics.clientHeight,
                  { text: value },
                )}
                onContentOverflow={growToFit}
                onKeyDown={(e) => onTextKeyDown(e)}
                onBlur={() => onTextBlur(it.id)}
                onMouseDown={(e) => e.stopPropagation()}
                placeholder={t('sticky.placeholder')}
                className="rb-sticky__editor"
                style={{
                  fontSize: it.fontSize || 15,
                  color: it.fontColor || STICKY_AUTO_TEXT,
                }}
              />
            );
          }
          if (visibleText) return visibleText;
          return isOwner
            ? (
              <span className="rb-sticky__placeholder">
                {t('sticky.placeholder')}
              </span>
            )
            : '';
        })()}
        {contentOverflows && (
          <span
            aria-hidden="true"
            className="rb-sticky__overflow"
            style={{
              color: it.fontColor || STICKY_AUTO_TEXT,
            }}
          >…</span>
        )}
      </div>

      {hideContent && (
        <div className="rb-sticky__hidden">
          <Lock size={20} />
          <span className="rb-sticky__hidden-title">{t('sticky.hidden')}</span>
          <span className="rb-sticky__hidden-author">{t('sticky.hiddenBy', { name: it.authorName })}</span>
        </div>
      )}

      <div className="rb-sticky__footer">
        <span className="rb-sticky__author">
          {it.authorName || 'Anon'}
        </span>
        <div className="rb-sticky__vote-wrap">
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); if (!hideContent) onToggleVote(it); }}
            disabled={hideContent || (!votingAllowedNow && !voted)}
            className={voted
              ? 'rb-sticky__vote-pill rb-sticky__vote-pill--voted'
              : 'rb-sticky__vote-pill'}
            style={{
              gap: votingAllowedNow ? 10 : 4,
              padding: votingAllowedNow ? '8px 25px' : '3px 10px',
              fontSize: votingAllowedNow ? 30 : 12,
              cursor: (hideContent || !votingAllowedNow) ? 'not-allowed' : 'pointer',
              opacity: hideContent ? 0.4 : (votingAllowedNow ? 1 : 0.6),
            }}
            title={
              hideContent ? t('sticky.hideContent')
              : !inZone ? t('vote.noZone')
              : !votingAllowedNow ? t('vote.notStartedYet')
              : voted ? t('vote.tooltip.unvote') : t('vote.tooltip.vote')
            }
          >
            <ThumbsUp size={votingAllowedNow ? 30 : 12} />
            {showVoteCount && (
              <span
                key={voteCount}
                className="rb-sticky__vote-count"
              >
                {voteCount}
              </span>
            )}
          </button>
          {voteFlash && (
            <span
              key={voteFlash}
              className="rb-sticky__vote-float"
            >+1
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

