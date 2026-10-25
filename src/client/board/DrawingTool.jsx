import React, { memo, useEffect, useRef, useState } from 'react';
import { Undo2, Redo2, X, Pencil, Eraser, Square, Circle, ArrowUpRight } from 'lucide-react';
import { DrawingDraft, DRAWING_WIDTHS_SCREEN_PX, DRAWING_ERASER_WIDTHS_SCREEN_PX } from '../../domain/freehand-drawing.js';
import { DRAWING_TOOL, DRAWING_TOOLS } from '../../domain/drawing-shapes.js';
import { DrawingLiveSession } from './DrawingLiveSession.js';
import { hideDrawingImage } from './drawing-visibility.js';
import { useDrawingImage } from './useDrawingImage.js';
import { DrawingController } from './DrawingController.js';
import { loadDrawingPreferences, saveDrawingPreferences } from './drawing-preferences.js';
import { uploadWithRetry } from '../transfer/image-upload.js';
import { FONT_COLORS } from '../ui/palette.js';
import { Button, IconButton, Surface } from '../ui/UiPrimitives.jsx';
import { SURFACE_KIND } from '../ui/ui-variants.js';
import { useBrowserLayoutEffect } from '../ui/use-browser-layout-effect.js';
import { CHROME_ICON_SIZE_PX, Z } from '../chrome/chrome-layout.js';
import { t } from '../ui/i18n.js';
import './drawing-tool.css';

const DRAWING_ICONS = Object.freeze({ pen: Pencil, eraser: Eraser, rectangle: Square, circle: Circle, arrow: ArrowUpRight });
const summaryOf = draft => ({ canUndo: draft.canUndo, canRedo: draft.canRedo, empty: draft.empty });

function browserStorage() {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

function statusKey({ error, failed, loading, ready, saving }) {
  if (error) return error;
  if (failed) return 'draw.loadFailed';
  if (loading || !ready) return 'draw.loading';
  return saving ? 'draw.saving' : null;
}

function ColorSwatches({ color, disabled, onChange }) {
  return <div className="rb-drawing-group" role="group" aria-label={t('draw.color')}>
    {FONT_COLORS.map(entry => <button key={entry.label} type="button" className="rb-drawing-swatch"
      aria-pressed={color === entry.value} aria-label={t(`font.color.${entry.label}`)} title={t(`font.color.${entry.label}`)}
      disabled={disabled} style={{ '--rb-drawing-swatch': entry.swatch }} onClick={() => onChange(entry.value)} />)}
  </div>;
}

function SizeButtons({ label, widths, width, disabled, onChange }) {
  return <div className="rb-drawing-group" role="group" aria-label={label}>
    {widths.map((value, step) => <button key={value} type="button" className="rb-drawing-size" data-size-step={step}
      aria-pressed={width === value} aria-label={t('draw.widthPx', { n: value })} title={t('draw.widthPx', { n: value })}
      disabled={disabled} onClick={() => onChange(value)}><span aria-hidden="true" /></button>)}
  </div>;
}

export const DrawingTool = memo(function DrawingTool(props) {
  const { active, lang } = props; void lang;
  const draftRef = useRef(null); if (!draftRef.current) draftRef.current = new DrawingDraft();
  const canvasRef = useRef(null), controllerRef = useRef(null), contextRef = useRef(props), sessionRef = useRef(null);
  const [summary, setSummary] = useState(() => summaryOf(draftRef.current));
  const [initialPreferences] = useState(() => loadDrawingPreferences(browserStorage()));
  const [color, setColor] = useState(initialPreferences.color), [width, setWidth] = useState(initialPreferences.width);
  const [tool, setTool] = useState(DRAWING_TOOL.PEN), [eraserWidth, setEraserWidth] = useState(initialPreferences.eraserWidth);
  useEffect(() => { saveDrawingPreferences(browserStorage(), { color, width, eraserWidth }); }, [color, width, eraserWidth]);
  const [closing, setClosing] = useState(false);
  const [saving, setSaving] = useState(false), [error, setError] = useState(null);
  const closingRef = useRef(closing); closingRef.current = closing;
  const erasing = tool === DRAWING_TOOL.ERASER;
  const selectedWidth = erasing ? eraserWidth : width;
  const settingsRef = useRef({ color: null, width: selectedWidth, tool });
  useBrowserLayoutEffect(() => {
    contextRef.current = props; settingsRef.current = { color, width: selectedWidth, tool };
    controllerRef.current?.requestPaint();
  });
  const refresh = () => { setSummary(summaryOf(draftRef.current)); controllerRef.current?.requestPaint(); };
  const { baseRef, loading, failed, retry } = useDrawingImage(active, props.target, refresh);
  const ready = !props.target || !!baseRef.current;
  useBrowserLayoutEffect(() => { draftRef.current.clear(); setError(null); setTool(DRAWING_TOOL.PEN); refresh(); }, [props.target]);
  const finish = () => contextRef.current.onClose();
  const liveTargetId = sessionRef.current?.target?.id ?? props.target?.id ?? null;
  useBrowserLayoutEffect(() => {
    if (!active) return undefined;
    const id = liveTargetId;
    props.storage?.setLocalBusyItems?.('geometry', id ? [id] : []);
    const reveal = hideDrawingImage(document, id);
    return () => { reveal(); props.storage?.setLocalBusyItems?.('geometry', []); };
  }, [active, liveTargetId]);
  useBrowserLayoutEffect(() => {
    if (!active || !canvasRef.current) return undefined;
    setSaving(false); setClosing(false); setError(null);
    const get = () => contextRef.current;
    const session = new DrawingLiveSession(draftRef.current, {
      createId: () => crypto.randomUUID(), previews: () => window.storage?.drawingPreviews,
      items: () => get().boardRef.current.items, canEdit: () => get().editingAllowed && get().requireEdit(),
      zoom: () => get().viewportRef.current.zoom, document: () => canvasRef.current.ownerDocument,
      baseImage: () => baseRef.current, author: () => ({ authorId: get().userId, authorName: get().userName }),
      uploadImage: (blob, signal) => uploadWithRetry(blob, undefined, { signal }),
      stopUndoCapture: () => get().storage.stopUndoCapture?.(),
      addItem: item => get().onAddItem(item), updateItem: (id, patch) => get().onUpdateItem(id, patch),
      removeItem: id => get().onRemoveItem(id), selectItem: id => get().onSelectItem(id),
      error: setError, saving: setSaving, changed: refresh, removed: finish,
    }, get().target);
    sessionRef.current = session;
    const exit = async () => {
      setClosing(true); const saved = await session.close(); setClosing(false); return saved;
    };
    if (get().exitRef) get().exitRef.current = exit;
    const controller = new DrawingController(canvasRef.current, draftRef.current, {
      viewport: () => get().viewportRef.current, boardCanvas: () => get().boardCanvasRef.current,
      settings: () => settingsRef.current, baseImage: () => baseRef.current, busy: () => false,
      canDraw: () => !closingRef.current && (!get().target || !!baseRef.current) && get().editingAllowed && get().requireEdit(),
      beginGesture: () => get().onBeginGesture(), stopFollowing: () => get().onStopFollowing(),
      applyViewport: next => get().onApplyViewport(next), commitViewport: next => get().onCommitViewport(next),
      changed: () => { refresh(); session.changed(); }, previewChanged: () => session.preview(), limitReached: () => setError('draw.limitReached'), cancel: finish,
    });
    controllerRef.current = controller; const dispose = controller.attach(); refresh();
    return () => { if (get().exitRef) get().exitRef.current = null; session.dispose(); sessionRef.current = null; controllerRef.current = null; dispose(); draftRef.current.clear(); };
  }, [active]);

  const changeHistory = redo => {
    if (redo) draftRef.current.redo(); else draftRef.current.undo();
    setError(null); refresh(); sessionRef.current?.changed();
  };
  if (!active) return null;
  const status = statusKey({ error, failed, loading, ready, saving });
  return <>
    <canvas ref={canvasRef} className="rb-drawing-canvas" role="img" aria-label={t('draw.canvas')}
      data-mobile-gesture="native" style={{ zIndex: Z.DRAWING_LAYER }} />
    <Surface kind={SURFACE_KIND.TOOLBAR} className="rb-drawing-toolbar" data-board-shortcuts="off"
      role="toolbar" aria-label={t('tool.draw')} style={{ zIndex: Z.DOCK }}>
      <div className="rb-drawing-tools" role="group" aria-label={t('draw.tools')}>
        {DRAWING_TOOLS.map(value => { const Icon = DRAWING_ICONS[value]; return <IconButton key={value} data-drawing-tool={value}
          aria-pressed={tool === value} aria-label={t(`draw.tool.${value}`)} title={t(`draw.tool.${value}`)} disabled={closing || !ready}
          onClick={() => { controllerRef.current?.finishStroke(); setTool(value); }}><Icon size={CHROME_ICON_SIZE_PX.TOOL} /></IconButton>; })}
      </div>
      <div className="rb-drawing-options">
        <SizeButtons label={t(erasing ? 'draw.eraserSize' : 'draw.width')} widths={erasing ? DRAWING_ERASER_WIDTHS_SCREEN_PX : DRAWING_WIDTHS_SCREEN_PX}
          width={selectedWidth} disabled={closing || !ready} onChange={erasing ? setEraserWidth : setWidth} />
        <ColorSwatches color={color} disabled={closing || erasing || !ready} onChange={setColor} />
      </div>
      <div className="rb-drawing-actions">
      <IconButton title={t('topbar.undo')} aria-label={t('topbar.undo')} disabled={closing || !summary.canUndo} onClick={() => changeHistory(false)}><Undo2 size={CHROME_ICON_SIZE_PX.TOOL} /></IconButton>
      <IconButton title={t('topbar.redo')} aria-label={t('topbar.redo')} disabled={closing || !summary.canRedo} onClick={() => changeHistory(true)}><Redo2 size={CHROME_ICON_SIZE_PX.TOOL} /></IconButton>
      <IconButton title={t('draw.cancel')} aria-label={t('draw.cancel')} onClick={() => { sessionRef.current?.discard(); finish(); }}><X size={CHROME_ICON_SIZE_PX.TOOL} /></IconButton>
      </div>
      {failed && <Button onClick={retry}>{t('draw.retryLoad')}</Button>}
      {status && <div className="rb-drawing-status" role={error ? 'alert' : 'status'}>{t(status)}</div>}
    </Surface>
  </>;
});
