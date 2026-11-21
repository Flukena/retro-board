import { useCallback } from 'react';
import { MINIMAP_IDLE_MS } from './minimap-timing.js';
import { minimapPointToWorld, centerViewportOnWorld } from '../../domain/minimap.js';

const KEY_STEP_FRACTION = 0.2;
const MINIMAP_CLOCK = {
  setTimeout: (run, delayMs) => globalThis.setTimeout(run, delayMs),
  clearTimeout: id => globalThis.clearTimeout(id),
  requestAnimationFrame: run => globalThis.requestAnimationFrame(run),
  cancelAnimationFrame: id => globalThis.cancelAnimationFrame(id),
};

export function clearMinimapHideTimer(timerRef, clock = MINIMAP_CLOCK) {
  if (timerRef.current != null) clock.clearTimeout(timerRef.current);
}

export function createMinimapVisibility({
  minimapPanelRef, minimapHideTimerRef, interactionRef, ownerDocument = globalThis.document,
  clock = MINIMAP_CLOCK,
}) {
  const reveal = () => {
    const panel = minimapPanelRef.current;
    if (!panel) return;
    panel.style.opacity = '1';
    panel.style.pointerEvents = 'auto';
    if (minimapHideTimerRef.current != null) clock.clearTimeout(minimapHideTimerRef.current);
    const hideWhenIdle = () => {
      const currentPanel = minimapPanelRef.current;
      if (!currentPanel) return;
      const hasFocus = currentPanel.contains(ownerDocument.activeElement);
      const isHovered = currentPanel.matches(':hover');
      if (hasFocus || isHovered || interactionRef.current?.kind === 'minimap') {
        minimapHideTimerRef.current = clock.setTimeout(hideWhenIdle, MINIMAP_IDLE_MS);
        return;
      }
      currentPanel.style.opacity = '0';
      currentPanel.style.pointerEvents = 'none';
      minimapHideTimerRef.current = null;
    };
    minimapHideTimerRef.current = clock.setTimeout(hideWhenIdle, MINIMAP_IDLE_MS);
  };
  return { reveal, dispose() { clearMinimapHideTimer(minimapHideTimerRef, clock); } };
}
export function createMinimapNavigation({
  viewport, minimapModelRef, interactionRef, stopFollowing, settleWheelBeforeInteraction,
  activeViewportFinalizerRef, view = globalThis.window, clock = MINIMAP_CLOCK,
}) {
  const start = (e) => {
    if (e.button !== 0 || interactionRef.current !== null || !minimapModelRef.current) return;
    stopFollowing();
    e.preventDefault();
    e.stopPropagation();
    settleWheelBeforeInteraction();
    const surface = e.currentTarget;
    const surfaceRect = surface.getBoundingClientRect();
    const pointerId = e.pointerId;
    const startZoom = viewport.getViewport().zoom;
    let pendingPoint = null;
    let frame = null;
    let finished = false;

    const navigate = (clientX, clientY) => {
      const model = minimapModelRef.current;
      if (!model) return;
      const worldPoint = minimapPointToWorld({ clientX, clientY }, surfaceRect, model);
      viewport.previewViewport(centerViewportOnWorld(
        { ...viewport.getViewport(), zoom: startZoom },
        model.viewportSize,
        worldPoint,
      ));
    };
    const flush = () => {
      frame = null;
      if (!pendingPoint) return;
      const point = pendingPoint;
      pendingPoint = null;
      navigate(point.x, point.y);
    };
    const queue = (clientX, clientY) => {
      pendingPoint = { x: clientX, y: clientY };
      if (frame == null) frame = clock.requestAnimationFrame(flush);
    };
    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      queue(ev.clientX, ev.clientY);
    };
    const removeListeners = () => {
      view.removeEventListener('pointermove', onMove);
      view.removeEventListener('pointerup', onUp);
      view.removeEventListener('pointercancel', onCancel);
      view.removeEventListener('blur', onBlur);
    };
    const finalize = () => {
      if (finished) return;
      finished = true;
      if (frame != null) { clock.cancelAnimationFrame(frame); frame = null; }
      if (pendingPoint) {
        const point = pendingPoint;
        pendingPoint = null;
        navigate(point.x, point.y);
      }
      interactionRef.current = null;
      surface.style.cursor = 'crosshair';
      removeListeners();
      if (activeViewportFinalizerRef.current === onBlur) activeViewportFinalizerRef.current = null;
      viewport.finishViewport(viewport.getViewport());
    };
    const onUp = (ev) => { if (ev.pointerId === pointerId) finalize(); };
    const onCancel = (ev) => { if (ev.pointerId === pointerId) finalize(); };
    const onBlur = () => finalize();

    interactionRef.current = { kind: 'minimap' };
    surface.style.cursor = 'grabbing';
    navigate(e.clientX, e.clientY);
    view.addEventListener('pointermove', onMove);
    view.addEventListener('pointerup', onUp);
    view.addEventListener('pointercancel', onCancel);
    view.addEventListener('blur', onBlur);
    activeViewportFinalizerRef.current = onBlur;
  };
  const keyDown = (e) => {
    const model = minimapModelRef.current;
    if (!model || interactionRef.current !== null) return;
    const current = viewport.getViewport();
    const stepX = model.viewportSize.w * KEY_STEP_FRACTION;
    const stepY = model.viewportSize.h * KEY_STEP_FRACTION;
    let next = null;
    if (e.key === 'ArrowLeft') next = { ...current, x: current.x + stepX };
    if (e.key === 'ArrowRight') next = { ...current, x: current.x - stepX };
    if (e.key === 'ArrowUp') next = { ...current, y: current.y + stepY };
    if (e.key === 'ArrowDown') next = { ...current, y: current.y - stepY };
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    viewport.commitViewport(next);
  };
  return { start, keyDown };
}

export function useMinimapReveal(options, dependencies) {
  return useCallback(createMinimapVisibility(options).reveal, dependencies);
}

export function useMinimapNavigation(options, dependencies) {
  return useCallback(createMinimapNavigation(options).start, dependencies);
}

export function useMinimapKeys(options, dependencies) {
  return useCallback(createMinimapNavigation(options).keyDown, dependencies);
}
