import React, { useCallback, useEffect, useState } from 'react';
import { useBrowserLayoutEffect } from '../ui/use-browser-layout-effect.js';
import { mobileEditableField, mobileViewportStyle, MOBILE_EDITOR_VISIBILITY_EVENT } from './mobile-editing.js';
import { MOBILE_LAYOUT_QUERY } from '../ui/mobile-layout.js';
import { Z } from '../chrome/chrome-layout.js';
import { t } from '../ui/i18n.js';
import './mobile-editing.css';

const stopPropagation = (event) => event.stopPropagation();

export function useMobileEditing() {
  const [mobile, setMobile] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia(MOBILE_LAYOUT_QUERY).matches
  ));
  useEffect(() => {
    const query = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return mobile;
}

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

function MobileDoneControl({ editorRef }) {
  const [viewportStyle, setViewportStyle] = useState({});
  useBrowserLayoutEffect(() => {
    const viewport = window.visualViewport;
    const update = () => setViewportStyle(mobileViewportStyle(viewport, window.innerHeight));
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    update();
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, []);
  return (
    <button type="button" className="rb-mobile-editor__done" style={{ ...viewportStyle, zIndex: Z.DOCK }}
      onPointerDown={stopPropagation} onMouseDown={stopPropagation}
      onClick={() => editorRef.current?.blur()}>{t('mobile.done')}</button>
  );
}

export function MobileEditingControls({ item, editingAllowed, isEditing, onBeginFocus, editorRef, lang }) {
  void lang;
  const field = mobileEditableField(item);
  if (!editingAllowed) return null;
  if (isEditing) return editorRef ? <MobileDoneControl editorRef={editorRef} /> : null;
  if (!field) return null;
  return (
    <button type="button" className="rb-mobile-edit-control" style={{ zIndex: Z.DOCK }}
      onPointerDown={stopPropagation} onMouseDown={stopPropagation}
      onClick={() => onBeginFocus(item, field)}>{t('mobile.edit')}</button>
  );
}
