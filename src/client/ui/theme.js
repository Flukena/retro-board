// Theme: applies CSS variables on <html data-theme="…"> so any inline style
// can reference `var(--bg)` etc. Tri-state preference: 'light' | 'dark' | 'auto'.
// 'auto' follows prefers-color-scheme and updates live.

import { useEffect, useState } from 'react';
import { GRID_PITCH_PX, MINIMAP_GRID_PITCH_PX, Z } from '../chrome/chrome-layout.js';
import {
  ZONE_AUTO_TITLE_MAX_FONT_PX, ZONE_COUNT_FONT_PX, ZONE_TITLE_LINE_HEIGHT_RATIO, ZONE_CHIP_PADDING_VERTICAL_PX,
  ZONE_CHIP_PADDING_HORIZONTAL_PX, ZONE_HEADER_INSET_PX, ZONE_HEADER_Z_INDEX, ZONE_HEADER_GAP_PX,
  ZONE_CHIP_MIN_WIDTH_PX, ZONE_ICON_BUTTON_SIZE_PX, ZONE_ICON_GLYPH_SIZE_PX, ZONE_ICON_GAP_PX,
} from '../../domain/zone-title.js';
import { ZONE_STRIP_SWATCH_SIZE_PX, ZONE_FONT_VALUE_WIDTH_PX, ZONE_POPUP_ICON_GLYPH_SIZE_PX, ZONE_HEADER_TOOLS_BASE_FONT_PX } from '../board/zone-header-layout.js';
import { ZONE_TOOLS_EXIT_DURATION_MS, ZONE_POPUP_MOTION_DURATION_MS } from './usePresence.js';
import { ZONE_BORDER_W_PX, ZONE_EDGE_HIT_WIDTH_PX } from '../board/card-look.js';

const STORAGE_KEY = 'rb_theme';

function tokenKeys(mode, label) {
  if (mode === null || typeof mode !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(mode))) {
    throw new Error(`${label} tokens must be a plain object`);
  }
  const keys = Reflect.ownKeys(mode);
  if (keys.some((key) => typeof key !== 'string' || !key.startsWith('--'))) {
    throw new Error(`${label} token keys must start with --`);
  }
  return keys;
}

export function defineTokens(light, dark) {
  const lightKeys = tokenKeys(light, 'Light');
  const darkKeys = tokenKeys(dark, 'Dark');
  const missing = lightKeys.filter((key) => !darkKeys.includes(key));
  const extra = darkKeys.filter((key) => !lightKeys.includes(key));
  if (missing.length || extra.length) {
    throw new Error(`Dark tokens missing keys: ${missing.join(', ')}; extra keys: ${extra.join(', ')}`);
  }
  return Object.freeze({ light: Object.freeze({ ...light }), dark: Object.freeze({ ...dark }) });
}

function zoneHeaderSizeToken(sizePx) {
  return `calc(var(--rb-zone-title-size) * ${sizePx / ZONE_HEADER_TOOLS_BASE_FONT_PX})`;
}

// Apply locally on each header so the title-size variable resolves in that zone.
export const ZONE_HEADER_SIZE_TOKENS = Object.freeze({
  '--rb-zone-tool-zoom': 'var(--rb-zone-canvas-zoom, 1)',
  '--rb-zone-tool-button-size': 'var(--zone-icon-button-size)',
  '--rb-zone-tool-glyph-size': 'var(--zone-icon-size)',
  '--zone-icon-button-size': zoneHeaderSizeToken(ZONE_ICON_BUTTON_SIZE_PX),
  '--zone-icon-size': zoneHeaderSizeToken(ZONE_ICON_GLYPH_SIZE_PX),
  '--zone-icon-gap': zoneHeaderSizeToken(ZONE_ICON_GAP_PX),
  '--zone-font-value-width': zoneHeaderSizeToken(ZONE_FONT_VALUE_WIDTH_PX),
  '--zone-strip-swatch-size': zoneHeaderSizeToken(ZONE_STRIP_SWATCH_SIZE_PX),
  '--zone-chip-gap': zoneHeaderSizeToken(ZONE_HEADER_GAP_PX),
  '--zone-chip-min-width': zoneHeaderSizeToken(ZONE_CHIP_MIN_WIDTH_PX),
});

const MODE_INDEPENDENT_TOKENS = Object.freeze({
  ...ZONE_HEADER_SIZE_TOKENS,
  '--tool-frame-bg': 'transparent',
  '--tool-frame-border': 'transparent',
  '--tool-frame-shadow': 'none',
  '--tool-section-bg': 'color-mix(in srgb, var(--bg-panel-2) 68%, transparent)',
  '--tool-section-border': 'color-mix(in srgb, var(--border) 80%, transparent)',
  '--space-1': '4px',
  '--space-2': '8px',
  '--space-3': '12px',
  '--space-4': '16px',
  '--space-5': '20px',
  '--space-6': '24px',
  '--space-8': '32px',
  '--modal-padding': '20px',
  '--modal-edge-gap': '12px',
  '--modal-close-inset': '8px',
  '--modal-touch-target': '44px',
  '--modal-input-font-size': '16px',
  '--font-handwriting': '"Caveat", "Sarabun", cursive',
  '--image-card-filter': 'drop-shadow(0 3px 6px rgba(0,0,0,0.18))',
  '--collaboration-foreground': '#ffffff',
  '--shadow-remote-selection-label': '0 3px 10px rgba(0,0,0,0.22)',
  '--shadow-remote-editor-label': '0 3px 10px rgba(0,0,0,0.24)',
  '--zone-preview-border': '#0ea5e9',
  '--cursor-filter': 'drop-shadow(0 1px 2px rgba(0,0,0,0.38))',
  '--radius-cursor-label': '4px 9px 9px 9px',
  '--shadow-cursor-label': '0 2px 7px rgba(0,0,0,0.2)',
  '--radius-text-card': '6px',
  '--radius-image-card': '0px',
  '--draw-toolbar-top': '84px',
  '--draw-toolbar-left': '120px',
  '--draw-toolbar-font-size': '12px',
  '--draw-control-height': '36px',
  '--draw-select-width': '112px',
  '--draw-border-width': '1.5px',
  '--radius-selection-outline': '4px',
  '--radius-marquee': '2px',
  '--minimap-text-fallback': '#64748b',
  '--minimap-image': '#a78bfa',
  '--font-swatch-white': '#ffffff',

  '--minimap-grid-pitch': `${MINIMAP_GRID_PITCH_PX}px`,
  '--radius-dock-tile': '14px',
  '--dock-label-gap': '4px',
  '--radius-minimap-viewport': '4px',
  '--grid-pitch': `${GRID_PITCH_PX}px`,
  '--landing-corner-layer': String(Z.TOPBAR),
  '--landing-page-padding': '0px',
  '--landing-max-width': 'none',
  '--landing-gap': '0px',
  '--landing-hero-gap': '16px',
  '--landing-hero-margin': '0 0 8px',
  '--landing-logo-size': '52px',
  '--landing-title-font-size': '34px',
  '--landing-title-font-weight': '500',
  '--landing-title-line-height': '1.2',
  '--landing-subtitle-margin': '4px 0 0',
  '--landing-body-font-size': '13px',
  '--landing-card-padding': '20px',
  '--landing-line-width': '1.5px',
  '--landing-heading-font-size': '15px',
  '--landing-heading-font-weight': '700',
  '--landing-heading-margin': '0 0 16px',
  '--landing-create-heading-margin': '0 0 4px',
  '--landing-description-margin': '0 0 16px',
  '--landing-form-gap': '8px',
  '--landing-input-basis': '240px',
  '--landing-control-height': '44px',
  '--landing-input-padding': '0 12px',
  '--landing-control-font-size': '14px',
  '--landing-action-padding': '0 16px',
  '--landing-error-margin': '12px 0 0',
  '--landing-recents-padding': '20px',
  '--landing-recents-heading-margin': '0 0 8px',
  '--landing-recent-gap': '12px',
  '--landing-recent-padding': '12px 0',
  '--landing-recent-detail-gap': '4px',
  '--landing-recent-font-weight': '600',
  '--landing-small-font-size': '12px',
  '--landing-remove-size': '32px',
  '--landing-footer-margin': '4px 0 0',
  '--landing-footer-line-height': '1.6',
  '--landing-hover-transition': 'background 0.1s',
  '--landing-hero-radius': '0px',
  '--landing-hero-padding': 'clamp(24px, 4vw, 56px)',
  '--landing-hero-title-size': 'clamp(36px, 4vw, 56px)',
  '--landing-hero-title-spacing': '-0.045em',
  '--landing-hero-title-line-height': '1.18',
  '--landing-hero-body-size': '17px',
  '--landing-hero-columns': 'minmax(0, 1fr) minmax(340px, 400px)',
  '--landing-hero-column-gap': 'clamp(32px, 5vw, 80px)',
  '--landing-hero-shadow': 'none',
  '--landing-hero-veil': 'linear-gradient(180deg, color-mix(in srgb, var(--bg) 10%, transparent), transparent 30%, transparent 70%, color-mix(in srgb, var(--bg) 12%, transparent))',
  '--landing-hero-accent': 'var(--accent-text)',
  '--landing-hero-eyebrow-size': '11px',
  '--landing-hero-eyebrow-spacing': '0.13em',
  '--landing-wordmark-size': '22px',
  '--landing-wordmark-mobile-size': '18px',
  '--landing-mobile-logo-size': '40px',
  '--landing-compact-wordmark-size': '16px',
  '--landing-compact-logo-size': '32px',
  '--landing-tagline-max-width': '380px',
  '--landing-compact-title-size': 'clamp(28px, 4vw, 42px)',
  '--landing-hero-top-clearance': '112px',
  '--landing-hero-mobile-top-clearance': '88px',
  '--landing-hero-mobile-title-size': '28px',
  '--landing-hero-intro-max-width': '520px',
  '--landing-hero-form-bg': 'var(--bg-panel)',
  '--landing-backdrop-blur': '4px',
  '--landing-backdrop-overscan': '12px',
  '--landing-public-cta-min-width': '220px',
  '--landing-public-cta-font-size': '16px',
  '--landing-public-cta-bg': 'var(--accent-strong)',
  '--landing-public-cta-fg': 'var(--btn-primary-fg)',
  '--landing-public-cta-hover': 'var(--accent)',
  '--landing-ambient-light': 'radial-gradient(ellipse at 8% 0%, var(--landing-light-source), transparent 64%), radial-gradient(ellipse at 100% 78%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 62%)',
  '--landing-edge-shade': 'radial-gradient(ellipse at 50% 42%, transparent 36%, var(--landing-vignette) 100%)',
  '--landing-panel-light': 'linear-gradient(135deg, color-mix(in srgb, var(--brand-tile-bg) 12%, transparent), transparent 48%)',
  '--landing-panel-shadow': 'inset 0 1px 0 var(--landing-panel-edge), 0 2px 6px -2px var(--landing-depth-ink), 0 28px 58px -22px var(--landing-depth-ink)',
  '--landing-panel-shadow-mobile': 'inset 0 1px 0 var(--landing-panel-edge), 0 2px 4px -2px var(--landing-depth-ink), 0 16px 32px -16px var(--landing-depth-ink)',
  '--landing-chrome-shadow': 'inset 0 1px 0 var(--landing-panel-edge), 0 10px 28px -16px var(--landing-depth-ink)',
  '--landing-bar-shadow': 'inset 0 1px 0 var(--landing-panel-edge), 0 -12px 32px -24px var(--landing-depth-ink)',
  '--landing-input-shadow': 'inset 0 2px 4px var(--border-soft), 0 1px 0 var(--landing-panel-edge)',
  '--landing-button-light': 'linear-gradient(180deg, color-mix(in srgb, var(--brand-tile-bg) 18%, transparent), transparent 72%)',
  '--landing-button-shadow': 'inset 0 1px 0 var(--landing-panel-edge), 0 3px 0 color-mix(in srgb, var(--btn-primary-bg) 70%, var(--sticky-ink)), 0 12px 26px -14px var(--landing-depth-ink)',
  '--landing-button-pressed-shadow': 'inset 0 2px 4px var(--landing-depth-ink)',


  '--sticky-ink': '#2b2118',
  '--sticky-vote-idle-bg': 'rgba(43,33,24,0.08)',
  '--sticky-vote-idle-text': '#374151',
  '--sticky-placeholder': '#9ca3af',
  '--zone-border-alpha': '0.5',
  '--selection': '#2563eb',
  '--radius-sticky': '3px',
  '--sticky-padding': '14px',
  '--sticky-line-height': '1.5',
  '--sticky-chip-height': '22px',
  '--comment-chip-padding': '0 7px',
  '--comment-chip-font-size': '11px',
  '--comment-chip-font-weight': '600',
  '--comment-chip-text': '#374151',
  '--comment-count-text': '#ffffff',
  '--sticky-vote-min-width': '32px',
  '--sticky-vote-padding': '0 9px',
  '--sticky-vote-gap': '4px',
  '--sticky-vote-font-size': '12px',
  '--sticky-vote-font-weight': '700',
  '--sticky-vote-icon-size': '12px',
  '--sticky-vote-open-height': '32px',
  '--sticky-vote-open-font-size': '16px',
  '--sticky-vote-open-icon-size': '16px',
  '--sticky-vote-open-min-width': '44px',
  '--sticky-vote-open-padding': '0 12px',
  '--sticky-vote-open-gap': '6px',
  '--sticky-vote-size-transition': '160ms ease-out',
  '--sticky-vote-open-ring': '0 0 0 1.5px var(--accent)',
  '--sticky-medal-size': '28px',
  '--sticky-medal-offset': '-13px',
  '--sticky-medal-font-size': '13px',
  '--sticky-medal-font-weight': '700',
  '--sticky-hidden-icon-size': '18px',
  '--sticky-hidden-title-size': '13px',
  '--sticky-hidden-title-weight': '600',
  '--sticky-hidden-author-size': '11px',
  '--sticky-hidden-author-weight': '500',
  '--sticky-hidden-text': '#4b5563',
  '--sticky-author-font-size': '11px',
  '--radius-zone': '24px',
  '--zone-header-inset': `${ZONE_HEADER_INSET_PX}px`,
  '--zone-edge-hit-width': `${ZONE_EDGE_HIT_WIDTH_PX}px`,
  '--zone-edge-hit-offset': `calc(-1 * (${ZONE_BORDER_W_PX}px + var(--zone-edge-hit-width) / 2))`,
  '--z-zone-header': String(ZONE_HEADER_Z_INDEX),
  '--zone-popup-icon-size': `${ZONE_POPUP_ICON_GLYPH_SIZE_PX}px`,
  '--zone-tools-motion-duration': `${ZONE_TOOLS_EXIT_DURATION_MS}ms`,
  '--zone-popup-motion-duration': `${ZONE_POPUP_MOTION_DURATION_MS}ms`,
  '--zone-tools-slide-distance': '8px',
  '--zone-tools-viewport-width': '100%',
  '--zone-popup-enter-scale': '0.92',
  '--zone-motion-easing': 'ease-out',
  '--zone-menu-turn': '90deg',
  '--zone-popup-layer': String(Z.POPOVER),
  '--zone-tool-target-min': '36px',
  '--zone-tool-glyph-min': '20px',
  '--zone-popup-width': '224px',
  '--zone-popup-padding': '8px',
  '--zone-popup-gap': '8px',
  '--zone-popup-offset': '6px',
  '--zone-popup-border-width': '1px',
  '--zone-popup-font-size': '13px',
  '--zone-popup-row-padding': '8px 12px',
  '--zone-tool-disabled-opacity': '0.4',
  '--radius-zone-icon': '10px',
  '--zone-icon-hover-bg': 'color-mix(in srgb, var(--text-muted) 12%, transparent)',
  '--zone-chip-padding': `${ZONE_CHIP_PADDING_VERTICAL_PX}px ${ZONE_CHIP_PADDING_HORIZONTAL_PX}px`,
  '--radius-zone-chip': '12px',
  '--zone-title-font-size': `${ZONE_AUTO_TITLE_MAX_FONT_PX}px`,
  '--zone-title-font-weight': '500',
  '--zone-title-line-height': String(ZONE_TITLE_LINE_HEIGHT_RATIO),
  '--zone-title-ink-clearance': '0.15em', // Thai stacked marks extend above the Mitr ascent.
  '--zone-count-font-size': `${ZONE_COUNT_FONT_PX}px`,
  '--zone-lock-size': '0.8125em',
  '--zone-title-shadow': '0 2px 0 rgba(0,0,0,0.08)',
  '--shadow-winner': '0 0 0 3px #fbbf24, 0 16px 22px -12px rgba(194,120,3,0.65)',
  '--shadow-winner-peak': '0 0 0 3px #fbbf24, 0 16px 22px -12px rgba(194,120,3,0.9)',
  '--shadow-medal': '0 0 0 2px #fffcf6, 0 4px 10px rgba(0,0,0,0.18)',
  '--comment-chip-bg': 'rgba(255,255,255,0.65)',
  '--comment-chip-shadow': '0 2px 6px rgba(0,0,0,0.08)',
  '--hidden-sticky-bg': 'rgba(255,255,255,0.35)',
  '--vote-float-shadow': '0 1px 2px rgba(0,0,0,0.2)',
  '--radius-xl': '22px',
  '--radius-icon-tile': '9px',
  '--radius-banner': '18px',
  '--tile-ink': '#2b2118',
  '--radius-bar': '20px',
  '--radius-lg': '16px',
  '--radius-tile': '11px',
  '--radius-round': '50%',
  '--radius-pill': '999px',
  '--brand-tile-bg': '#fed7aa',
  '--brand-tile-fg': '#7c2d12',
  '--avatar-fg': '#fff',
  '--avatar-crown-bg': '#facc15',
  '--avatar-ring-shadow': '0 0 0 2px var(--bg-panel), 0 0 0 3px var(--border-soft)',
  '--avatar-saturation': '65%',
  '--avatar-lightness': '55%',
  '--minimap-viewport-bg': 'rgba(14,165,233,0.13)',
  '--zone-preview-bg': 'rgba(14,165,233,0.10)',
  '--shadow-toast': '0 8px 24px rgba(0,0,0,0.25)',
  '--resilience-gap-px': '12px',
  '--resilience-padding-px': '12px',
  '--resilience-edge-space-px': '24px',
  '--resilience-font-size-px': '14px',
  '--resilience-recovery-max-width-px': '480px',
  '--radius-sm': '10px',
  '--radius-md': '12px',
  '--font-ui': '"Sarabun", system-ui, -apple-system, "Segoe UI", sans-serif',
  '--font-display': '"Mitr", "Sarabun", sans-serif',
  '--font-mono': '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
});
const LIGHT_RAISED_SHADOW = '0 2px 0 #e2d5bf, 0 12px 24px -14px rgba(110,80,40,0.35)';
const DARK_RAISED_SHADOW = '0 2px 0 #0f0d0a, 0 14px 28px -14px rgba(0,0,0,0.7)';

const VOTE_RESULT_TOKENS = Object.freeze({
    '--results-width-px': '400px',
    '--results-gutter-px': '32px',
    '--results-max-height-vh': '60vh',
    '--results-padding-px': '20px',
    '--results-gap-px': '8px',
    '--results-font-size-px': '13px',
    '--results-pill-padding-px': '4px 8px',
    '--results-medal-size-px': '32px',
    '--results-enter-duration-ms': '200ms',
    '--results-border-width-px': '1px',
    '--results-line-height': '1.5',
    '--results-header-gap-px': '12px',
    '--results-trophy-size-px': '42px',
    '--results-caption-size-px': '11px',
    '--results-heading-weight': '700',
    '--results-heading-size-px': '16px',
    '--results-stat-columns': '3',
    '--results-section-gap-px': '20px',
    '--results-stat-gap-px': '4px',
    '--results-stat-padding-px': '12px 8px',
    '--results-stat-size-px': '24px',
    '--results-stat-line-height': '1.2',
    '--results-rank-gap-px': '16px',
    '--results-title-line-count': '2',
    '--results-track-height-px': '4px',
    '--results-track-gap-px': '8px',
    '--results-vote-width-px': '24px',
    '--results-vote-size-px': '18px',
    '--results-panel-padding-px': '12px',
    '--results-caption-gap-px': '4px',
    '--results-empty-padding-px': '8px',
    '--results-warning-text': 'var(--warn-text)',
    '--results-warning-bg': 'var(--warn-bg)',
});

export const TOKENS = defineTokens({
    ...VOTE_RESULT_TOKENS,
    '--minimap-viewport-highlight': '0 0 0 1px rgba(255,255,255,0.5) inset',
    '--sticky-vote-bg': '#2b2118',
    '--sticky-vote-text': '#ffffff',
    '--zone-fill-alpha': '0.13',
    '--shadow-sticky': '0 1px 1px rgba(110,80,40,0.12), 0 16px 18px -14px rgba(110,80,40,0.55)',
    '--shadow-sticky-flat': '0 1px 0 rgba(110,80,40,0.22)',
    '--bg': '#ffffff',
    '--bg-panel': '#fffcf6',
    '--bg-panel-2': '#f6eee1',
    '--bg-elev': '#fffcf6',
    '--bg-overlay': 'rgba(255,252,246,0.92)',
    '--bg-modal-veil': 'rgba(43,33,24,0.2)',
    '--text': '#2b2118',
    '--text-mid': '#4d4033',
    '--text-muted': '#74634f',
    '--text-faint': '#a8987f',
    '--border': '#e6dccb',
    '--border-soft': 'rgba(110,80,40,0.10)',
    '--border-strong': 'rgba(110,80,40,0.18)',
    '--btn-primary-bg': '#2b2118',
    '--btn-primary-fg': '#fffcf6',
    '--btn-primary-border': '#2b2118',
    '--btn-primary-hover': '#4d4033',
    '--accent': '#c2410c',
    '--accent-strong': '#9a3412',
    '--accent-bg': '#ffedd5',
    '--accent-text': '#9a3412',
    '--danger': '#b91c1c',
    '--warn-border': '#f3d27a',
    '--shadow-press': '0 2px 0 #e6dccb',
    '--warn-bg': '#fff0c2',
    '--warn-text': '#7a4b00',
    '--results-success-bg': '#eaf3e8',
    '--results-success-text': '#2f5c38',
    '--toast-bg': '#2b2118',
    '--toast-warn-bg': '#b91c1c',
    '--toast-text': '#fffcf6',
    '--grid-dot': 'rgba(110,80,40,0.16)',
    '--landing-light-source': 'color-mix(in srgb, var(--brand-tile-bg) 64%, transparent)',
    '--landing-vignette': 'rgba(80,43,12,0.12)',
    '--landing-depth-ink': 'rgba(110,65,20,0.30)',
    '--landing-panel-edge': 'rgba(255,255,255,0.92)',
    '--shadow-card': LIGHT_RAISED_SHADOW,
    '--shadow-pop': LIGHT_RAISED_SHADOW,
    '--shadow-modal': '0 2px 0 #e2d5bf, 0 24px 60px -20px rgba(110,80,40,0.45)',
    '--accent-fg': '#ffffff',
    '--danger-fg': '#ffffff',
    '--ok-bg': '#dcfce7',
    '--ok-text': '#166534',
    ...MODE_INDEPENDENT_TOKENS,
  }, {
    ...VOTE_RESULT_TOKENS,
    '--minimap-viewport-highlight': '0 0 0 1px rgba(255,236,210,0.18) inset',
    '--sticky-vote-bg': '#f3ebdf',
    '--sticky-vote-text': '#1b1814',
    '--zone-fill-alpha': '0.10',
    '--shadow-sticky': '0 1px 1px rgba(0,0,0,0.4), 0 18px 20px -14px rgba(0,0,0,0.9)',
    '--shadow-sticky-flat': '0 1px 0 rgba(0,0,0,0.5)',
    '--bg': '#1b1814',
    '--bg-panel': '#26211b',
    '--bg-panel-2': '#312a22',
    '--bg-elev': '#26211b',
    '--bg-overlay': 'rgba(38,33,27,0.92)',
    '--bg-modal-veil': 'rgba(0,0,0,0.4)',
    '--text': '#f3ebdf',
    '--text-mid': '#d8cbb8',
    '--text-muted': '#a99883',
    '--text-faint': '#776a5a',
    '--border': '#3f372d',
    '--border-soft': 'rgba(255,236,210,0.08)',
    '--border-strong': 'rgba(255,236,210,0.16)',
    '--btn-primary-bg': '#f3ebdf',
    '--btn-primary-fg': '#1b1814',
    '--btn-primary-border': '#f3ebdf',
    '--btn-primary-hover': '#d8cbb8',
    '--accent': '#fb923c',
    '--accent-strong': '#fdba74',
    '--accent-bg': '#483320',
    '--accent-text': '#fdba74',
    '--danger': '#f87171',
    '--warn-border': 'rgba(250,204,21,0.35)',
    '--shadow-press': '0 2px 0 #0f0d0a',
    '--warn-bg': '#44391a',
    '--warn-text': '#fcd34d',
    '--results-success-bg': '#24362a',
    '--results-success-text': '#bdd8b6',
    '--toast-bg': '#3a332a',
    '--toast-warn-bg': '#7f1d1d',
    '--toast-text': '#f3ebdf',
    '--grid-dot': 'rgba(255,230,200,0.07)',
    '--landing-light-source': 'color-mix(in srgb, var(--accent) 20%, transparent)',
    '--landing-vignette': 'rgba(0,0,0,0.34)',
    '--landing-depth-ink': 'rgba(0,0,0,0.58)',
    '--landing-panel-edge': 'rgba(255,223,183,0.18)',
    '--shadow-card': DARK_RAISED_SHADOW,
    '--shadow-pop': DARK_RAISED_SHADOW,
    '--shadow-modal': '0 2px 0 #0f0d0a, 0 24px 60px -20px rgba(0,0,0,0.8)',
    '--accent-fg': '#1b1814',
    '--danger-fg': '#1b1814',
    '--ok-bg': '#253b26',
    '--ok-text': '#86efac',
    ...MODE_INDEPENDENT_TOKENS,
  });

function resolveMode(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  // 'auto'
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

function applyTokens(mode) {
  const tokens = TOKENS[mode];
  if (!tokens) return;
  const root = document.documentElement;
  Object.keys(tokens).forEach((k) => root.style.setProperty(k, tokens[k]));
  root.setAttribute('data-theme', mode);
  document.body.style.background = tokens['--bg'];
  document.body.style.color = tokens['--text'];
}

function readPref() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'auto') return saved;
  } catch { /* swallow */ }
  return 'auto';
}

let currentPref = readPref();
const listeners = new Set();

// Apply immediately on first import.
if (typeof document !== 'undefined') {
  applyTokens(resolveMode(currentPref));
}

// React to OS theme changes when preference is 'auto'.
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => {
    if (currentPref === 'auto') {
      applyTokens(resolveMode('auto'));
      listeners.forEach((fn) => fn(currentPref));
    }
  });
}

export function getThemePref() { return currentPref; }

export function setThemePref(next) {
  if (!['light', 'dark', 'auto'].includes(next)) return;
  currentPref = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* swallow */ }
  applyTokens(resolveMode(next));
  listeners.forEach((fn) => fn(next));
}

export function useTheme() {
  const [pref, setPrefState] = useState(currentPref);
  useEffect(() => {
    const fn = (next) => setPrefState(next);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  const resolved = resolveMode(pref);
  return { pref, resolved, setThemePref };
}

// Convenience helper to cycle auto → light → dark → auto.
export function nextThemePref(cur) {
  if (cur === 'auto') return 'light';
  if (cur === 'light') return 'dark';
  return 'auto';
}
