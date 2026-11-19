import React from 'react';
import { templateThumbnail } from '../../domain/template-model.js';
import { ZONE_RADIUS_PX } from '../board/card-look.js';
import { PALETTE } from '../ui/palette.js';
import './template-thumbnail.css';

const THUMBNAIL_WIDTH_PX = 48;
const THUMBNAIL_HEIGHT_PX = 32;
const THUMBNAIL_PADDING_PX = 2;
const THUMBNAIL_STROKE_WIDTH_PX = 1;
const FALLBACK_PALETTE_INDEX = 0;

const BASE_CLASS = 'rb-template-thumbnail';

export function TemplateThumbnail({
  zones, width = THUMBNAIL_WIDTH_PX, height = THUMBNAIL_HEIGHT_PX, padding = THUMBNAIL_PADDING_PX, className,
}) {
  const rects = templateThumbnail(zones, width, height, padding, ZONE_RADIUS_PX);
  return (
    <svg className={className ? `${BASE_CLASS} ${className}` : BASE_CLASS} aria-hidden="true" focusable="false"
      width={width} height={height}
      viewBox={`0 0 ${width} ${height}`}>
      {rects.map(({ x, y, w, h, r, color }, index) => {
        const palette = PALETTE[color] || PALETTE[FALLBACK_PALETTE_INDEX];
        return <rect key={`${x}:${y}:${w}:${h}:${color}:${index}`} x={x} y={y} width={w} height={h} rx={r} ry={r} fill={palette.bg} stroke={palette.border}
          strokeWidth={THUMBNAIL_STROKE_WIDTH_PX} />;
      })}
    </svg>
  );
}
