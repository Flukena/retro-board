import React, { memo, useLayoutEffect, useRef } from 'react';
import { TOKENS } from '../ui/theme.js';
import { paintMinimapItems } from './minimap-paint.js';

// One bitmap instead of one DOM element for every object on the whole board.
// The viewport frame and keyboard/pointer navigation remain in the DOM.
export const MinimapCanvas = memo(function MinimapCanvas({ model, colors }) {
  const canvasRef = useRef(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return undefined;
    const draw = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(model.width * ratio);
      canvas.height = Math.ceil(model.height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || TOKENS.light['--minimap-text-fallback'];
      const imageColor = getComputedStyle(document.documentElement).getPropertyValue('--minimap-image').trim()
        || TOKENS.light['--minimap-image'];
      paintMinimapItems(ctx, model.items, colors, textColor, imageColor);
    };
    draw();
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [model, colors]);
  return <canvas ref={canvasRef} aria-hidden="true" style={{
    position: 'absolute', left: 0, top: 0, width: model.width, height: model.height,
    pointerEvents: 'none',
  }} />;
});
