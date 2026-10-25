import { useEffect, useState } from 'react';
import { isEditableDrawingImage } from '../../domain/drawing-image-target.js';

const DRAW_MODE = 'draw';
export function useDrawingSession({ creationMode, setCreationMode, setSelectedIds, requireEdit, closeTemplates }) {
  const [target, setTarget] = useState(null);
  const enter = () => { closeTemplates(); setCreationMode(DRAW_MODE); setSelectedIds(new Set()); };
  const toggle = () => {
    if (!requireEdit()) return;
    if (creationMode === DRAW_MODE) setCreationMode(null); else enter();
  };
  const edit = item => {
    if (!isEditableDrawingImage(item) || !requireEdit()) return;
    setTarget({ ...item }); enter();
  };
  useEffect(() => { if (creationMode !== DRAW_MODE) setTarget(null); }, [creationMode]);
  const close = () => setCreationMode(null);
  return { target, toggle, edit, close };
}
