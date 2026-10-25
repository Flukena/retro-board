import React, { useRef, useCallback } from 'react';
import { useBrowserLayoutEffect } from '../ui/use-browser-layout-effect.js';
import { describeTextReplacement, mapSelectionIndexThroughReplacement } from '../session/collaborative-text.js';
import { useMobileEditorVisibility, useMobileEditing } from './MobileEditingControls.jsx';
import { editorContentOverflowPx } from './mobile-editing.js';

// A controlled input normally moves its caret when a remote value replaces
// the DOM value. Keep a selection anchored through the minimal remote change,
// while local keystrokes retain the browser's native selection behaviour.
export const CollaborativeTextEditor = ({
  kind = 'textarea', editorRef, value, onValueChange, onContentOverflow, ...props
}) => {
  const elementRef = useRef(null);
  const mobile = useMobileEditing();
  const textValue = String(value ?? '');
  const selectionRef = useRef({ start: textValue.length, end: textValue.length });
  const selectionValueRef = useRef(textValue);
  useMobileEditorVisibility(elementRef, mobile, textValue);

  const assignRef = useCallback((node) => {
    elementRef.current = node;
    if (typeof editorRef === 'function') editorRef(node);
    else if (editorRef) editorRef.current = node;
  }, [editorRef]);

  const rememberSelection = useCallback((node) => {
    if (!node) return;
    selectionRef.current = {
      start: node.selectionStart ?? 0,
      end: node.selectionEnd ?? node.selectionStart ?? 0,
    };
    selectionValueRef.current = node.value;
  }, []);

  useBrowserLayoutEffect(() => {
    const node = elementRef.current;
    const previousValue = selectionValueRef.current;
    if (node && document.activeElement === node && previousValue !== textValue) {
      const change = describeTextReplacement(previousValue, textValue);
      const nextStart = Math.min(
        textValue.length,
        mapSelectionIndexThroughReplacement(selectionRef.current.start, change),
      );
      const nextEnd = Math.min(
        textValue.length,
        mapSelectionIndexThroughReplacement(selectionRef.current.end, change),
      );
      node.setSelectionRange(nextStart, nextEnd);
      selectionRef.current = { start: nextStart, end: nextEnd };
    }
    selectionValueRef.current = textValue;
  }, [textValue]);

  useBrowserLayoutEffect(() => {
    const node = elementRef.current;
    if (!node || kind === 'input' || !onContentOverflow) return;
    onContentOverflow(editorContentOverflowPx(node));
  }, [kind, onContentOverflow, textValue]);

  const handleChange = useCallback((event) => {
    const node = event.currentTarget;
    rememberSelection(node);
    onValueChange(node.value, {
      clientHeight: node.clientHeight,
      scrollHeight: node.clientHeight + editorContentOverflowPx(node),
    });
  }, [onValueChange, rememberSelection]);

  const Element = kind === 'input' ? 'input' : 'textarea';
  return (
    <Element
      {...props}
      id={mobile ? 'rb-mobile-text-editor' : props.id}
      className={mobile ? `${props.className ?? ''} rb-mobile-editor__input` : props.className}
      ref={assignRef}
      value={textValue}
      onChange={handleChange}
      onSelect={(event) => rememberSelection(event.currentTarget)}
    />
  );
};
