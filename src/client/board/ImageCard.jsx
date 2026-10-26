import React from 'react';
import { imageFitsPaintLayer } from './image-paint.js';
import { sizeForPlacement } from '../../domain/board-geometry.js';
import { safeRuntimeImageSource } from '../transfer/image-upload.js';
import { appearAnimation } from './appear-animation.js';

const { w: IMAGE_DEFAULT_WIDTH_PX, h: IMAGE_DEFAULT_HEIGHT_PX } = sizeForPlacement({ type: 'image' });

export const ImageCard = React.memo(function ImageCard({
  item, selected, remoteSelected, remoteSelectionHue, dense, onStartDrag, publicPreview = false, zoom, viewportSize,
}) {
  const it = item;
  const safeSrc = safeRuntimeImageSource(it.src, { publicPreview });
  const w = it.w || IMAGE_DEFAULT_WIDTH_PX;
  const h = it.h || IMAGE_DEFAULT_HEIGHT_PX;
  return (
    <div
      data-image-id={it.id}
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
        // Cache small filtered images; leave large raster layers to the browser.
        willChange: !remoteSelected && !dense && !publicPreview && imageFitsPaintLayer({ w, h }, zoom, viewportSize)
          ? 'transform' : undefined,
        outline: selected ? '2px solid #2563eb' : 'none',
        outlineOffset: 6,
        cursor: 'grab',
        userSelect: 'none',
        animation: remoteSelected || dense ? undefined : appearAnimation({ w, h }),
        contain: remoteSelected ? 'layout style' : 'layout paint style',
      }}
    >
      {safeSrc && (
        <img
          src={safeSrc}
          alt=""
          draggable={false}
          loading={publicPreview ? 'eager' : 'lazy'}
          decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'fill', display: 'block' }}
        />
      )}
    </div>
  );
});
