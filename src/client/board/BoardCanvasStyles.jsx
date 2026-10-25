import React from 'react';
import { COMMENT_CAROUSEL_STYLE } from './card-look.js';

export function BoardCanvasStyles() {
  return (
      <style>{`
        @keyframes rb-appear {
          0%   { opacity: 0; transform: scale(0.78); }
          60%  { opacity: 1; transform: scale(1.04); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes rb-bump {
          0%   { transform: scale(1); }
          40%  { transform: scale(1.28); }
          100% { transform: scale(1); }
        }
        @keyframes rb-editing-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
        @keyframes rb-selection-aura {
          0%, 100% {
            box-shadow:
              0 0 0 2px hsl(var(--rb-selector-hue) 78% 52% / 0.72),
              0 0 12px 3px hsl(var(--rb-selector-hue) 82% 55% / 0.42),
              0 0 24px 7px hsl(var(--rb-selector-hue) 86% 60% / 0.18);
          }
          50% {
            box-shadow:
              0 0 0 3px hsl(var(--rb-selector-hue) 82% 50% / 0.90),
              0 0 20px 6px hsl(var(--rb-selector-hue) 86% 55% / 0.58),
              0 0 34px 12px hsl(var(--rb-selector-hue) 90% 62% / 0.28);
          }
        }
        @keyframes rb-sticky__vote-float {
          0%   { opacity: 0; transform: translate(-50%, 0) scale(0.6); }
          20%  { opacity: 1; transform: translate(-50%, -10px) scale(1.1); }
          100% { opacity: 0; transform: translate(-50%, -55px) scale(1.1); }
        }
        @keyframes rb-toast-in {
          0%   { opacity: 0; transform: translate(-50%, 14px) scale(0.96); }
          100% { opacity: 1; transform: translate(-50%, 0) scale(1); }
        }
        @keyframes rb-pop {
          0%   { opacity: 0; transform: scale(0.9); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes rb-glow {
          0%, 100% { box-shadow: var(--shadow-winner); }
          50%      { box-shadow: var(--shadow-winner-peak); }
        }
        @keyframes rb-sticky__comment-slide {
          0%   { opacity: 0; transform: translateX(10px); }
          18%  { opacity: 1; transform: translateX(0); }
          82%  { opacity: 1; transform: translateX(0); }
          100% { opacity: 0; transform: translateX(-10px); }
        }
        ${COMMENT_CAROUSEL_STYLE}
        .rb-editing-dot {
          animation: rb-editing-pulse 1.1s ease-in-out infinite;
        }
        .rb-remote-selected-card {
          --rb-selector-hue: 200;
          box-shadow:
            0 0 0 2px hsl(var(--rb-selector-hue) 78% 52% / 0.72),
            0 0 12px 3px hsl(var(--rb-selector-hue) 82% 55% / 0.42),
            0 0 24px 7px hsl(var(--rb-selector-hue) 86% 60% / 0.18);
          animation: rb-selection-aura 1.8s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .rb-sticky__comment-slide { animation: none !important; }
          .rb-player-cursor { transition: none !important; }
          .rb-editing-dot { animation: none !important; }
          .rb-remote-selected-card { animation: none !important; }
        }
        .rb-no-select * { user-select: none; }
      `}</style>
  );
}
