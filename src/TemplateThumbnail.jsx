import React from 'react';
import { templateThumbnail } from './template-model.js';
import { PALETTE } from './palette.js';
import './template-thumbnail.css';

const THUMBNAIL_WIDTH_PX = 48;
const THUMBNAIL_HEIGHT_PX = 32;
const THUMBNAIL_PADDING_PX = 2;
const THUMBNAIL_STROKE_WIDTH_PX = 1;
const FALLBACK_PALETTE_INDEX = 0;

export function TemplateThumbnail({ zones }) {
  const rects = templateThumbnail(zones, THUMBNAIL_WIDTH_PX, THUMBNAIL_HEIGHT_PX, THUMBNAIL_PADDING_PX);
  return (
    <svg className="rb-template-thumbnail" aria-hidden="true" focusable="false"
      width={THUMBNAIL_WIDTH_PX} height={THUMBNAIL_HEIGHT_PX}
      viewBox={`0 0 ${THUMBNAIL_WIDTH_PX} ${THUMBNAIL_HEIGHT_PX}`}>
      {rects.map(({ x, y, w, h, color }, index) => {
        const palette = PALETTE[color] || PALETTE[FALLBACK_PALETTE_INDEX];
        return <rect key={`${x}:${y}:${w}:${h}:${color}:${index}`} x={x} y={y} width={w} height={h} fill={palette.bg} stroke={palette.border}
          strokeWidth={THUMBNAIL_STROKE_WIDTH_PX} />;
      })}
    </svg>
  );
}
