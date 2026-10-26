import { useCallback } from 'react';
import { useBrowserLayoutEffect } from '../ui/use-browser-layout-effect.js';
import { MOBILE_EDITOR_VISIBILITY_EVENT } from './mobile-editing.js';
import './mobile-editing.css';

function editorViewportRect() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

export function useMobileEditorVisibility(elementRef, enabled, textValue) {
  const notify = useCallback(() => {
    const node = elementRef.current;
    if (!node || document.activeElement !== node) return;
    const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
    node.dispatchEvent(new CustomEvent(MOBILE_EDITOR_VISIBILITY_EVENT, {
      bubbles: true,
      detail: { editorRect: { left, top, right, bottom, width, height }, viewportRect: editorViewportRect() },
    }));
  }, [elementRef]);

  useBrowserLayoutEffect(() => {
    if (!enabled) return undefined;
    const viewport = window.visualViewport;
    let frame;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(notify);
    };
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    if (elementRef.current) observer?.observe(elementRef.current);
    elementRef.current?.focus({ preventScroll: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, [elementRef, enabled, notify]);

  useBrowserLayoutEffect(() => {
    if (!enabled) return undefined;
    const frame = requestAnimationFrame(notify);
    return () => cancelAnimationFrame(frame);
  }, [enabled, notify, textValue]);
}
