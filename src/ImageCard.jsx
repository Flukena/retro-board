import React from 'react';
import { sizeForPlacement } from './board-geometry.js';
import { safeRuntimeImageSource } from './image-upload.js';

const { w: IMAGE_DEFAULT_WIDTH_PX, h: IMAGE_DEFAULT_HEIGHT_PX } = sizeForPlacement({ type: 'image' });

export const ImageCard = React.memo(function ImageCard({
  item, selected, remoteSelected, remoteSelectionHue, dense, onStartDrag,
}) {
  const it = item;
  const safeSrc = safeRuntimeImageSource(it.src);
  const w = it.w || IMAGE_DEFAULT_WIDTH_PX;
  const h = it.h || IMAGE_DEFAULT_HEIGHT_PX;
  return (
    <div
      className={remoteSelected ? 'rb-remote-selected-card' : undefined}
      onMouseDown={(e) => onStartDrag(e, it)}
      style={{
        position: 'absolute',
        ['--rb-selector-hue']: remoteSelectionHue,
        left: it.x,
        top: it.y,
        width: w,
        height: h,
        // drop-shadow respects PNG alpha but is GPU-expensive; a tight blur
        // radius keeps it cheap when many images are on screen, and dense mode
        // drops it entirely. CSS containment scopes layout/paint invalidation
        // to this card so a change in one image doesn't repaint neighbours.
        filter: remoteSelected || dense ? 'none' : 'var(--image-card-filter)',
        outline: selected ? '2px solid #2563eb' : 'none',
        outlineOffset: 6,
        cursor: 'grab',
        userSelect: 'none',
        animation: remoteSelected || dense ? undefined : 'rb-appear 0.28s ease-out',
        contain: remoteSelected ? 'layout style' : 'layout paint style',
      }}
    >
      {safeSrc && (
        <img
          src={safeSrc}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'fill', display: 'block' }}
        />
      )}
    </div>
  );
});

