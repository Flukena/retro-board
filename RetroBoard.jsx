import { useImageImport } from './src/client/transfer/use-image-import.js';
import { useOnImportPick, useOnImportFileChange, useConfirmImport } from './src/client/transfer/use-board-import.js';
import { RemoteCursorLayer } from './src/client/session/RemoteCursorLayer.jsx';
import { usePresenceBroadcastState, usePresenceBroadcast } from './src/client/session/use-presence-broadcast.js';
import { useEditingPresenceState, useEditingPresence, createLocalEditingPresence } from './src/client/session/use-editing-presence.js';
import { BoardDialogs } from './src/client/ui/BoardDialogs.jsx';
import { useTopBarProps } from './src/client/chrome/use-topbar-props.js';
import { ZonePreview, EmptyCanvasHint, MarqueeSelection } from './src/client/board/CanvasOverlays.jsx';
import { RemoteCollaborationLabels } from './src/client/board/RemoteCollaborationLabels.jsx';
import { useBrowserZoomGuard } from './src/client/board/use-browser-zoom-guard.js';
import { resizeGeometry } from './src/domain/resize-geometry.js';
import { routeBoardKey } from './src/client/board/board-key-router.js';
import { undoBlockReason } from './src/domain/undo-guard.js';
import { createStickyItem, createTextItem, createZoneItem, createImageItem } from './src/domain/item-factory.js';
import { filterLockedZoneMoves } from './src/domain/zone-move-lock.js';
import BoardLoading from './src/client/app/BoardLoading.jsx';
import { FOLLOW_VIEWPORT_COMMIT_MS } from './src/client/board/follow-timing.js';
import { MINIMAP_IDLE_MS } from './src/client/board/minimap-timing.js';
import { DRAG_THRESHOLD, DRAG_FLUSH_MS, DRAG_TRAILING_MS, RECENT_MOVE_WINDOW_MS } from './src/client/board/drag-timing.js';
import { useToast } from './src/client/ui/use-toast.js';
// RetroBoard.jsx — application coordinator for the collaborative board
// Yjs-backed realtime board with character-level collaborative text editing.

import { BOARD_MODE } from './src/domain/public-wall-contract.js';
import React, {
  useState, useEffect, useRef, useCallback, useMemo, startTransition,
} from 'react';
import { useBoardExports } from './src/client/transfer/use-board-exports.js';
import { useActionItems } from './src/client/board/use-action-items.js';
import { useRetroPhase } from './src/client/board/use-retro-phase.js';
import { useMoodCheck } from './src/client/board/use-mood-check.js';
import { useFollowMotion } from './src/client/board/use-follow-motion.js';
import { usePresenterFollow } from './src/client/board/use-presenter-follow.js';
import { actionTogglePatch } from './src/domain/action-item.js';
import { geometryErrorForItem, geometryErrorForPatch, sizeForPlacement, sizeForResize, sizeForGroupBounds, sizeForStickySignature } from './src/domain/board-geometry.js';
import {
  BOARD_TEXT_MAX_LENGTH,
  ZONE_TITLE_MAX_LENGTH,
} from './src/domain/security-boundaries.js';
import { CLEARED_VOTE_RESULTS, voteSessionScope, resetVoteSessionEntries } from './src/domain/vote-session-lifecycle.js';
import { boardEditingAllowed, boardManagementPermissions, runSharedBoardAction } from './src/domain/public-board-permissions.js';
import { publicZoneCreationSize } from './src/domain/public-zone-layout.js';
import { itemSizeBounds, groupScaleRange } from './src/domain/item-size-limits.js';
import { isEditableDrawingImage } from './src/domain/drawing-image-target.js';
import { useDrawingMode } from './src/client/board/useDrawingMode.js';
import { useDrawingSession } from './src/client/board/useDrawingSession.js';
import { LiveDrawingPreviews } from './src/client/board/LiveDrawingPreviews.jsx';
import { DrawingTool } from './src/client/board/DrawingTool.jsx';
import { useSpacePan } from './src/client/board/use-space-pan.js';
import { ToolDock, TOOL_ID } from './src/client/chrome/ToolDock.jsx';
import { ZoomControls } from './src/client/chrome/ZoomControls.jsx';
import { TopCenterStack } from './src/client/chrome/TopCenterStack.jsx';
import { templateRows, followBannerModel } from './src/client/chrome/chrome-model.js';
import { SelectionToolbar, GroupSelectionToolbar } from './src/client/board/SelectionToolbar.jsx';
import { selectionToolbarAnchor, groupSelectionToolbarAnchor } from './src/client/board/selection-toolbar-model.js';
import { ZoneCard } from './src/client/board/ZoneCard.jsx';
import { zoneEffectiveRevealed, zoneGroupIds, nestedZoneCount } from './src/domain/zone-actions.js';
import { useZoneHeaderActions } from './src/client/board/useZoneHeaderActions.js';
import { Toast } from './src/client/ui/Toast.jsx';
import { TopBar } from './src/client/chrome/TopBar.jsx';
import { shareLinkModel } from './src/client/chrome/topbar-model.js';
import { hueFromId } from './src/client/board/player-colors.js';
import { t, useLang } from './src/client/ui/i18n.js';
import { useTheme } from './src/client/ui/theme.js';
import { PALETTE } from './src/client/ui/palette.js';
import { BoardCanvasStyles } from './src/client/board/BoardCanvasStyles.jsx';
import { stickyCreationSize } from './src/client/board/sticky-font.js';
import { BoardStickyCard } from './src/client/board/BoardStickyCard.jsx';
import { DEFAULT_STICKY_WIDTH_PX as STICKY_W, DEFAULT_STICKY_HEIGHT_PX as STICKY_H } from './src/domain/board-geometry.js';
import './src/client/board/board-cards.css';
import {
  MINIMAP_W_PX, MINIMAP_H_PX, topStackHeightPx, Z,
} from './src/client/chrome/chrome-layout.js';
import { useUserIdentity } from './src/client/session/useUserIdentity.js';
import { getTemplates } from './src/client/templates/builtin-templates.js';
import { templateRevealViewport } from './src/domain/template-model.js';
import { useBoardTemplates } from './src/client/templates/use-board-templates.js';
import { useBoardTitle } from './src/client/app/use-board-title.js';
import { usePendingStarter } from './src/client/templates/pending-starter.js';
import { activeVoteZone, zoneHasActiveGovernor } from './src/domain/vote-ownership.js';
import { useAdminRole } from './src/client/session/useAdminRole.js';
import { clientPointToWorld } from './src/domain/board-coordinates.js';
import { buildTopVotedRanks } from './src/domain/voting-results.js';
import {
  allowCanvasFileDrop,
  dragClientPoint,
  droppedImageBlobs,
  resolveDropClientPoint,
} from './src/client/transfer/image-drop.js';
import { unlockEntriesForSelection } from './src/client/board/selection-actions.js';
import {
  buildMinimapModel,
  centerViewportOnWorld,
  minimapPointToWorld,
} from './src/domain/minimap.js';
import {
  visiblePlayerCursors,
} from './src/client/session/player-cursors.js';
import { summarizeRemoteEditors, summarizeRemoteSelectors } from './src/client/session/editing-presence.js';
import { remoteSelectionLabels } from './src/client/board/selection-labels.js';
import { copyTextToClipboard } from './src/client/transfer/clipboard.js';
import { MinimapPanel } from './src/client/board/MinimapPanel.jsx';
import { zoomViewportAt, fitViewportToItems } from './src/domain/viewport-framing.js';
import { ZOOM_STEP_FACTOR, wheelZoomFactor, viewportNeedsCullRefresh } from './src/domain/viewport-zoom.js';
import { selectionLayerAttributes } from './src/client/board/selection-overlay.js';
import { paintViewport } from './src/client/board/viewport-renderer.js';
import { visibleBoardItems, preloadsOverview, detailedStickyIds, usesCompactStickyPaint } from './src/domain/board-render-visibility.js';
import { BoardRasterLayer } from './src/client/board/BoardRasterLayer.jsx';
import { useSettledViewport } from './src/client/board/use-settled-viewport.js';
import { useProgressiveStickyDetails } from './src/client/board/use-progressive-sticky-details.js';
import { reuseSnapshotMap } from './src/domain/snapshot-references.js';
import { warmBoardFonts } from './src/client/ui/board-fonts.js';
import { centerOf, insideZone, resolveOwnerZone, effectiveOwnerZone } from './src/domain/board-ownership.js';
import {
  normalizeDisplayName,
  normalizeStoredUserId,
  normalizeViewport,
} from './src/client/session/local-preferences.js';
import { boardVoteIsOpen, timerDockModel, voteTimerPhaseSignature } from './src/domain/vote-timing.js';
import { extendedDeadline } from './src/domain/countdown.js';
import { storage, adminRoleStorage } from './src/client/session/room-storage.js';
import { DEFAULT_BOARD } from './src/domain/board-state.js';
import { applyRemoteSnapshot, shouldDropSnapshotFocus } from './src/domain/apply-remote-snapshot.js';
import { effectiveZIndex, compareZOrder, swapZOrderEntries } from './src/domain/z-order.js';
import { CollaborativeTextEditor } from './src/client/board/CollaborativeTextEditor.jsx';
import { TextCard } from './src/client/board/TextCard.jsx';
import { ImageCard } from './src/client/board/ImageCard.jsx';
import { canvasCursor } from './src/client/board/board-cursor.js';
import { textPlacementAt, toggleCreationMode } from './src/client/board/creation-mode.js';
import { protectedItemEntries, mergeItemEntries } from './src/domain/move-concealment.js';
import { reparentMoveEntries } from './src/domain/move-reparenting.js';
import { isStickyHiddenForUser, stickyEffectiveRevealed, stickyCloneRevealOverride } from './src/domain/board-visibility.js';
import { attachSafariGestures } from './src/client/board/safari-gestures.js';
import { attachMobileGestures, isMobileGestureEvent } from './src/client/board/mobile-gestures.js';
import { useMobileLayout } from './src/client/ui/use-mobile-layout.js';
import { attachMobileEditorViewport } from './src/client/board/mobile-editor-viewport.js';
import { worldMotionProps } from './src/client/board/world-motion.js';

/* ============================================================
   Constants
   ============================================================ */

const { w: TEXT_W, h: TEXT_H } = sizeForPlacement({ type: 'text' });
const SCROLL_WHEEL_ZOOM_KEY = 'rb_scroll_wheel_zoom';
const POLL_SAFETY = 15000; // safety net only — Realtime push is primary
// Above this many paintable cards (sticky+image) on the board, drop the blurred
// per-card shadows/filters — overlapping blur kernels are the dominant paint
// cost when cards cluster. Cards stay separated by their borders.
const DENSE_CARD_THRESHOLD = 60;
const COMMENT_PREVIEW_TEXT_LIMIT = 120;

/* ============================================================
   Helpers
   ============================================================ */

const uid = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const readScrollWheelZoomEnabled = () => {
  try {
    return typeof window !== 'undefined'
      && window.localStorage?.getItem(SCROLL_WHEEL_ZOOM_KEY) === 'true';
  } catch { return false; }
};

/* ============================================================
   Component
   ============================================================ */

export default function RetroBoard({ boardCode = null, boardToken = null, mode = BOARD_MODE.PRIVATE, pendingTitle = null }) {
  const publicMode = mode === BOARD_MODE.PUBLIC;
  useEffect(() => { void warmBoardFonts(document); }, []);
  /* ---------- i18n + theme ---------- */
  const [lang] = useLang();
  const { pref: themePref, setThemePref } = useTheme();
  // `lang` is referenced so React re-renders strings on toggle.
  void lang;

  /* ---------- Identity ---------- */
  const {
    userId, userIdRef, userName,
    nameDraft, setNameDraft,
    nameModalOpen, setNameModalOpen,
    hydrate: hydrateIdentity, saveName, dismissName,
  } = useUserIdentity(storage);

  /* ---------- Board (shared) ---------- */
  const [board, setBoard] = useState(DEFAULT_BOARD);
  const boardRef = useRef(board);
  useEffect(() => { boardRef.current = board; }, [board]);

  /* ---------- Viewport (per-user) ---------- */
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const viewportRef = useRef(viewport);
  const renderedViewportRef = useRef(viewport);
  const viewportCullCommitAtRef = useRef(0);
  const wheelCommitRef = useRef(null);
  const wheelRafRef = useRef(null);
  const wheelQueueRef = useRef([]);
  useEffect(() => {
    renderedViewportRef.current = viewport;
    if (interactionRef.current === null && wheelCommitRef.current == null
      && wheelRafRef.current == null && !followedUserIdRef.current) viewportRef.current = viewport;
  }, [viewport]);
  const [scrollWheelZoomEnabled, setScrollWheelZoomEnabled] = useState(readScrollWheelZoomEnabled);
  const scrollWheelZoomEnabledRef = useRef(scrollWheelZoomEnabled);
  useEffect(() => { scrollWheelZoomEnabledRef.current = scrollWheelZoomEnabled; }, [scrollWheelZoomEnabled]);
  const toggleScrollWheelZoom = useCallback(() => {
    const next = !scrollWheelZoomEnabledRef.current;
    scrollWheelZoomEnabledRef.current = next;
    setScrollWheelZoomEnabled(next);
    try { window.localStorage.setItem(SCROLL_WHEEL_ZOOM_KEY, String(next)); } catch { /* noop */ }
  }, []);

  /* ---------- Presence (shared map) ---------- */
  const [presence, setPresence] = useState({});
  const { remoteEditingItems, setRemoteEditingItems, remoteSelectedItems, setRemoteSelectedItems } = useEditingPresenceState(storage);
  const localEditingPresence = createLocalEditingPresence(storage);

  /* ---------- UI state ---------- */
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // Mirror selectedIds in a ref so drag callbacks don't need to depend on it.
  // Without this, every click that flips selection would invalidate
  // startItemDrag → invalidate renderedItems → re-build every card's JSX.
  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  const [focusedTextId, setFocusedTextId] = useState(null);
  const [marquee, setMarquee] = useState(null); // {x1,y1,x2,y2} in screen coords
  // Vote state lives in Yjs as per-user-per-item keys (CRDT — no LWW race).
  // `votesByItem` mirrors window.storage.snapshotVotes() and re-renders on remote change.
  const [votesByItem, setVotesByItem] = useState(() => (
    typeof window !== 'undefined' && window.storage?.snapshotVotes
      ? window.storage.snapshotVotes()
      : new Map()
  ));
  const [commentsByItem, setCommentsByItem] = useState(() => (
    typeof window !== 'undefined' && window.storage?.snapshotComments
      ? window.storage.snapshotComments()
      : new Map()
  ));
  const commentPreviewCacheRef = useRef(new Map());
  const [creationMode, setCreationMode, drawingExitRef] = useDrawingMode();
  const clipboardRef = useRef(null);
  const fileDragPointRef = useRef(null);
  const [zonePreview, setZonePreview] = useState(null); // {x,y,w,h} in world coords
  const creationModeRef = useRef(null);
  useEffect(() => { creationModeRef.current = creationMode; }, [creationMode]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [timerSetupZoneId, setTimerSetupZoneId] = useState(null);
  const [followedUserId, setFollowedUserId] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [commentsOpenFor, setCommentsOpenFor] = useState(null);
  const [toast, setToast] = useToast();
  const [voteFlashes, setVoteFlashes] = useState({}); // itemId -> timestamp of latest local vote
  const flashVote = useCallback((itemId) => {
    const t = Date.now();
    setVoteFlashes((prev) => ({ ...prev, [itemId]: t }));
    setTimeout(() => {
      setVoteFlashes((prev) => {
        if (prev[itemId] !== t) return prev;
        const { [itemId]: _gone, ...rest } = prev;
        return rest;
      });
    }, 900);
  }, []);
  const [now, setNow] = useState(Date.now());
  const [loaded, setLoaded] = useState(false);
  const [confirmResetVotes, setConfirmResetVotes] = useState(false);
  const [confirmUnlockAll, setConfirmUnlockAll] = useState(false);
  const [undoState, setUndoState] = useState({ canUndo: false, canRedo: false });

  const focusedTextIdRef = useRef(null);
  const updateFocusedText = useCallback((next) => {
    focusedTextIdRef.current = next;
    setFocusedTextId(next);
    const itemId = typeof next === 'string' ? next.split(':')[0] : null;
    storage.setLocalBusyItems('text', itemId ? [itemId] : []);
  }, []);

  const shortcutToolHandlersRef = useRef({});
  const spaceHeldRef = useRef(false);

  // single-select helpers
  const selectedId = selectedIds.size === 1 ? [...selectedIds][0] : null;
  const setSelectedId = useCallback((id) => {
    setSelectedIds(id == null ? new Set() : new Set([id]));
  }, []);

  /* ---------- Refs ---------- */
  const canvasRef = useRef(null);
  const boardRootRef = useRef(null);
  // Imperative refs for the transformed world layer and the grid background.
  // Pan updates these directly to skip React's render cycle entirely while
  // dragging — see startPan/applyViewportToDom below.
  const worldRef = useRef(null);
  const selectionLayerRef = useRef(null);
  const worldMeasureRef = useRef(null);
  const gridRef = useRef(null);
  const cursorLayerRef = useRef(null);
  const presenceBroadcastRef = usePresenceBroadcastState();
  const followedUserIdRef = useRef(null);
  const followViewportCommitRef = useRef(null);
  const followLastCommitAtRef = useRef(0);
  const followMotionFrameRef = useRef(null);
  const followMotionPlayerRef = useRef(null);
  const followMotionSignatureRef = useRef('');
  const minimapPanelRef = useRef(null);
  const minimapViewportRef = useRef(null);
  const minimapModelRef = useRef(null);
  const minimapHideTimerRef = useRef(null);
  const minimapActivityAtRef = useRef(0);
  const saveTimerRef = useRef(null);
  const interactionRef = useRef(null);
  useSpacePan(spaceHeldRef, canvasRef, interactionRef);
  const editAreaRef = useRef(null);
  // Ids of items currently being dragged/resized locally — protected from remote overwrite of geometry.
  const dragItemsRef = useRef(null);
  const activeGeometryFinalizerRef = useRef(null);
  const activeViewportFinalizerRef = useRef(null);
  useEffect(() => { followedUserIdRef.current = followedUserId; }, [followedUserId]);
  useEffect(() => () => {
    activeGeometryFinalizerRef.current?.();
    activeViewportFinalizerRef.current?.();
    storage.setLocalBusyItems('geometry', []);
    localEditingPresence.dispose();
    presenceBroadcastRef.current.cancel();
    if (followViewportCommitRef.current != null) clearTimeout(followViewportCommitRef.current);
    if (followMotionFrameRef.current != null) cancelAnimationFrame(followMotionFrameRef.current);
    presenceBroadcastRef.current.dispose();
  }, []);

  /* ---------- Derived ---------- */
  // Awareness owns liveness and expires peers using receiver-local time.
  // Comparing sender lastSeen to our clock made connected players flicker.
  const onlineUsers = useMemo(() => Object.values(presence), [presence]);

  const playerCursors = useMemo(() => visiblePlayerCursors({
    presence,
    currentUserId: userId,
    items: board.items, now,
  }), [presence, userId, board.items, now]);

  const followedPlayer = followedUserId
    ? onlineUsers.find((player) => player.userId === followedUserId) || null
    : null;
  const followedCursor = followedUserId
    ? playerCursors.find((player) => player.userId === followedUserId) || null
    : null;
  const followedView = Number.isFinite(followedPlayer?.view?.x)
    && Number.isFinite(followedPlayer?.view?.y)
    ? followedPlayer.view
    : null;
  const stackFollow = followedUserId ? followBannerModel(
    hueFromId(followedUserId), followedPlayer, presence[followedUserId], !followedView && !followedCursor,
    followedUserId === board.presenterUserId,
  ) : null;
  const stackTimers = board.items.filter((item) => item.type === 'zone' && item.voteTimer)
    .map((zone) => timerDockModel(zone, now));
  const remoteEditorsByItem = useMemo(
    () => summarizeRemoteEditors(remoteEditingItems),
    [remoteEditingItems],
  );

  // Boolean dependency: the per-second clock tick must not rebuild selector maps.
  const voteOpenNow = boardVoteIsOpen(board.items, now);
  const remoteSelectorsByItem = useMemo(() => summarizeRemoteSelectors(remoteSelectedItems, voteOpenNow), [remoteSelectedItems, voteOpenNow]);

  const editingIndicators = useMemo(() => board.items.flatMap((item) => {
    const editor = remoteEditorsByItem.get(item.id);
    return editor ? [{ item, editor }] : [];
  }), [board.items, remoteEditorsByItem]);

  const selectionLabels = useMemo(() => remoteSelectionLabels(board.items, remoteSelectorsByItem), [board.items, remoteSelectorsByItem]);

  useEditingPresence({ loaded, storage, selectedIds, setRemoteEditingItems, setRemoteSelectedItems });

  const sortedItems = useMemo(() => {
    return board.items
      .filter((item) => geometryErrorForItem(item) == null)
      .sort(compareZOrder);
  }, [board.items]);

  // Switch cards to cheap paint (no blurred shadow/filter) once the board holds
  // many cards. Keyed on total count — not visible count or zoom — so it never
  // flaps during pan/zoom and doesn't pull viewport into the render memo.
  const denseRender = useMemo(
    () => board.items.reduce(
      (n, it) => (it.type === 'sticky' || it.type === 'image' ? n + 1 : n),
      0,
    ) >= DENSE_CARD_THRESHOLD,
    [board.items],
  );
  const { viewport: detailViewport, compact: compactRender } = useSettledViewport(viewport, viewportRef, interactionRef, wheelCommitRef, wheelRafRef);
  // Viewport size — tracked so we can cull off-screen items at render time.
  // Initialised lazily to handle SSR-style first paint with no window.
  const [viewportSize, setViewportSize] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1280,
    h: typeof window !== 'undefined' ? window.innerHeight : 800,
  }));
  useEffect(() => {
    const onResize = () => setViewportSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const minimapModel = useMemo(() => buildMinimapModel({
    items: sortedItems,
    viewport: detailViewport,
    viewportSize,
    width: MINIMAP_W_PX,
    height: MINIMAP_H_PX,
  }), [sortedItems, detailViewport, viewportSize]);
  minimapModelRef.current = minimapModel;

  const revealMinimap = useCallback(() => {
    const panel = minimapPanelRef.current;
    if (!panel) return;
    panel.style.opacity = '1';
    panel.style.pointerEvents = 'auto';
    if (minimapHideTimerRef.current != null) clearTimeout(minimapHideTimerRef.current);
    const hideWhenIdle = () => {
      const currentPanel = minimapPanelRef.current;
      if (!currentPanel) return;
      const hasFocus = currentPanel.contains(document.activeElement);
      const isHovered = currentPanel.matches(':hover');
      if (hasFocus || isHovered || interactionRef.current?.kind === 'minimap') {
        minimapHideTimerRef.current = setTimeout(hideWhenIdle, MINIMAP_IDLE_MS);
        return;
      }
      currentPanel.style.opacity = '0';
      currentPanel.style.pointerEvents = 'none';
      minimapHideTimerRef.current = null;
    };
    minimapHideTimerRef.current = setTimeout(hideWhenIdle, MINIMAP_IDLE_MS);
  }, []);

  const { publishLocalCursor, clearLocalCursor, publishLocalView } = usePresenceBroadcast(presenceBroadcastRef, viewportSize);

  useEffect(() => {
    if (!loaded || followedUserIdRef.current) return;
    publishLocalView(viewport);
  }, [loaded, viewport, viewportSize, publishLocalView]);

  const onCanvasPointerActivity = useCallback((e) => {
    const timestamp = performance.now();
    if (timestamp - minimapActivityAtRef.current >= 180) {
      minimapActivityAtRef.current = timestamp;
      revealMinimap();
    }
    if (e.pointerType === 'touch') return;
    const v = viewportRef.current;
    publishLocalCursor({
      x: (e.clientX - v.x) / v.zoom,
      y: (e.clientY - v.y) / v.zoom,
    });
  }, [publishLocalCursor, revealMinimap]);

  useEffect(() => {
    window.addEventListener('blur', clearLocalCursor);
    return () => window.removeEventListener('blur', clearLocalCursor);
  }, [clearLocalCursor]);

  useEffect(() => () => {
    if (minimapHideTimerRef.current != null) clearTimeout(minimapHideTimerRef.current);
  }, []);

  // Snapped viewport — quantize pan/zoom so small movements don't invalidate
  // the visibleItems memo. The actual transform still uses the live viewport;
  // this only stabilises the culling decision.
  const cullX = Math.floor(viewport.x / 200) * 200;
  const cullY = Math.floor(viewport.y / 200) * 200;
  const cullZoom = Math.round(viewport.zoom * 20) / 20;
  const cullViewport = useMemo(() => ({ x: cullX, y: cullY, zoom: cullZoom }), [cullX, cullY, cullZoom]);

  // Only render items whose AABB intersects the visible world rect (with a
  // generous margin so items don't pop in at the edge during pan/zoom). The
  // margin is wider than the snap step so culling lines never bite.
  const phoneLayout = useMobileLayout(), preloadCards = preloadsOverview({ dense: denseRender, phoneLayout });
  const visibleItems = useMemo(() => visibleBoardItems(sortedItems, cullViewport, viewportSize, preloadCards),
    [sortedItems, cullViewport, viewportSize, preloadCards]);
  const desiredStickyDetails = useMemo(() => detailedStickyIds(sortedItems, detailViewport, viewportSize, compactRender, denseRender),
    [sortedItems, detailViewport, viewportSize, compactRender, denseRender]);
  const stickyDetails = useProgressiveStickyDetails(desiredStickyDetails, interactionRef, wheelCommitRef, wheelRafRef);

  // Single O(n*z) pass instead of O(n) per zone on every render. Counts stickies
  // by their effective owner zone, keyed by zone id.
  const zoneChildCount = useMemo(() => {
    const counts = new Map();
    const zones = board.items.filter((i) => i.type === 'zone');
    zones.forEach((z) => counts.set(z.id, 0));
    board.items.forEach((it) => {
      if (it.type !== 'sticky') return;
      const owner = effectiveOwnerZone(it, board.items);
      if (owner) counts.set(owner.id, (counts.get(owner.id) || 0) + 1);
    });
    return counts;
  }, [board.items]);

  // Vote derivation helpers — read from the CRDT-backed per-user keys.
  const voteCountOf = useCallback((id) => votesByItem.get(id)?.size ?? 0, [votesByItem]);
  const didUserVoteOn = useCallback((id) => !!votesByItem.get(id)?.has(userId), [votesByItem, userId]);
  const commentCountOf = useCallback((id) => commentsByItem.get(id)?.length ?? 0, [commentsByItem]);
  const commentPreviewsByItem = useMemo(() => {
    const previous = commentPreviewCacheRef.current;
    const previews = new Map();
    commentsByItem.forEach((comments, itemId) => {
      const entries = [...comments]
        .reverse()
        .map((comment) => {
          const text = String(comment.text || '').replace(/\s+/g, ' ').trim();
          return text.length > COMMENT_PREVIEW_TEXT_LIMIT
            ? `${text.slice(0, COMMENT_PREVIEW_TEXT_LIMIT).trimEnd()}…`
            : text;
        })
        .filter(Boolean);
      if (entries.length) {
        const cached = previous.get(itemId);
        const unchanged = cached
          && cached.length === entries.length
          && cached.every((text, index) => text === entries[index]);
        previews.set(itemId, unchanged ? cached : entries);
      }
    });
    return previews;
  }, [commentsByItem]);
  useEffect(() => {
    commentPreviewCacheRef.current = commentPreviewsByItem;
  }, [commentPreviewsByItem]);

  // Map of stickyId -> rank (1, 2, or 3) once its zone's results are finalized.
  // A finished root gets one shared podium across all nested zones — never a
  // separate #1/#2/#3 per child. Drives both the glow and medal badge.
  const topVotedRanks = useMemo(() => {
    return buildTopVotedRanks({
      items: board.items,
      voteCountOf,
      groupIdsForZone: zoneGroupIds,
      ownerZoneForItem: effectiveOwnerZone,
      zoneHasActiveGovernor,
    });
  }, [board, voteCountOf]);

  /* ============================================================
     Load identity + initial board
     ============================================================ */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const uRec = await storage.get('userId', false);
      let id = normalizeStoredUserId(uRec?.value);
      if (!id) {
        id = uid();
        await storage.set('userId', id, false);
      }
      const nRec = await storage.get('userName', false);
      const name = normalizeDisplayName(nRec?.value);
      if (nRec?.value !== name) await storage.set('userName', name, false);

      const vRec = await storage.get('viewport', false);
      const vp = normalizeViewport(vRec?.value);
      if (JSON.stringify(vRec?.value) !== JSON.stringify(vp)) {
        await storage.set('viewport', vp, false);
      }

      const bRec = await storage.get('boardState', true);
      const bs = bRec?.value || DEFAULT_BOARD;

      const pRec = await storage.get('presence', true);
      const pmap = pRec?.value || {};

      if (cancelled) return;
      hydrateIdentity(id, name);
      setViewport(vp);
      setBoard({ ...DEFAULT_BOARD, ...bs });
      setPresence(pmap);
      setLoaded(true);

      // No initial-load admin claim here. The race was: storage.get returns
      // the boardState snapshot at the moment of read, which can be stale
      // (sync still in flight). synced() might flip to true an instant
      // later, and the stale `bs.adminUserId === undefined` then triggers
      // a claim that overwrites whatever the server actually has — every
      // returning client becomes "admin" in their own view. Deferring the
      // entire decision to the heartbeat tick is correct: it reads the
      // live adminUserId from yMeta via storage.getAdminUserId() and is
      // also triggered immediately after sync via storage.onSynced.
    })();
    return () => { cancelled = true; };
  }, []);

  /* ============================================================
     Granular board writes.
     Each helper does an optimistic setBoard (instant UI) and writes only the
     delta to Yjs — so a keystroke or a drag frame no longer re-diffs the whole
     board. `opts.silent` maps to a 'system'-origin Yjs write that peers receive
     but the local undo stack ignores (for derived/automatic changes).
     ============================================================ */
  const lastFlushRef = useRef(0);
  // Latest geometry entries pending a throttled flush during a drag/resize.
  const pendingGeomRef = useRef(null);
  // itemId -> { x, y, w, h, until } for drags that just ended. Lets
  // applyRemoteBoard keep preserving local geometry for a grace period past
  // mouseup, not just while dragItemsRef marks an active drag.
  const recentlyMovedRef = useRef(new Map());
  const lastWriteFailureRef = useRef(0);
  const reportWriteFailure = useCallback(() => {
    const nowMs = Date.now();
    if (window.storage?.consumePublicCreationFailure?.() || nowMs - lastWriteFailureRef.current < 3000) return;
    lastWriteFailureRef.current = nowMs;
    setToast({ msg: t('common.saveFailed'), type: 'warn' });
  }, []);

  // ---- One-item field patch ----
  const updateItem = useCallback((id, patch, opts) => {
    if (!storage.updateItem(id, patch, opts)) { reportWriteFailure(); return false; }
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
    }));
    return true;
  }, [reportWriteFailure]);

  // ---- Add one / many new items ----
  const addItemLocal = useCallback((item) => {
    if (!storage.addItem(item)) { reportWriteFailure(); return false; }
    setBoard((prev) => ({ ...prev, items: [...prev.items, item] }));
    return true;
  }, [reportWriteFailure]);

  const addItemsLocal = useCallback((items) => {
    if (!items.length || !storage.addItems(items)) { reportWriteFailure(); return false; }
    setBoard((prev) => ({ ...prev, items: [...prev.items, ...items] }));
    return true;
  }, [reportWriteFailure]);

  const closeTemplates = useCallback(() => setTemplatesOpen(false), []);
  const { customTemplates, templateDraft, renameTarget, openSaveTemplate, closeSaveDialog,
    openRenameTemplate, renameCustomTemplate, closeRenameDialog, saveCurrentAsTemplate,
    deleteCustomTemplate, applyTemplate: placeTemplate } = useBoardTemplates({
    storage: typeof window !== 'undefined' ? window.storage : null,
    createId: uid, setToast, setSaveTemplateOpen, addItemsLocal, userId, userName, closeTemplates,
  });
  const selectedZoneCount = board.items.filter((item) => item.type === 'zone' && selectedIds.has(item.id)).length;
  const saveSelectedTemplate = () => openSaveTemplate(boardRef.current.items, selectedIds);

  // ---- Board-level meta patch ----
  const patchMeta = useCallback((patch, opts) => {
    if (!storage.setMeta(patch, opts)) { reportWriteFailure(); return false; }
    setBoard((prev) => ({ ...prev, ...patch }));
    return true;
  }, [reportWriteFailure]);
  useBoardTitle({ storage, liveStorage: adminRoleStorage, title: board.title, pendingTitle, patchMeta });

  const {
    isAdmin: roleIsAdmin, canClaim, pinPromptCfg, requireAdminPin: requirePrivateAdminPin, adminClaim, adminTransfer,
  } = useAdminRole({
    userId, userName, board, boardRef, onlineUsers, presence,
    boardCode, boardToken, patchMeta, setToast, storage, liveStorage: adminRoleStorage,
  });

  const { canManage: isAdmin, isPrivateAdmin } = boardManagementPermissions(mode, roleIsAdmin);
  const requireAdminPin = useCallback((action) => runSharedBoardAction(mode, requirePrivateAdminPin, action), [mode, requirePrivateAdminPin]);

  // ---- Full board replace (import / clear) ----
  const replaceBoardLocal = useCallback((nextBoard, opts) => {
    if (!storage.replaceBoard(nextBoard, opts)) { reportWriteFailure(); return false; }
    setBoard(nextBoard);
    return true;
  }, [reportWriteFailure]);

  /* ----- Throttled geometry writer for drag / resize -----
     Optimistic setBoard runs every frame for a live local feel; the granular
     Yjs write is throttled to DRAG_FLUSH_MS with a DRAG_TRAILING_MS trailing
     flush. `pendingGeomRef` always holds the freshest entries, so timing
     against React's commit cycle is irrelevant. */
  const flushPendingGeom = useCallback(() => {
    const entries = pendingGeomRef.current;
    if (entries && entries.length && !storage.updateItems(entries)) {
      reportWriteFailure();
      storage.get('boardState', true).then((record) => {
        if (record?.value) setBoard({ ...DEFAULT_BOARD, ...record.value });
      });
    }
    lastFlushRef.current = Date.now();
  }, [reportWriteFailure]);

  const commitGeometry = useCallback((entries) => {
    const itemById = new Map(boardRef.current.items.map((i) => [i.id, i]));
    const filtered = filterLockedZoneMoves(boardRef.current.items, entries, itemById);
    if (!filtered.length) return;
    if (filtered.some((e) => {
      const current = itemById.get(e.id);
      return !current || geometryErrorForPatch(current, e.patch);
    })) { reportWriteFailure(); return; }
    const protectedEntries = protectedItemEntries(boardRef.current.items,
      mergeItemEntries(pendingGeomRef.current || [], filtered), boardRef.current.allRevealed);
    const byId = new Map(protectedEntries.map((e) => [e.id, e.patch]));
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((it) => (byId.has(it.id) ? { ...it, ...byId.get(it.id) } : it)),
    }));
    pendingGeomRef.current = protectedEntries;
    if (Date.now() - lastFlushRef.current >= DRAG_FLUSH_MS) flushPendingGeom();
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushPendingGeom, DRAG_TRAILING_MS);
  }, [flushPendingGeom, reportWriteFailure]);

  const endGeometry = useCallback(() => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    const entries = pendingGeomRef.current;
    if (entries && entries.length) {
      const until = Date.now() + RECENT_MOVE_WINDOW_MS;
      entries.forEach((e) => recentlyMovedRef.current.set(e.id, { ...e.patch, until }));
    }
    flushPendingGeom();
    pendingGeomRef.current = null;
  }, [flushPendingGeom]);

  const discardPendingGeometry = useCallback(() => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    pendingGeomRef.current = null;
  }, []);

  /* ============================================================
     Realtime push: subscribe to storage change events.
     Polling kept as a long-interval safety net only.
     ============================================================ */
  const applyRemoteBoard = useCallback((remote, isUndoRedo, deletedItemIds = []) => {
    if (!remote) return;
    const pendingContext = { isUndoRedo, deletedItemIds: new Set(deletedItemIds), userId: userIdRef.current, nowMs: Date.now() };
    // Undo/redo is a deliberate, authoritative correction — never let the
    // "protect a just-finished local drag from a stale peer echo" grace
    // window (recentlyMovedRef, below) mask it back to the pre-undo
    // position. Without this, undoing a drag reverts the Yjs doc correctly
    // but the on-screen sticky stays put until a refresh clears the ref.
    if (isUndoRedo) recentlyMovedRef.current.clear();
    const focusedItemId = focusedTextIdRef.current?.split(':')[0] || null;
    if (shouldDropSnapshotFocus(boardRef.current, remote, focusedItemId, pendingContext)) updateFocusedText(null);
    const recentMoves = { forget: (ids) => ids.forEach((id) => recentlyMovedRef.current.delete(id)) };
    setBoard((previous) => {
      const result = applyRemoteSnapshot(previous, remote, {
        ...pendingContext, draggedIds: dragItemsRef.current,
        recentMoves: recentlyMovedRef.current, moveNowMs: Date.now(),
      });
      recentMoves.forget(result.forgetMoveIds);
      return result.board;
    });
  }, [updateFocusedText]);

  useEffect(() => {
    if (!loaded) return undefined;
    const handler = (e) => {
      const { scope, key, value, isUndoRedo, deletedItemIds } = e.detail || {};
      if (scope !== 's') return;
      // applyRemoteBoard preserves geometry for items in dragItemsRef, while
      // collaborative Y.Text snapshots are always applied so simultaneous
      // editors see the merged text on every remote keystroke.
      if (key === 'boardState') applyRemoteBoard(value, isUndoRedo, deletedItemIds);
      else if (key === 'presence') setPresence(value || {});
    };
    if (typeof storage.on === 'function') storage.on(handler);
    // If Yjs sync completed BETWEEN the initial bRec read above and this
    // handler registration, the resulting change event fired into the void.
    // Re-read once now to catch up — and additionally re-read every time the
    // WebSocket re-syncs (reconnect, etc.) so React state never drifts from
    // the canonical yMeta/yItems.
    // Subscribe to vote-key changes (local + remote) and rebuild the snapshot.
    const voteHandler = () => {
      if (typeof window !== 'undefined' && window.storage?.snapshotVotes) {
        const next = window.storage.snapshotVotes();
        setVotesByItem(previous => reuseSnapshotMap(previous, next));
      }
    };
    const commentHandler = () => {
      if (typeof window !== 'undefined' && window.storage?.snapshotComments) {
        const next = window.storage.snapshotComments();
        setCommentsByItem(previous => reuseSnapshotMap(previous, next));
      }
    };
    const resync = () => {
      storage.get('boardState', true).then((r) => {
        if (r?.value) applyRemoteBoard(r.value);
      });
      storage.get('presence', true).then((r) => {
        if (r?.value) setPresence(r.value);
      });
      voteHandler();
      commentHandler();
    };
    resync();
    const offSyncRefresh = window.storage?.onSynced?.(resync) || (() => {});
    let stopped = false;
    const safetyTick = async () => {
      if (stopped) return;
      const bRec = await storage.get('boardState', true);
      if (bRec?.value) applyRemoteBoard(bRec.value);
      const pRec = await storage.get('presence', true);
      if (pRec?.value) setPresence(pRec.value);
      voteHandler();
      commentHandler();
    };
    const interval = setInterval(safetyTick, POLL_SAFETY);
    if (typeof window !== 'undefined' && window.storage?.onVotesChange) {
      window.storage.onVotesChange(voteHandler);
    }
    if (typeof window !== 'undefined' && window.storage?.onCommentsChange) {
      window.storage.onCommentsChange(commentHandler);
    }
    return () => {
      stopped = true;
      if (typeof storage.off === 'function') storage.off(handler);
      if (typeof window !== 'undefined' && window.storage?.offVotesChange) {
        window.storage.offVotesChange(voteHandler);
      }
      if (typeof window !== 'undefined' && window.storage?.offCommentsChange) {
        window.storage.offCommentsChange(commentHandler);
      }
      clearInterval(interval);
      offSyncRefresh();
    };
  }, [loaded, applyRemoteBoard]);

  /* ============================================================
     Timer tick + auto-end actions (admin only)
     ------------------------------------------------------------
     Tick at 1s while a vote session with a deadline is running so the
     countdown stays smooth, but fall back to 5s when the board is idle —
     `now` also gates cursor freshness, and heartbeats fire every
     5s anyway. Cuts idle parent re-renders 5x.
     ============================================================ */
  const tickInterval = board.items.some((i) => i.type === 'zone' && i.voteTimer?.endsAt) ? 1000 : 5000;
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickInterval);
    return () => clearInterval(id);
  }, [tickInterval]);

  // Reposition sticky notes within their innermost containing zone, preserving
  // category membership while ordering each layout by vote count. Medal ranks
  // are computed once across the largest session zone by topVotedRanks above.
  // Shared by both ways a voting session can end: deadline or admin stop.
  const finalizeVotingSession = useCallback((zoneId) => {
    const b = boardRef.current;
    const rootZone = b.items.find((i) => i.id === zoneId && i.type === 'zone');
    if (!rootZone?.voteTimer) return;
    const group = zoneGroupIds(rootZone, b.items);
    b.items.filter((item) => group.has(item.id) || group.has(effectiveOwnerZone(item, b.items)?.id))
      .forEach((item) => recentlyMovedRef.current.delete(item.id));
    const plan = window.storage.finalizeVoteSession(zoneId, rootZone.voteTimer.startedAt, window.storage.getVoteResultParticipants(), Date.now());
    if (!plan) return;
    const patchById = new Map(plan.entries.map((entry) => [entry.id, entry.patch]));
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((item) => (
        patchById.has(item.id) ? { ...item, ...patchById.get(item.id) } : item
      )),
    }));
  }, []);

  /* ============================================================
     Persist viewport (per-user) — debounced lightly
     ============================================================ */
  useEffect(() => {
    if (!loaded) return undefined;
    const t = setTimeout(() => storage.set('viewport', viewport, false), 400);
    return () => clearTimeout(t);
  }, [viewport, loaded]);

  /* ============================================================
     Per-user vote count derived from shared board state.
     Counting actual votes cast keeps quotas in sync across devices and
     reset themselves automatically when admin clears votes.
     ============================================================ */
  const anyZoneVotingActive = useMemo(
    () => board.items.some((i) => i.type === 'zone' && i.voteTimer),
    [board.items],
  );

  // Strictest voteLimit among currently-active zone sessions — for the
  // player-list "quota full" badge. Concurrent zones can carry different
  // limits; the smallest is the one a player actually hits first.
  const activeZoneVoteLimit = useMemo(() => {
    const limits = board.items
      .filter((i) => i.type === 'zone' && i.voteTimer && (!i.voteTimer.endsAt || i.voteTimer.endsAt > now))
      .map((z) => z.voteTimer.voteLimit)
      .filter((l) => l != null);
    return limits.length ? Math.min(...limits) : null;
  }, [board.items, now]);

  const votesUsed = useMemo(() => {
    if (!userId || !anyZoneVotingActive) return 0;
    let count = 0;
    // Only count votes on cards still under an active session — a vote from
    // an earlier, already-finished session must not linger against a fresh
    // session's quota.
    votesByItem.forEach((set, id) => {
      if (!set.has(userId)) return;
      const item = board.items.find((i) => i.id === id);
      if (item && activeVoteZone(item, board.items, now)) count += 1;
    });
    return count;
  }, [votesByItem, userId, anyZoneVotingActive, board.items, now]);

  // Per-user vote tallies for the player list: userId → number of votes cast
  // on cards still under an active session (see votesUsed above).
  const votesUsedByUser = useMemo(() => {
    const m = new Map();
    if (!anyZoneVotingActive) return m;
    votesByItem.forEach((set, id) => {
      const item = board.items.find((i) => i.id === id);
      if (!item || !activeVoteZone(item, board.items, now)) return;
      set.forEach((uid) => { m.set(uid, (m.get(uid) || 0) + 1); });
    });
    return m;
  }, [votesByItem, anyZoneVotingActive, board.items, now]);

  /* Subscribe to Yjs undo-stack changes → toggles button enable/disable. */
  useEffect(() => {
    const sync = () => setUndoState({
      canUndo: !!window.storage?.canUndo?.(),
      canRedo: !!window.storage?.canRedo?.(),
    });
    sync();
    window.storage?.onUndoChange?.(sync);
    return () => window.storage?.offUndoChange?.(sync);
  }, []);

  // A drag in progress holds dragItemsRef, which applyRemoteBoard's merge
  // logic uses to keep showing the item at its live (not-yet-committed)
  // mouse position. Undoing mid-drag would apply the revert underneath that
  // override — invisible until the drag ends, and then the drag's own
  // trailing flush would overwrite the revert right back into Yjs.
  const midDrag = () => !!(dragItemsRef.current && dragItemsRef.current.size > 0);
  const doUndo = useCallback(() => {
    const blocked = undoBlockReason(midDrag(), !boardEditingAllowed(mode, isPrivateAdmin, boardRef.current.editingLocked));
    if (blocked) { setToast({ msg: t(blocked), type: 'warn' }); return; }
    if (!window.storage?.undo?.()) setToast({ msg: t('topbar.nothingToUndo'), type: 'warn' });
  }, [mode, isPrivateAdmin, t]);
  const doRedo = useCallback(() => {
    const blocked = undoBlockReason(midDrag(), !boardEditingAllowed(mode, isPrivateAdmin, boardRef.current.editingLocked));
    if (blocked) { setToast({ msg: t(blocked), type: 'warn' }); return; }
    if (!window.storage?.redo?.()) setToast({ msg: t('topbar.nothingToRedo'), type: 'warn' });
  }, [mode, isPrivateAdmin, t]);

  useBrowserZoomGuard();

  /* ============================================================
     Coordinate helpers
     ============================================================ */
  const screenToWorld = useCallback((sx, sy) => {
    const v = viewportRef.current;
    return { x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom };
  }, []);

  /* ============================================================
     Item operations
     ============================================================ */

  const removeItemUnchecked = useCallback((id) => {
    // One Yjs transaction so Cmd+Z restores the item and its related state together.
    // Falls back to the two-call path if the bridge is an older build that
    // doesn't expose the combined helper yet.
    if (window.storage?.deleteItemWithVotesAndComments) {
      window.storage.deleteItemWithVotesAndComments(id);
      // React state still needs to drop the item — the deepObserver fires a
      // synthetic boardState change, but only for non-local origins. Our own
      // delete is 'local', so do it explicitly here.
      setBoard((prev) => ({ ...prev, items: prev.items.filter((it) => it.id !== id) }));
    } else {
      window.storage?.clearVotesFor?.(id);
      window.storage?.clearCommentsForItems?.([id]);
      setBoard((prev) => ({ ...prev, items: prev.items.filter((it) => it.id !== id) }));
      storage.removeItem(id);
    }
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    if (focusedTextIdRef.current?.startsWith(`${id}:`)) updateFocusedText(null);
  }, [updateFocusedText]);

  const addSticky = useCallback((wx, wy) => {
    // Inherit the color of the deepest enclosing zone — when zones overlap
    // (e.g. Retro Loop's wrapper around the inner columns), the smallest one
    // wins so the sticky picks up the column color, not the frame's.
    const enclosingZone = resolveOwnerZone({
      id: null,
      type: 'sticky',
      x: wx - STICKY_W / 2,
      y: wy - STICKY_H / 2,
      w: STICKY_W,
      h: STICKY_H,
    }, boardRef.current.items);
    const color = enclosingZone
      ? enclosingZone.color
      : Math.floor(Math.random() * PALETTE.length);
    const size = stickyCreationSize(enclosingZone);
    const it = createStickyItem({
      id: uid(), authorId: userId, authorName: userName, createdAt: Date.now(),
      wx, wy, size, enclosingZone, color, publicMode,
    });
    if (!addItemLocal(it)) return;
    setSelectedId(it.id);
    updateFocusedText(`${it.id}:text`);
    setTimeout(() => editAreaRef.current?.focus(), 20);
  }, [userId, userName, addItemLocal, setSelectedId, updateFocusedText, publicMode]);

  const addText = useCallback((wx, wy) => {
    const it = createTextItem({
      id: uid(), authorId: userId, authorName: userName, createdAt: Date.now(),
      wx, wy, text: t('tool.text'),
    }, boardRef.current.items);
    if (!addItemLocal(it)) return;
    setSelectedId(it.id);
    updateFocusedText(`${it.id}:text`);
    setTimeout(() => {
      const el = editAreaRef.current;
      if (el) { el.focus(); el.select(); }
    }, 20);
  }, [userId, userName, addItemLocal, setSelectedId, updateFocusedText]);

  const addZone = useCallback((x, y, w, h, title = 'Untitled', color = 0) => {
    const it = createZoneItem({
      id: uid(), authorId: userId, authorName: userName, createdAt: Date.now(),
      x, y, w, h, title, color,
    }, boardRef.current.items);
    if (!addItemLocal(it)) return;
    setSelectedId(it.id);
    return it.id;
  }, [userId, userName, addItemLocal, setSelectedId]);

  const addImage = useCallback((wx, wy, src, natW, natH) => {
    const it = createImageItem({
      id: uid(), authorId: userId, authorName: userName, createdAt: Date.now(),
      wx, wy, src, natW, natH,
    }, boardRef.current.items);
    if (!addItemLocal(it)) return;
    setSelectedId(it.id);
    return it.id;
  }, [userId, userName, addItemLocal, setSelectedId]);

  const importImageFromBlob = useImageImport({ addImage, setToast }, [addImage, setToast]);


  /* ============================================================
     Admin gates
     ============================================================ */
  const editingAllowed = boardEditingAllowed(mode, isPrivateAdmin, board.editingLocked);
  const canModifyOwnedItem = useCallback((item) => editingAllowed, [editingAllowed]);

  const canDeleteItem = useCallback((item) => (
    canModifyOwnedItem(item) && !(item.type === 'zone' && item.locked)
  ), [canModifyOwnedItem]);

  const deleteItemsIfAllowed = useCallback((candidateIds) => {
    const ids = new Set(candidateIds);
    const items = boardRef.current.items.filter((item) => ids.has(item.id));
    if (!items.length) return false;
    if (!editingAllowed) {
      setToast({ msg: t('common.warnLockEdit'), type: 'warn' });
      return false;
    }
    if (!items.every(canDeleteItem)) {
      setToast({ msg: t('common.warnDeleteDenied'), type: 'warn' });
      return false;
    }
    items.forEach((item) => removeItemUnchecked(item.id));
    return true;
  }, [canDeleteItem, editingAllowed, removeItemUnchecked]);

  const zoneVotingSignature = useMemo(() => {
    const zones = board.items.filter((i) => i.type === 'zone');
    const stickies = board.items.filter((i) => i.type === 'sticky');
    return [
      ...zones.map((z) => `z:${z.id}:${z.x}:${z.y}:${z.w}:${z.h}:${z.voteTimer?.endsAt || 0}:${z.voteTimer?.voteLimit ?? ''}:${z.voteTimer?.hideResults ? 1 : 0}:${z.votingLocked ? 1 : 0}:${z.revealed == null ? '' : z.revealed ? 1 : 0}:${z.parentZoneId ?? ''}`),
      ...stickies.map((s) => {
        const { w, h } = sizeForStickySignature(s);
        return `s:${s.id}:${s.x}:${s.y}:${w}:${h}:${s.revealed === false}:${Object.prototype.hasOwnProperty.call(s, 'parentZoneId') ? (s.parentZoneId || 'null') : 'unset'}`;
      }),
    ]
      .sort()
      .join('|');
  }, [board.items]);

  const votingTimerPhase = useMemo(
    () => voteTimerPhaseSignature(board.items, now),
    [board.items, now],
  );

  const stickyVotingContext = useMemo(() => {
    const map = new Map();
    const stickies = board.items.filter((i) => i.type === 'sticky');
    stickies.forEach((s) => {
      const zone = effectiveOwnerZone(s, board.items);
      const voteZone = activeVoteZone(s, board.items, now);
      const voteTimer = voteZone?.voteTimer;
      map.set(s.id, {
        votingAllowedNow: !!voteZone && !voteZone.votingLocked,
        // "Hide counts" is session-wide, including the admin who started it.
        // Results become visible to everyone again as soon as the session ends.
        hideVoteCounts: !!voteTimer?.hideResults,
        revealed: stickyEffectiveRevealed(s, board.items, board.allRevealed),
        inZone: !!zone,
      });
    });
    return map;
    // The compact phase signature changes only when a timer crosses its
    // deadline, so active timers do not rebuild every sticky once per second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneVotingSignature, votingTimerPhase, board.allRevealed]);

  const requireEdit = useCallback(() => {
    if (!editingAllowed) {
      setToast({ msg: t('common.warnLockEdit'), type: 'warn' });
      return false;
    }
    return true;
  }, [editingAllowed]);

  const drawingSession = useDrawingSession({ creationMode, setCreationMode, setSelectedIds, requireEdit, closeTemplates });

  const unlockSelectedItems = useCallback(() => {
    if (!editingAllowed) {
      setToast({ msg: t('common.warnLockEdit'), type: 'warn' });
      return;
    }
    const entries = unlockEntriesForSelection(boardRef.current.items, selectedIdsRef.current);
    if (!entries.length) return;
    if (!storage.updateItems(entries)) { reportWriteFailure(); return; }
    const unlockedIds = new Set(entries.map((entry) => entry.id));
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((item) => (
        unlockedIds.has(item.id) ? { ...item, locked: false } : item
      )),
    }));
    setToast({ msg: t('selection.unlockAll.done', { n: entries.length }), type: 'info' });
  }, [editingAllowed, t, reportWriteFailure]);

  const requireMove = useCallback((candidateIds) => {
    if (!editingAllowed) {
      setToast({ msg: t('common.warnLockEdit'), type: 'warn' });
      return false;
    }
    const ids = Array.from(new Set(
      Array.from(candidateIds || []).filter((id) => typeof id === 'string' && id.length > 0),
    )).sort();
    const focusedItemId = focusedTextIdRef.current?.split(':')[0] || null;
    if (focusedItemId && ids.includes(focusedItemId)) return false;
    if (storage.findRemoteBusyItem(ids)) {
      setToast({ msg: t('common.warnItemBusy'), type: 'warn' });
      return false;
    }
    storage.setLocalBusyItems('geometry', ids);
    return true;
  }, [editingAllowed]);

  /* ============================================================
     Voting
     ============================================================ */
  const toggleVote = useCallback((it) => {
    const items = boardRef.current.items;
    const voteZone = activeVoteZone(it, items, Date.now());
    const zTimer = voteZone?.voteTimer;
    const allowed = !!voteZone && !voteZone.votingLocked;
    if (!allowed) {
      setToast({ msg: t('vote.notStarted'), type: 'warn' });
      return;
    }
    if (!window.storage?.setVote) return;
    // Read the live Yjs snapshot (not React state) so rapid clicks and
    // concurrent remote writes see the latest value.
    const live = window.storage.snapshotVotes();
    const has = !!live.get(it.id)?.has(userId);
    if (!has && zTimer.voteLimit != null) {
      let used = 0;
      // Only count votes on cards still under an active session — a vote
      // cast in an earlier, already-finished session (anywhere on the
      // board) must not eat into a brand-new session's quota.
      live.forEach((set, id) => {
        if (!set.has(userId)) return;
        const votedItem = items.find((i) => i.id === id);
        if (votedItem && activeVoteZone(votedItem, items, Date.now())) used += 1;
      });
      if (used >= zTimer.voteLimit) {
        setToast({ msg: t('vote.outOfQuota'), type: 'warn' });
        return;
      }
    }
    window.storage.setVote(it.id, userId, !has);
    if (!has) flashVote(it.id);
  }, [userId, flashVote, t]);

  const openComments = useCallback((item) => {
    setCommentsOpenFor(item.id);
  }, []);

  const addCommentTo = useCallback((item, text) => {
    if (!editingAllowed) {
      setToast({ msg: t('common.warnLockEdit'), type: 'warn' });
      return false;
    }
    const trimmed = text.trim();
    if (!trimmed || !window.storage?.addComment) return false;
    return window.storage.addComment(item.id, {
      id: uid(),
      authorId: userId,
      authorName: userName,
      text: trimmed,
      createdAt: Date.now(),
    });
  }, [editingAllowed, userId, userName, t]);

  const deleteCommentFrom = useCallback((itemId, commentId) => {
    if (!editingAllowed) {
      setToast({ msg: t('common.warnLockEdit'), type: 'warn' });
      return;
    }
    window.storage?.deleteComment?.(itemId, commentId);
  }, [editingAllowed, t]);

  const commentsOpenItem = useMemo(
    () => (commentsOpenFor
      ? board.items.find((candidate) => candidate.id === commentsOpenFor) ?? null
      : null),
    [commentsOpenFor, board.items],
  );
  const commentsOpenReadable = !!commentsOpenItem && !isStickyHiddenForUser(
    commentsOpenItem, board.items, board.allRevealed, userId,
  );

  // A remote zone-hide or item deletion must revoke an already-open comment
  // view. Depend on the derived boolean so unrelated board updates do not
  // repeatedly run this synchronization effect.
  useEffect(() => {
    if (commentsOpenFor && !commentsOpenReadable) setCommentsOpenFor(null);
  }, [commentsOpenFor, commentsOpenReadable]);

  /* ============================================================
     Interactions: pan, zoom, drag, resize
     ============================================================ */

  // Apply a viewport directly to the DOM, bypassing React. Used during pan so
  // a board with hundreds of cards doesn't run the React commit phase on every
  // mousemove — pan becomes a single GPU-composited transform.
  const applyViewportToDom = useCallback((v, live = false) => {
    revealMinimap();
    paintViewport(v, { world: worldRef.current, grid: gridRef.current, cursorLayer: cursorLayerRef.current,
      minimapViewport: minimapViewportRef.current, minimapModel: minimapModelRef.current, selectionLayer: selectionLayerRef.current }, { live });
  }, [revealMinimap]);

  // Keep the DOM in sync with React state for non-live changes (fit, reset,
  // initial load). Continuous wheel/pan input applies directly to the DOM,
  // and its final commit brings React state back into sync.
  useEffect(() => {
    if (interactionRef.current === null && wheelCommitRef.current == null
      && wheelRafRef.current == null && !followedUserIdRef.current) applyViewportToDom(viewport);
  }, [viewport, applyViewportToDom, loaded]);

  const liveApplyViewport = useCallback((next, { broadcastView = true } = {}) => {
    viewportRef.current = next;
    applyViewportToDom(next, true);
    if (broadcastView) publishLocalView(next);
    // Refresh culling during long gestures without reconciling on every input
    // frame. Otherwise newly reached objects stay blank until mouseup.
    const rendered = renderedViewportRef.current;
    const nowMs = performance.now();
    if (nowMs - viewportCullCommitAtRef.current >= 100
      && viewportNeedsCullRefresh(rendered, next, viewportSize, visibleItems.length === sortedItems.length)) {
      viewportCullCommitAtRef.current = nowMs;
      // The transform is already current. Let input frames preempt the
      // more expensive React work that mounts newly visible cards.
      startTransition(() => setViewport(next));
    }
  }, [applyViewportToDom, publishLocalView, viewportSize, visibleItems.length, sortedItems.length]);

  // Wheel input is the noisiest input on the page — trackpads / Magic Mice
  // can fire 120+ events/sec. Each event used to force a layout via
  // getBoundingClientRect and write to the DOM, which manifested as zoom
  // jitter. Coalesce events into one rAF tick: cache rect once, fold every
  // queued delta on top of the current viewport, then write the final
  // transform once per frame.
  const cancelPendingWheel = useCallback(() => {
    if (wheelRafRef.current != null) {
      cancelAnimationFrame(wheelRafRef.current);
      wheelRafRef.current = null;
    }
    wheelQueueRef.current = [];
    if (wheelCommitRef.current != null) {
      clearTimeout(wheelCommitRef.current);
      wheelCommitRef.current = null;
    }
  }, []);

  const commitViewportImmediately = useCallback((next) => {
    cancelPendingWheel();
    viewportRef.current = next;
    applyViewportToDom(next);
    setViewport(next);
  }, [applyViewportToDom, cancelPendingWheel]);

  const stopFollowing = useCallback(() => {
    if (!followedUserIdRef.current) return;
    followedUserIdRef.current = null;
    followMotionPlayerRef.current = null;
    followMotionSignatureRef.current = '';
    setFollowedUserId(null);
    if (followViewportCommitRef.current != null) {
      clearTimeout(followViewportCommitRef.current);
      followViewportCommitRef.current = null;
    }
    setViewport(viewportRef.current);
  }, []);

  const startFollowing = useCallback((targetUserId) => {
    if (!targetUserId || targetUserId === userIdRef.current) return;
    if (followViewportCommitRef.current != null) {
      clearTimeout(followViewportCommitRef.current);
      followViewportCommitRef.current = null;
    }
    followedUserIdRef.current = targetUserId;
    followMotionSignatureRef.current = '';
    followLastCommitAtRef.current = 0;
    setFollowedUserId(targetUserId);
  }, []);
  const presenter = usePresenterFollow({ mode, presenterUserId: board.presenterUserId, userId, presence,
    followedUserId, startFollowing, stopFollowing, patchMeta });
  const stackPresenter = presenter.banner ? { kind: presenter.banner, name: presence[presenter.presenterId]?.name,
    onAction: presenter.presenting ? presenter.stopPresenting : presenter.rejoin } : null;

  useEffect(() => {
    if (!followedUserId) return;
    if (!followedPlayer) {
      stopFollowing();
      setToast({ msg: t('follow.ended'), type: 'info' });
      return;
    }
    const targetPoint = followedView || followedCursor?.cursor;
    if (!targetPoint) return;

    const next = centerViewportOnWorld(
      {
        ...viewportRef.current,
        zoom: followedPlayer.view?.zoom || viewportRef.current.zoom,
      },
      viewportSize,
      targetPoint,
    );
    liveApplyViewport(next, { broadcastView: false });

    const timestamp = performance.now();
    const elapsed = timestamp - followLastCommitAtRef.current;
    const commit = () => {
      followViewportCommitRef.current = null;
      followLastCommitAtRef.current = performance.now();
      setViewport(viewportRef.current);
    };
    if (elapsed >= FOLLOW_VIEWPORT_COMMIT_MS) {
      if (followViewportCommitRef.current != null) clearTimeout(followViewportCommitRef.current);
      commit();
    } else if (followViewportCommitRef.current == null) {
      followViewportCommitRef.current = setTimeout(
        commit,
        FOLLOW_VIEWPORT_COMMIT_MS - elapsed,
      );
    }
  }, [
    followedUserId, followedPlayer, followedCursor, followedView, viewportSize,
    liveApplyViewport, stopFollowing, setToast,
  ]);

  const followMotionRefs = useMemo(() => ({ followedUserIdRef, playerRef: followMotionPlayerRef,
    frameRef: followMotionFrameRef, signatureRef: followMotionSignatureRef, viewportRef }), []);
  useFollowMotion({ storage, followedUserId, refs: followMotionRefs, viewportSize, liveApplyViewport });

  // A gesture starting after a live wheel frame must preserve that frame while
  // discarding any not-yet-applied wheel events. This prevents a later React
  // render from restoring the viewport that preceded the gesture.
  const settleWheelBeforeInteraction = useCallback(() => {
    if (wheelCommitRef.current != null) {
      commitViewportImmediately(viewportRef.current);
    } else {
      cancelPendingWheel();
    }
  }, [cancelPendingWheel, commitViewportImmediately]);

  // Cancel any in-flight rAF / trailing commit on unmount so the deferred
  // setViewport callback can't fire after React tore the tree down (would log
  // a "setState on unmounted" warning and leak the closure's refs).
  useEffect(() => () => cancelPendingWheel(), [cancelPendingWheel]);

  const onCanvasWheel = useCallback((e) => {
    e.preventDefault();
    stopFollowing();
    if (interactionRef.current !== null) {
      cancelPendingWheel();
      return;
    }
    let deltaX = e.deltaX;
    let deltaY = e.deltaY;
    if (e.deltaMode === 1) {
      deltaX *= 16;
      deltaY *= 16;
    } else if (e.deltaMode === 2) {
      deltaX *= canvasRef.current?.clientWidth || window.innerWidth;
      deltaY *= canvasRef.current?.clientHeight || window.innerHeight;
    }
    const shouldZoom = (e.ctrlKey || e.metaKey) !== scrollWheelZoomEnabledRef.current;
    if (shouldZoom && deltaY === 0) return;
    wheelQueueRef.current.push({
      kind: shouldZoom ? 'zoom' : 'pan',
      pinch: e.ctrlKey || e.metaKey,
      deltaX,
      deltaY,
      clientX: e.clientX,
      clientY: e.clientY,
    });
    if (wheelRafRef.current != null) return;
    wheelRafRef.current = requestAnimationFrame(() => {
      wheelRafRef.current = null;
      const events = wheelQueueRef.current;
      wheelQueueRef.current = [];
      if (interactionRef.current !== null || !events.length || !canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      let v = viewportRef.current;
      for (let i = 0; i < events.length; i += 1) {
        const ev = events[i];
        if (ev.kind === 'pan') {
          v = { ...v, x: v.x - ev.deltaX, y: v.y - ev.deltaY };
        } else {
          const factor = wheelZoomFactor(ev.deltaY, ev.pinch);
          v = zoomViewportAt(v, v.zoom * factor, {
            x: ev.clientX - rect.left,
            y: ev.clientY - rect.top,
          });
        }
      }
      liveApplyViewport(v);
      if (wheelCommitRef.current) clearTimeout(wheelCommitRef.current);
      wheelCommitRef.current = setTimeout(() => {
        wheelCommitRef.current = null;
        setViewport(viewportRef.current);
      }, 120);
    });
  }, [cancelPendingWheel, liveApplyViewport, stopFollowing]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener('wheel', onCanvasWheel, { passive: false });
    return () => el.removeEventListener('wheel', onCanvasWheel);
  }, [onCanvasWheel, loaded]);

  useEffect(() => attachSafariGestures(canvasRef.current, {
    wheelZoomEnabled: () => scrollWheelZoomEnabledRef.current,
  }), [loaded]);

  const startPan = useCallback((e) => {
    if (interactionRef.current !== null) return false;
    e.preventDefault();
    e.stopPropagation();
    settleWheelBeforeInteraction();
    const start = {
      x: e.clientX,
      y: e.clientY,
      vx: viewportRef.current.x,
      vy: viewportRef.current.y,
      zoom: viewportRef.current.zoom,
    };
    interactionRef.current = { kind: 'pan' };
    if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
    let finished = false;
    let panRaf = null;
    let panPending = null;
    const apply = (clientX, clientY) => {
      liveApplyViewport({
        zoom: start.zoom,
        x: start.vx + (clientX - start.x),
        y: start.vy + (clientY - start.y),
      });
    };
    const onMove = (ev) => {
      panPending = { x: ev.clientX, y: ev.clientY };
      if (panRaf != null) return;
      panRaf = requestAnimationFrame(() => {
        panRaf = null;
        const p = panPending;
        panPending = null;
        if (p) apply(p.x, p.y);
      });
    };
    const removeListeners = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
    };
    const finalize = () => {
      if (finished) return;
      finished = true;
      if (panRaf != null) { cancelAnimationFrame(panRaf); panRaf = null; }
      if (panPending) { const p = panPending; panPending = null; apply(p.x, p.y); }
      interactionRef.current = null;
      removeListeners();
      if (activeViewportFinalizerRef.current === onBlur) activeViewportFinalizerRef.current = null;
      if (canvasRef.current) canvasRef.current.style.cursor = spaceHeldRef.current ? 'grab' : '';
      setViewport(viewportRef.current);
    };
    const onUp = () => finalize();
    const onBlur = () => finalize();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onBlur);
    activeViewportFinalizerRef.current = onBlur;
    return true;
  }, [liveApplyViewport, settleWheelBeforeInteraction]);

  const onCanvasMouseDownCapture = useCallback((e) => {
    stopFollowing();
    if (!spaceHeldRef.current && e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    startPan(e);
  }, [startPan, stopFollowing]);

  const onCanvasMouseDown = useCallback((e) => {
    // Only start pan/marquee if mousedown is on the canvas (not on an item) —
    // unless Space is held, in which case any mousedown always pans (the
    // card's own handler lets the event through; see startItemDrag/startZoneDrag).
    if (!spaceHeldRef.current && e.target !== canvasRef.current && e.target.dataset?.surface !== '1') return;
    if (focusedTextIdRef.current) {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
    }
    if (!spaceHeldRef.current && creationModeRef.current === TOOL_ID.TEXT && requireEdit()) {
      e.preventDefault();
      const rect = canvasRef.current.getBoundingClientRect();
      const at = textPlacementAt(screenToWorld(e.clientX - rect.left, e.clientY - rect.top), { w: TEXT_W, h: TEXT_H });
      setCreationMode(null);
      addText(at.x, at.y);
      return;
    }
    // Zone-creation tool: drag rectangle on canvas to place a new zone.
    if (!spaceHeldRef.current && creationModeRef.current === 'zone' && requireEdit()) {
      e.preventDefault();
      settleWheelBeforeInteraction();
      const rect = canvasRef.current.getBoundingClientRect();
      const start = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      let lastWorld = start;
      let finished = false;
      interactionRef.current = { kind: 'creating-zone' };
      const onMove = (ev) => {
        lastWorld = screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
        const x = Math.min(start.x, lastWorld.x);
        const y = Math.min(start.y, lastWorld.y);
        const w = Math.abs(lastWorld.x - start.x);
        const h = Math.abs(lastWorld.y - start.y);
        setZonePreview({ x, y, w, h });
      };
      const removeListeners = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('blur', onBlur);
      };
      const finalize = (complete) => {
        if (finished) return;
        finished = true;
        interactionRef.current = null;
        removeListeners();
        if (activeViewportFinalizerRef.current === onBlur) activeViewportFinalizerRef.current = null;
        setZonePreview(null);
        if (!complete) return;
        setCreationMode(null);
        const x = Math.min(start.x, lastWorld.x);
        const y = Math.min(start.y, lastWorld.y);
        const { w, h } = publicZoneCreationSize(mode, Math.abs(lastWorld.x - start.x), Math.abs(lastWorld.y - start.y));
        const id = addZone(x, y, w, h);
        // Focus the new zone's title so the user can name it.
        updateFocusedText(`${id}:title`);
        setTimeout(() => {
          editAreaRef.current?.focus();
          editAreaRef.current?.select?.();
        }, 30);
      };
      const onUp = () => finalize(true);
      const onBlur = () => finalize(false);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('blur', onBlur);
      activeViewportFinalizerRef.current = onBlur;
      return;
    }
    const selectTool = creationModeRef.current === 'select';
    const useMarquee = !spaceHeldRef.current && !isMobileGestureEvent(e) && (e.shiftKey || e.button === 2 || selectTool);
    if (!e.shiftKey) setSelectedIds(new Set());
    if (useMarquee) {
      // Box select
      const start = { x: e.clientX, y: e.clientY };
      const baseSelection = e.shiftKey ? new Set(selectedIds) : new Set();
      let finished = false;
      settleWheelBeforeInteraction();
      interactionRef.current = { kind: 'marquee' };
      setMarquee({ x1: start.x, y1: start.y, x2: start.x, y2: start.y });
      const onMove = (ev) => {
        setMarquee({ x1: start.x, y1: start.y, x2: ev.clientX, y2: ev.clientY });
      };
      const removeListeners = () => {
        window.removeEventListener('mousemove', onMoveTracked);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('blur', onBlur);
      };
      const finalize = (complete) => {
        if (finished) return;
        finished = true;
        interactionRef.current = null;
        removeListeners();
        if (activeViewportFinalizerRef.current === onBlur) activeViewportFinalizerRef.current = null;
        setMarquee(null);
        if (!complete) return;
        const m = { x1: Math.min(start.x, lastX), y1: Math.min(start.y, lastY), x2: Math.max(start.x, lastX), y2: Math.max(start.y, lastY) };
        const v = viewportRef.current;
        const wx1 = (m.x1 - v.x) / v.zoom;
        const wy1 = (m.y1 - v.y) / v.zoom;
        const wx2 = (m.x2 - v.x) / v.zoom;
        const wy2 = (m.y2 - v.y) / v.zoom;
        const hits = boardRef.current.items.filter((it) => {
          const c = centerOf(it);
          return c.x >= wx1 && c.x <= wx2 && c.y >= wy1 && c.y <= wy2;
        }).map((it) => it.id);
        const next = new Set(baseSelection);
        hits.forEach((id) => next.add(id));
        setSelectedIds(next);
      };
      let lastX = start.x;
      let lastY = start.y;
      const onMoveTracked = (ev) => { lastX = ev.clientX; lastY = ev.clientY; onMove(ev); };
      const onUp = () => finalize(true);
      const onBlur = () => finalize(false);
      window.addEventListener('mousemove', onMoveTracked);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('blur', onBlur);
      activeViewportFinalizerRef.current = onBlur;
      return;
    }
    if (e.button === 0) startPan(e);
  }, [
    selectedIds, requireEdit, screenToWorld, addZone, addText, mode,
    settleWheelBeforeInteraction, startPan, updateFocusedText,
  ]);

  const applyTemplate = useCallback((key) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const bounds = placeTemplate(key, {
      viewportCenter: screenToWorld(rect.width / 2, rect.height / 2), items: boardRef.current.items,
    });
    if (!bounds) return;
    const next = templateRevealViewport({ bounds, viewport: viewportRef.current,
      viewportSize: { w: rect.width, h: rect.height } });
    if (next) { stopFollowing(); commitViewportImmediately(next); }
  }, [placeTemplate, screenToWorld, stopFollowing, commitViewportImmediately]);
  usePendingStarter({ storage, liveStorage: adminRoleStorage, boardCode, applyTemplate, ready: loaded });

  const fitToContent = useCallback(() => {
    if (interactionRef.current !== null || !canvasRef.current) return;
    stopFollowing();
    const rect = canvasRef.current.getBoundingClientRect();
    commitViewportImmediately(fitViewportToItems(boardRef.current.items, rect.width, rect.height));
  }, [commitViewportImmediately, stopFollowing]);

  const fitToItems = useCallback((idList) => {
    if (interactionRef.current !== null || !canvasRef.current) return;
    stopFollowing();
    const ids = new Set(idList);
    if (ids.size === 0) return;
    const items = boardRef.current.items.filter((it) => ids.has(it.id));
    if (items.length === 0) return;
    const rect = canvasRef.current.getBoundingClientRect();
    commitViewportImmediately(fitViewportToItems(items, rect.width, rect.height));
  }, [commitViewportImmediately, stopFollowing]);
  const fitToSelection = useCallback(() => fitToItems(selectedIdsRef.current), [fitToItems]);

  const zoomBy = useCallback((factor) => {
    if (interactionRef.current !== null || !canvasRef.current) return;
    stopFollowing();
    const rect = canvasRef.current.getBoundingClientRect();
    const center = { x: rect.width / 2, y: rect.height / 2 };
    const current = viewportRef.current;
    commitViewportImmediately(zoomViewportAt(current, current.zoom * factor, center));
  }, [commitViewportImmediately, stopFollowing]);

  const resetZoom = useCallback(() => {
    if (interactionRef.current !== null || !canvasRef.current) return;
    stopFollowing();
    const rect = canvasRef.current.getBoundingClientRect();
    commitViewportImmediately(zoomViewportAt(viewportRef.current, 1, {
      x: rect.width / 2,
      y: rect.height / 2,
    }));
  }, [commitViewportImmediately, stopFollowing]);

  const startMinimapNavigation = useCallback((e) => {
    if (e.button !== 0 || interactionRef.current !== null || !minimapModelRef.current) return;
    stopFollowing();
    e.preventDefault();
    e.stopPropagation();
    settleWheelBeforeInteraction();
    const surface = e.currentTarget;
    const surfaceRect = surface.getBoundingClientRect();
    const pointerId = e.pointerId;
    const startZoom = viewportRef.current.zoom;
    let pendingPoint = null;
    let frame = null;
    let finished = false;

    const navigate = (clientX, clientY) => {
      const model = minimapModelRef.current;
      if (!model) return;
      const worldPoint = minimapPointToWorld({ clientX, clientY }, surfaceRect, model);
      liveApplyViewport(centerViewportOnWorld(
        { ...viewportRef.current, zoom: startZoom },
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
      if (frame == null) frame = requestAnimationFrame(flush);
    };
    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      queue(ev.clientX, ev.clientY);
    };
    const removeListeners = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
    };
    const finalize = () => {
      if (finished) return;
      finished = true;
      if (frame != null) { cancelAnimationFrame(frame); frame = null; }
      if (pendingPoint) {
        const point = pendingPoint;
        pendingPoint = null;
        navigate(point.x, point.y);
      }
      interactionRef.current = null;
      surface.style.cursor = 'crosshair';
      removeListeners();
      if (activeViewportFinalizerRef.current === onBlur) activeViewportFinalizerRef.current = null;
      setViewport(viewportRef.current);
    };
    const onUp = (ev) => { if (ev.pointerId === pointerId) finalize(); };
    const onCancel = (ev) => { if (ev.pointerId === pointerId) finalize(); };
    const onBlur = () => finalize();

    interactionRef.current = { kind: 'minimap' };
    surface.style.cursor = 'grabbing';
    navigate(e.clientX, e.clientY);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    activeViewportFinalizerRef.current = onBlur;
  }, [liveApplyViewport, settleWheelBeforeInteraction, stopFollowing]);

  const onMinimapKeyDown = useCallback((e) => {
    const model = minimapModelRef.current;
    if (!model || interactionRef.current !== null) return;
    const current = viewportRef.current;
    const stepX = model.viewportSize.w * 0.2;
    const stepY = model.viewportSize.h * 0.2;
    let next = null;
    if (e.key === 'ArrowLeft') next = { ...current, x: current.x + stepX };
    if (e.key === 'ArrowRight') next = { ...current, x: current.x - stepX };
    if (e.key === 'ArrowUp') next = { ...current, y: current.y + stepY };
    if (e.key === 'ArrowDown') next = { ...current, y: current.y - stepY };
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    commitViewportImmediately(next);
  }, [commitViewportImmediately]);

  const updateZIndexes = useCallback((entries) => {
    if (!storage.updateItems(entries)) { reportWriteFailure(); return false; }
    const byId = new Map(entries.map((entry) => [entry.id, entry.patch.zIndex]));
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((it) => (
        byId.has(it.id) ? { ...it, zIndex: byId.get(it.id) } : it
      )),
    }));
    return true;
  }, [reportWriteFailure]);

  const bringToFront = useCallback((ids) => {
    if (!ids?.size || interactionRef.current !== null) return;
    const items = boardRef.current.items;
    const targetIds = new Set(ids);
    items.forEach((it) => {
      if (it.type === 'zone' && ids.has(it.id)) {
        zoneGroupIds(it, items).forEach((id) => targetIds.add(id));
      }
    });
    const selected = items
      .filter((it) => targetIds.has(it.id))
      .sort(compareZOrder);
    if (selected.length === 0 || !requireEdit()) return;
    if (!selected.every(canModifyOwnedItem)) return;
    const maxZ = Math.max(...items.map(effectiveZIndex));
    updateZIndexes(selected.map((it, index) => ({
      id: it.id,
      patch: { zIndex: maxZ + index + 1 },
    })));
  }, [canModifyOwnedItem, requireEdit, updateZIndexes]);

  const sendToBack = useCallback((ids) => {
    if (!ids?.size || interactionRef.current !== null) return;
    const items = boardRef.current.items;
    const targetIds = new Set(ids);
    items.forEach((it) => {
      if (it.type === 'zone' && ids.has(it.id)) {
        zoneGroupIds(it, items).forEach((id) => targetIds.add(id));
      }
    });
    const selected = items
      .filter((it) => targetIds.has(it.id))
      .sort((a, b) => compareZOrder(b, a));
    if (selected.length === 0 || !requireEdit()) return;
    if (!selected.every(canModifyOwnedItem)) return;
    const minZ = Math.min(...items.map(effectiveZIndex));
    updateZIndexes(selected.map((it, index) => ({
      id: it.id,
      patch: { zIndex: minZ - index - 1 },
    })));
  }, [canModifyOwnedItem, requireEdit, updateZIndexes]);

  const bringForward = useCallback((id) => {
    if (!id || interactionRef.current !== null) return;
    if (selectedIdsRef.current.size !== 1 || !selectedIdsRef.current.has(id)) return;
    const items = [...boardRef.current.items].sort(compareZOrder);
    const index = items.findIndex((it) => it.id === id);
    if (index < 0 || index === items.length - 1) return;
    if (!requireEdit()) return;
    const entries = swapZOrderEntries(items, index, index + 1);
    const currentById = new Map(boardRef.current.items.map((it) => [it.id, it]));
    if (!entries.every((entry) => {
      const current = currentById.get(entry.id);
      return current && canModifyOwnedItem(current);
    })) return;
    updateZIndexes(entries);
  }, [canModifyOwnedItem, requireEdit, updateZIndexes]);

  const sendBackward = useCallback((id) => {
    if (!id || interactionRef.current !== null) return;
    if (selectedIdsRef.current.size !== 1 || !selectedIdsRef.current.has(id)) return;
    const items = [...boardRef.current.items].sort(compareZOrder);
    const index = items.findIndex((it) => it.id === id);
    if (index <= 0) return;
    if (!requireEdit()) return;
    const entries = swapZOrderEntries(items, index, index - 1);
    const currentById = new Map(boardRef.current.items.map((it) => [it.id, it]));
    if (!entries.every((entry) => {
      const current = currentById.get(entry.id);
      return current && canModifyOwnedItem(current);
    })) return;
    updateZIndexes(entries);
  }, [canModifyOwnedItem, requireEdit, updateZIndexes]);

  const onCanvasDoubleClick = useCallback((e) => {
    if (e.target !== canvasRef.current && e.target.dataset?.surface !== '1') return;
    if (!requireEdit()) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    addSticky(w.x, w.y);
  }, [addSticky, requireEdit, screenToWorld]);

  /* ----- Item drag (supports group when multi-selected) ----- */
  const startItemDrag = useCallback((e, item) => {
    // Space held → let the mousedown bubble to onCanvasMouseDown and pan
    // instead of dragging the card underneath the cursor.
    if (spaceHeldRef.current) return;
    e.stopPropagation();
    const shiftToggle = e.shiftKey;
    // Read selection from a ref so this callback's identity is stable across
    // selection changes — otherwise every selection click would invalidate
    // every memoized card via the renderedItems deps array.
    const currentSelection = new Set(selectedIdsRef.current);
    let dragIds;
    if (shiftToggle) {
      if (currentSelection.has(item.id)) currentSelection.delete(item.id);
      else currentSelection.add(item.id);
      dragIds = new Set(currentSelection);
    } else if (currentSelection.has(item.id) && currentSelection.size > 1) {
      dragIds = new Set(currentSelection);
    } else {
      dragIds = new Set([item.id]);
    }
    const primaryIds = dragIds;
    const start = { x: e.clientX, y: e.clientY };
    let lastClient = { x: start.x, y: start.y };
    const seeds = new Map();
    boardRef.current.items.forEach((it) => {
      if (dragIds.has(it.id)) seeds.set(it.id, { x: it.x, y: it.y });
    });
    let moved = false;
    let claimed = false;
    let finished = false;
    settleWheelBeforeInteraction();
    interactionRef.current = { kind: 'maybe-drag' };
    // Coalesce mousemove updates to one per animation frame so trackpads /
    // high-refresh displays don't fire React updates faster than the screen
    // can paint them.
    let rafId = null;
    let pending = null;
    const removeListeners = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
      storage.offBusyChange(onBusyChange);
    };
    const abortGesture = () => {
      if (finished) return;
      finished = true;
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      pending = null;
      if (moved) discardPendingGeometry();
      dragItemsRef.current = null;
      if (claimed) storage.setLocalBusyItems('geometry', []);
      interactionRef.current = null;
      removeListeners();
      if (activeGeometryFinalizerRef.current === onBlur) activeGeometryFinalizerRef.current = null;
    };
    const onBusyChange = () => {
      if (!storage.findRemoteBusyItem(Array.from(seeds.keys()))) return;
      setToast({ msg: t('common.warnItemBusy'), type: 'warn' });
      abortGesture();
    };
    const applyMove = (clientX, clientY, isFinal = false) => {
      lastClient = { x: clientX, y: clientY };
      const dx = clientX - start.x;
      const dy = clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!moved) {
        if (!requireMove(seeds.keys())) { abortGesture(); return; }
        claimed = true;
        moved = true;
        interactionRef.current = { kind: 'drag' };
        dragItemsRef.current = new Set(seeds.keys());
        storage.onBusyChange(onBusyChange);
      }
      const z = viewportRef.current.zoom;
      const wx = dx / z;
      const wy = dy / z;
      const entries = [];
      seeds.forEach((seed, id) => entries.push({ id, patch: { x: seed.x + wx, y: seed.y + wy } }));
      commitGeometry(isFinal ? reparentMoveEntries(boardRef.current.items, entries, primaryIds) : entries);
    };
    const onMove = (ev) => {
      pending = { x: ev.clientX, y: ev.clientY };
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const p = pending;
        pending = null;
        if (p) applyMove(p.x, p.y);
      });
    };
    const finalize = (allowClick) => {
      if (finished) return;
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      if (pending) { const p = pending; pending = null; applyMove(p.x, p.y); }
      if (finished) return;
      finished = true;
      if (moved) {
        applyMove(lastClient.x, lastClient.y, true);
        endGeometry();
      }
      dragItemsRef.current = null;
      if (claimed) storage.setLocalBusyItems('geometry', []);
      interactionRef.current = null;
      removeListeners();
      if (activeGeometryFinalizerRef.current === onBlur) activeGeometryFinalizerRef.current = null;
      if (allowClick && !moved) {
        if (shiftToggle) setSelectedIds(dragIds);
        else setSelectedId(item.id);
      } else {
        if (moved) setSelectedIds(dragIds);
      }
    };
    const onUp = () => finalize(true);
    const onBlur = () => finalize(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onBlur);
    activeGeometryFinalizerRef.current = onBlur;
  }, [
    requireMove, commitGeometry, endGeometry, discardPendingGeometry,
    setSelectedId, settleWheelBeforeInteraction,
  ]);

  /* ----- Zone title drag (with children) ----- */
  const startZoneDrag = useCallback((e, zone) => {
    // Space held → let the mousedown bubble to onCanvasMouseDown and pan
    // instead of dragging the zone underneath the cursor.
    if (spaceHeldRef.current) return;
    e.stopPropagation();
    // Locked zone's own title bar: select without dragging; unlock via ⋯ → lock.
    // commitGeometry filters locked-zone patches; bailing here avoids a dead drag state.
    if (zone.locked) { setSelectedId(zone.id); return; }
    // If this zone is part of a multi-selection, drag every selected item as a
    // group — matches the marquee/shift-select expectation. Otherwise fall back
    // to the "zone carries its contents" behavior, including nested zones that
    // are strictly contained (so the Retro Loop wrapper moves the whole template).
    // Read selection via ref so this callback stays stable across selections.
    const liveSelectedIds = selectedIdsRef.current;
    const inMultiSelect = liveSelectedIds.has(zone.id) && liveSelectedIds.size > 1;
    const primaryIds = inMultiSelect ? new Set(liveSelectedIds) : new Set([zone.id]);
    const draggedIds = new Set();
    if (inMultiSelect) {
      liveSelectedIds.forEach((id) => draggedIds.add(id));
    } else {
      zoneGroupIds(zone, boardRef.current.items).forEach((id) => draggedIds.add(id));
    }
    const start = { x: e.clientX, y: e.clientY };
    let lastClient = { x: start.x, y: start.y };
    const initial = new Map();
    boardRef.current.items.forEach((it) => {
      if (draggedIds.has(it.id)) initial.set(it.id, { x: it.x, y: it.y });
    });
    let moved = false;
    let claimed = false;
    let finished = false;
    settleWheelBeforeInteraction();
    interactionRef.current = { kind: 'maybe-drag' };
    // See startItemDrag for why we coalesce mousemove via rAF.
    let rafId = null;
    let pending = null;
    const removeListeners = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
      storage.offBusyChange(onBusyChange);
    };
    const abortGesture = () => {
      if (finished) return;
      finished = true;
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      pending = null;
      if (moved) discardPendingGeometry();
      dragItemsRef.current = null;
      if (claimed) storage.setLocalBusyItems('geometry', []);
      interactionRef.current = null;
      removeListeners();
      if (activeGeometryFinalizerRef.current === onBlur) activeGeometryFinalizerRef.current = null;
    };
    const onBusyChange = () => {
      if (!storage.findRemoteBusyItem(Array.from(initial.keys()))) return;
      setToast({ msg: t('common.warnItemBusy'), type: 'warn' });
      abortGesture();
    };
    const applyMove = (clientX, clientY, isFinal = false) => {
      lastClient = { x: clientX, y: clientY };
      const dx = clientX - start.x;
      const dy = clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!moved) {
        if (!requireMove(initial.keys())) { abortGesture(); return; }
        claimed = true;
        moved = true;
        interactionRef.current = { kind: 'drag' };
        dragItemsRef.current = new Set(initial.keys());
        storage.onBusyChange(onBusyChange);
      }
      const z = viewportRef.current.zoom;
      const wx = dx / z;
      const wy = dy / z;
      const entries = [];
      initial.forEach((seed, id) => entries.push({ id, patch: { x: seed.x + wx, y: seed.y + wy } }));
      commitGeometry(isFinal ? reparentMoveEntries(boardRef.current.items, entries, primaryIds) : entries);
    };
    const onMove = (ev) => {
      pending = { x: ev.clientX, y: ev.clientY };
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const p = pending;
        pending = null;
        if (p) applyMove(p.x, p.y);
      });
    };
    const finalize = (allowClick) => {
      if (finished) return;
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      if (pending) { const p = pending; pending = null; applyMove(p.x, p.y); }
      if (finished) return;
      finished = true;
      if (moved) {
        applyMove(lastClient.x, lastClient.y, true);
        endGeometry();
      }
      dragItemsRef.current = null;
      if (claimed) storage.setLocalBusyItems('geometry', []);
      interactionRef.current = null;
      removeListeners();
      if (activeGeometryFinalizerRef.current === onBlur) activeGeometryFinalizerRef.current = null;
      if (allowClick && !moved) setSelectedId(zone.id);
    };
    const onUp = () => finalize(true);
    const onBlur = () => finalize(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onBlur);
    activeGeometryFinalizerRef.current = onBlur;
  }, [
    requireMove, commitGeometry, endGeometry, discardPendingGeometry,
    setSelectedId, settleWheelBeforeInteraction,
  ]);

  /* ----- Generic item resize (zone / sticky / image / text) ----- */
  const startItemResize = useCallback((e, item, corner) => {
    if (spaceHeldRef.current || e.button === 1) { startPan(e); return; }
    if (item.type === 'zone' && item.locked) return;
    e.stopPropagation();
    const aspectLock = item.type === 'image' && !e.altKey;
    const { w: w0, h: h0 } = sizeForResize(item);
    const start = { x: e.clientX, y: e.clientY };
    const initial = { x: item.x, y: item.y, w: w0, h: h0 };
    const bounds = itemSizeBounds(item.type, initial);
    if (!requireMove([item.id])) return;
    settleWheelBeforeInteraction();
    interactionRef.current = { kind: 'drag' };
    dragItemsRef.current = new Set([item.id]);
    let finished = false;
    let lastEntries = null;
    const onMove = (ev) => {
      const z = viewportRef.current.zoom;
      const dx = (ev.clientX - start.x) / z;
      const dy = (ev.clientY - start.y) / z;
      lastEntries = [{ id: item.id, patch: resizeGeometry(initial, corner, dx, dy, aspectLock, bounds) }];
      commitGeometry(lastEntries);
    };
    const removeListeners = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
      storage.offBusyChange(onBusyChange);
    };
    const finalize = () => {
      if (finished) return;
      finished = true;
      if (lastEntries) {
        const entries = lastEntries.map((entry) => ({ id: entry.id, patch: { ...entry.patch } }));
        const patchById = new Map(entries.map((entry) => [entry.id, entry.patch]));
        const finalItems = boardRef.current.items.map((it) => (
          patchById.has(it.id) ? { ...it, ...patchById.get(it.id) } : it
        ));
        const finalSelf = finalItems.find((it) => it.id === item.id);
        // Durable self-orphan: resizing off an explicitly-tracked owner must
        // drop it for good, same as a drag would — otherwise it silently
        // reattaches the moment that zone is later moved/resized back over it.
        if (finalSelf && Object.prototype.hasOwnProperty.call(item, 'parentZoneId') && item.parentZoneId) {
          const owner = finalItems.find((it) => it.id === item.parentZoneId && it.type === 'zone');
          if (!owner || !insideZone(centerOf(finalSelf), owner)) {
            const entry = entries.find((en) => en.id === item.id);
            if (entry) entry.patch.parentZoneId = null;
            else entries.push({ id: item.id, patch: { parentZoneId: null } });
          }
        }
        if (item.type === 'zone' && finalSelf) {
          finalItems.forEach((child) => {
            if (child.parentZoneId === item.id && !insideZone(centerOf(child), finalSelf)) {
              const entry = entries.find((en) => en.id === child.id);
              if (entry) entry.patch.parentZoneId = null;
              else entries.push({ id: child.id, patch: { parentZoneId: null } });
            }
          });
        }
        commitGeometry(entries);
      }
      endGeometry();
      dragItemsRef.current = null;
      storage.setLocalBusyItems('geometry', []);
      interactionRef.current = null;
      removeListeners();
      if (activeGeometryFinalizerRef.current === onBlur) activeGeometryFinalizerRef.current = null;
    };
    const onBusyChange = () => {
      if (!storage.findRemoteBusyItem([item.id])) return;
      setToast({ msg: t('common.warnItemBusy'), type: 'warn' });
      finalize();
    };
    const onUp = () => finalize();
    const onBlur = () => finalize();
    storage.onBusyChange(onBusyChange);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onBlur);
    activeGeometryFinalizerRef.current = onBlur;
  }, [requireMove, commitGeometry, endGeometry, settleWheelBeforeInteraction, startPan]);

  /* ----- Group resize (scales all selected items around opposite corner) ----- */
  const startGroupResize = useCallback((e, corner) => {
    if (spaceHeldRef.current || e.button === 1) { startPan(e); return; }
    e.stopPropagation();
    const items = boardRef.current.items.filter((it) => selectedIds.has(it.id));
    if (items.length < 2) return;
    const originalById = new Map(items.map((it) => [it.id, it]));
    // Snapshot initial bbox and per-item geometry.
    let minX = Infinity; let minY = Infinity;
    let maxX = -Infinity; let maxY = -Infinity;
    const seeds = new Map();
    items.forEach((it) => {
      const { w, h } = sizeForGroupBounds(it);
      seeds.set(it.id, { type: it.type, x: it.x, y: it.y, w, h });
      if (it.x < minX) minX = it.x;
      if (it.y < minY) minY = it.y;
      if (it.x + w > maxX) maxX = it.x + w;
      if (it.y + h > maxY) maxY = it.y + h;
    });
    const initBBox = { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
    // Anchor = opposite corner (stays fixed in world space).
    const ax = (corner === 'nw' || corner === 'sw') ? initBBox.x + initBBox.w : initBBox.x;
    const ay = (corner === 'nw' || corner === 'ne') ? initBBox.y + initBBox.h : initBBox.y;
    const start = { x: e.clientX, y: e.clientY };
    const aspectLock = !e.altKey; // hold Alt to scale freely on both axes
    // Scale range so no item leaves its per-type minimum or cap.
    const { minX: minScaleX, minY: minScaleY, maxX: maxScaleX, maxY: maxScaleY } = groupScaleRange(seeds.values());
    if (!requireMove(seeds.keys())) return;
    settleWheelBeforeInteraction();
    interactionRef.current = { kind: 'drag' };
    dragItemsRef.current = new Set(seeds.keys());
    let finished = false;
    let lastEntries = null;
    // Signs that map a corner's outward direction onto positive growth — using
    // these on raw deltas (not abs) keeps shrink and grow symmetric so the
    // aspect lock holds in both directions.
    const signX = (corner === 'nw' || corner === 'sw') ? -1 : 1;
    const signY = (corner === 'nw' || corner === 'ne') ? -1 : 1;
    const onMove = (ev) => {
      const z = viewportRef.current.zoom;
      const rawDx = (ev.clientX - start.x) / z;
      const rawDy = (ev.clientY - start.y) / z;
      let sx;
      let sy;
      if (aspectLock) {
        // Drive both axes off whichever scale moved farther from 1, preserving
        // sign so dragging inward shrinks (positive growth → s>1, negative → s<1).
        const candX = (initBBox.w + signX * rawDx) / initBBox.w;
        const candY = (initBBox.h + signY * rawDy) / initBBox.h;
        const s = Math.abs(candX - 1) > Math.abs(candY - 1) ? candX : candY;
        sx = s;
        sy = s;
      } else {
        sx = (initBBox.w + signX * rawDx) / initBBox.w;
        sy = (initBBox.h + signY * rawDy) / initBBox.h;
      }
      // Floor at the per-axis minimum. When locked, raise both to the larger
      // floor so the ratio stays exact.
      const floor = aspectLock ? Math.max(minScaleX, minScaleY) : null;
      const ceiling = aspectLock ? Math.min(maxScaleX, maxScaleY) : null;
      sx = aspectLock ? Math.min(Math.max(sx, floor), ceiling) : Math.min(Math.max(sx, minScaleX), maxScaleX);
      sy = aspectLock ? Math.min(Math.max(sy, floor), ceiling) : Math.min(Math.max(sy, minScaleY), maxScaleY);
      const entries = [];
      seeds.forEach((seed, id) => {
        const patch = {
          x: ax + (seed.x - ax) * sx,
          y: ay + (seed.y - ay) * sy,
        };
        if (seed.w > 0) patch.w = seed.w * sx;
        if (seed.h > 0) patch.h = seed.h * sy;
        entries.push({ id, patch });
      });
      lastEntries = entries;
      commitGeometry(entries);
    };
    const removeListeners = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
      storage.offBusyChange(onBusyChange);
    };
    const finalize = () => {
      if (finished) return;
      finished = true;
      if (lastEntries) {
        const entries = lastEntries.map((entry) => ({ id: entry.id, patch: { ...entry.patch } }));
        const patchById = new Map(entries
          .filter((entry) => {
            const it = boardRef.current.items.find((candidate) => candidate.id === entry.id);
            return !(it?.type === 'zone' && it.locked);
          })
          .map((entry) => [entry.id, entry.patch]));
        const finalItems = boardRef.current.items.map((it) => (
          patchById.has(it.id) ? { ...it, ...patchById.get(it.id) } : it
        ));
        // Durable self-orphan: any explicitly-tracked item in the group that
        // resized off its owner must drop it for good (mirrors the solo
        // resize path) — otherwise it silently reattaches later.
        seeds.forEach((seed, id) => {
          const original = originalById.get(id);
          if (!original || !Object.prototype.hasOwnProperty.call(original, 'parentZoneId') || !original.parentZoneId) return;
          const finalSelf = finalItems.find((it) => it.id === id);
          if (!finalSelf) return;
          const owner = finalItems.find((it) => it.id === original.parentZoneId && it.type === 'zone');
          if (!owner || !insideZone(centerOf(finalSelf), owner)) {
            const entry = entries.find((en) => en.id === id);
            if (entry) entry.patch.parentZoneId = null;
            else entries.push({ id, patch: { parentZoneId: null } });
          }
        });
        seeds.forEach((seed, id) => {
          if (seed.type !== 'zone') return;
          const finalZone = finalItems.find((it) => it.id === id);
          if (!finalZone || finalZone.locked) return;
          finalItems.forEach((child) => {
            if (child.parentZoneId === id && !insideZone(centerOf(child), finalZone)) {
              const entry = entries.find((en) => en.id === child.id);
              if (entry) entry.patch.parentZoneId = null;
              else entries.push({ id: child.id, patch: { parentZoneId: null } });
            }
          });
        });
        commitGeometry(entries);
      }
      endGeometry();
      dragItemsRef.current = null;
      storage.setLocalBusyItems('geometry', []);
      interactionRef.current = null;
      removeListeners();
      if (activeGeometryFinalizerRef.current === onBlur) activeGeometryFinalizerRef.current = null;
    };
    const onBusyChange = () => {
      if (!storage.findRemoteBusyItem(Array.from(seeds.keys()))) return;
      setToast({ msg: t('common.warnItemBusy'), type: 'warn' });
      finalize();
    };
    const onUp = () => finalize();
    const onBlur = () => finalize();
    storage.onBusyChange(onBusyChange);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onBlur);
    activeGeometryFinalizerRef.current = onBlur;
  }, [
    requireMove, selectedIds, commitGeometry, endGeometry,
    settleWheelBeforeInteraction, startPan,
  ]);

  /* ----- Duplicate selected items (offset clones into board) ----- */
  const duplicateItems = useCallback((sourceItems, offset = 24) => {
    if (!requireEdit() || !sourceItems?.length) return;
    const b = boardRef.current;
    let stripped = 0;
    const idMap = new Map(sourceItems.map((it) => [it.id, uid()]));
    const clones = sourceItems.map((it) => {
      // Don't carry forward text from private cards the user can't see.
      const isHidden = isStickyHiddenForUser(it, b.items, b.allRevealed, userId);
      if (isHidden) stripped += 1;
      const clone = {
        ...it,
        ...stickyCloneRevealOverride(it, b.items, b.allRevealed),
        id: idMap.get(it.id),
        x: (it.x ?? 0) + offset,
        y: (it.y ?? 0) + offset,
        text: isHidden ? '' : it.text,
        authorId: userId,
        authorName: userName,
        createdAt: Date.now(),
      };
      if (clone.type === 'zone') {
        clone.voteTimer = null;
        clone.lastResultsAt = null;
        delete clone.voteResults;
        clone.votingLocked = false;
      }
      delete clone.zIndex;
      clone.parentZoneId = idMap.has(it.parentZoneId)
        ? idMap.get(it.parentZoneId)
        : (resolveOwnerZone(clone, b.items)?.id ?? null);
      return clone;
    });
    if (!addItemsLocal(clones)) return;
    setSelectedIds(new Set(clones.map((c) => c.id)));
    if (stripped > 0) {
      setToast({ msg: t('copy.hiddenStripped', { n: stripped }), type: 'warn' });
    }
  }, [requireEdit, addItemsLocal, userId, userName]);

  /* ============================================================
     Keyboard
     ============================================================ */
  useEffect(() => {
    const onKey = (e) => {
      const { action, preventDefault } = routeBoardKey(e, {
        focusedText: focusedTextIdRef.current, nameModal: nameModalOpen, commentsOpen: commentsOpenReadable,
        get targetBlocked() {
          const el = e.target instanceof Element ? e.target : null;
          return !!el?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [data-board-shortcuts="off"]');
        },
        following: followedUserIdRef.current,
        get dialogOpen() { return !!document.querySelector('[role="dialog"]'); },
        tools: Object.keys(shortcutToolHandlersRef.current), interacting: interactionRef.current !== null,
        creating: creationModeRef.current, selected: selectedIds.size > 0, clipboard: clipboardRef.current?.length > 0,
      });
      if (preventDefault) e.preventDefault();
      if (!action) return;
      if (action === 'closeComments') { setCommentsOpenFor(null); return; }
      if (action === 'stopFollowing') { stopFollowing(); return; }
      if (shortcutToolHandlersRef.current[action]) { shortcutToolHandlersRef.current[action](); return; }
      if (action === 'fitContent') { fitToContent(); return; }
      if (action === 'fitSelection') { fitToSelection(); return; }
      if (action === 'zoomIn') { zoomBy(ZOOM_STEP_FACTOR); return; }
      if (action === 'zoomOut') { zoomBy(1 / ZOOM_STEP_FACTOR); return; }
      if (action === 'zoomReset') { resetZoom(); return; }
      if (action === 'front' || action === 'back') {
        if (action === 'front') bringToFront(selectedIds);
        else sendToBack(selectedIds);
        return;
      }
      if (action === 'forward' || action === 'backward') {
        const id = selectedIds.size === 1 ? [...selectedIds][0] : null;
        if (action === 'forward') bringForward(id);
        else sendBackward(id);
        return;
      }
      if (action === 'cancelCreation') { setCreationMode(null); setZonePreview(null); return; }
      if (action === 'clearSelection') setSelectedIds(new Set());
      if (action === 'delete' && selectedIds.size > 0) {
        deleteItemsIfAllowed(selectedIds);
      }
      if (action === 'undo') { doUndo(); return; }
      if (action === 'redo') { doRedo(); return; }
      if ((action === 'copy' || action === 'cut') && selectedIds.size > 0) {
        const picked = boardRef.current.items.filter((it) => selectedIds.has(it.id));
        if (action === 'cut' && !deleteItemsIfAllowed(picked.map((it) => it.id))) return;
        clipboardRef.current = picked.map((it) => ({ ...it }));
        setToast({ msg: t('copy.done', { n: picked.length }), type: 'info' });
      }
      if (action === 'paste' && clipboardRef.current?.length) {
        duplicateItems(clipboardRef.current);
      }
      if (action === 'duplicate' && selectedIds.size > 0) {
        const picked = boardRef.current.items.filter((it) => selectedIds.has(it.id));
        duplicateItems(picked);
      }
      if (action === 'selectAll') {
        setSelectedIds(new Set(boardRef.current.items.map((it) => it.id)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    nameModalOpen, commentsOpenReadable, selectedIds, deleteItemsIfAllowed, duplicateItems, doUndo, doRedo,
    fitToContent, fitToSelection, zoomBy, resetZoom,
    bringToFront, sendToBack, bringForward, sendBackward,
    stopFollowing,
  ]);

  /* ============================================================
     Image import (paste + drop)
     ============================================================ */
  useEffect(() => {
    const onPaste = async (e) => {
      if (commentsOpenReadable) return;
      if (focusedTextIdRef.current) return; // let inputs handle paste
      const items = e.clipboardData?.items || [];
      for (const it of items) {
        if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
          const blob = it.getAsFile();
          if (!blob) continue;
          if (!requireEdit()) return;
          e.preventDefault();
          const rect = canvasRef.current?.getBoundingClientRect();
          const center = rect ? screenToWorld(rect.width / 2, rect.height / 2) : { x: 0, y: 0 };
          await importImageFromBlob(blob, center.x, center.y);
          return;
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [commentsOpenReadable, importImageFromBlob, screenToWorld, requireEdit]);

  const onCanvasDragOver = useCallback((e) => {
    allowCanvasFileDrop(e);
    const point = dragClientPoint(e);
    if (point && (point.x !== 0 || point.y !== 0)) fileDragPointRef.current = point;
  }, []);

  const onCanvasDrop = useCallback(async (e) => {
    const imageBlobs = droppedImageBlobs(e.dataTransfer);
    if (!imageBlobs.length) return;
    e.preventDefault();
    if (!requireEdit()) return;
    const clientPoint = resolveDropClientPoint(e, fileDragPointRef.current);
    fileDragPointRef.current = null;
    if (!clientPoint) return;
    const w = clientPointToWorld(
      clientPoint.x,
      clientPoint.y,
      worldMeasureRef.current,
    );
    if (!w) return;
    for (const blob of imageBlobs) {
      // eslint-disable-next-line no-await-in-loop
      await importImageFromBlob(blob, w.x, w.y);
    }
  }, [importImageFromBlob, requireEdit]);

  const pickImageFile = useCallback(() => {
    if (!requireEdit()) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      const center = rect ? screenToWorld(rect.width / 2, rect.height / 2) : { x: 0, y: 0 };
      await importImageFromBlob(f, center.x, center.y);
    };
    input.click();
  }, [importImageFromBlob, requireEdit, screenToWorld]);

  /* ============================================================
     Live editing: focus the field and merge every keystroke through Y.Text.
     ============================================================ */
  const canEditItem = useCallback((it) => {
    return !!it && editingAllowed;
  }, [editingAllowed]);

  const beginFocus = useCallback((it, fieldKey = 'text') => {
    if (!canEditItem(it)) {
      setToast({ msg: t('common.warnEditing'), type: 'warn' });
      return;
    }
    setSelectedId(it.id);
    updateFocusedText(`${it.id}:${fieldKey}`);
    setTimeout(() => {
      const el = editAreaRef.current;
      if (el) {
        el.focus();
        // Place cursor at end
        if (typeof el.value === 'string') el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 10);
  }, [canEditItem, setSelectedId, updateFocusedText]);

  const onTextChange = useCallback((id, patch, opts) => {
    const boundedPatch = { ...patch };
    if (typeof boundedPatch.text === 'string') {
      boundedPatch.text = boundedPatch.text.slice(0, BOARD_TEXT_MAX_LENGTH);
    }
    if (typeof boundedPatch.title === 'string') {
      boundedPatch.title = boundedPatch.title.slice(0, ZONE_TITLE_MAX_LENGTH);
    }
    updateItem(id, boundedPatch, opts);
  }, [updateItem]);

  const onTextBlur = useCallback((id) => {
    if (focusedTextIdRef.current?.startsWith(`${id}:`)) updateFocusedText(null);
    const it = boardRef.current.items.find((i) => i.id === id);
    if (it && (it.type === 'sticky' || it.type === 'text') && !(it.text || '').trim()) {
      deleteItemsIfAllowed([id]);
    }
  }, [deleteItemsIfAllowed, updateFocusedText]);

  const onTextKeyDown = useCallback((e, opts = {}) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Enter' && !e.shiftKey && opts.singleLine) {
      e.preventDefault();
      e.currentTarget.blur();
    }
  }, []);

  /* ============================================================
     Admin actions
     ============================================================ */
  const adminToggle = useCallback((key) => {
    if (!isAdmin) { setToast({ msg: t('common.adminOnly'), type: 'warn' }); return; }
    // patchMeta writes the single flipped flag immediately — no debounce window
    // for applyRemoteBoard to re-spread DEFAULT_BOARD over the local toggle.
    patchMeta({ [key]: !boardRef.current[key] });
  }, [isAdmin, patchMeta]);

  const adminStartTimer = useCallback((zoneId, minutes, voteLimit, hideResults, showNonVoters) => {
    if (!isAdmin) return;
    const items = boardRef.current.items;
    const rootZone = items.find((i) => i.id === zoneId && i.type === 'zone');
    if (!rootZone) return;
    const nowMs = Date.now();
    // Expired-but-unfinalized timers still block related starts.
    const { relatedActive, capturedIds, staleResultZoneIds } = voteSessionScope(rootZone, items);
    if (relatedActive) {
      setToast({ msg: t('vote.session.relatedActive'), type: 'warn' });
      return;
    }
    const startedAt = nowMs;
    const endsAt = minutes && minutes > 0 ? startedAt + minutes * 60000 : null;
    const limit = voteLimit && voteLimit > 0 ? voteLimit : null;
    const timerPatch = {
      voteTimer: {
        startedAt, endsAt, voteLimit: limit, hideResults: !!hideResults, showNonVoters: !!showNonVoters,
      },
      ...CLEARED_VOTE_RESULTS,
      votingLocked: false,
    };
    try {
      if (window.storage.startVoteSession(zoneId, timerPatch, staleResultZoneIds, capturedIds) !== true) {
        reportWriteFailure();
        return;
      }
    } catch {
      reportWriteFailure();
      return;
    }
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((it) => {
        if (it.id === zoneId) return { ...it, ...timerPatch };
        if (staleResultZoneIds.includes(it.id)) return { ...it, ...CLEARED_VOTE_RESULTS };
        return it;
      }),
    }));
    setTimerSetupZoneId(null);
    setToast({
      msg: t('vote.session.started', {
        limit: limit ? t('vote.session.votesLimit', { n: limit }) : t('vote.session.unlimited'),
        time: minutes ? t('vote.session.minutes', { n: minutes }) : t('vote.session.noTime'),
      }),
      type: 'info',
    });
  }, [isAdmin, t, reportWriteFailure]);

  const adminExtendTimer = useCallback((zoneId, minutes) => {
    if (!isAdmin) return;
    const zone = boardRef.current.items.find((i) => i.id === zoneId && i.type === 'zone');
    if (!zone?.voteTimer) return;
    updateItem(zoneId, { voteTimer: { ...zone.voteTimer, endsAt: extendedDeadline(zone.voteTimer.endsAt, Date.now(), minutes) } });
  }, [isAdmin, updateItem]);

  const adminStopTimer = useCallback((zoneId) => {
    if (!isAdmin) return;
    const zone = boardRef.current.items.find((i) => i.id === zoneId && i.type === 'zone');
    if (!zone?.voteTimer) return;
    finalizeVotingSession(zoneId);
  }, [isAdmin, finalizeVotingSession]);

  const adminClearBoard = useCallback(() => {
    if (!isAdmin) return;
    window.storage?.clearAllVotes?.();
    window.storage?.clearAllComments?.();
    // Full replace: drop every item, reset session meta, preserve admin identity.
    if (!replaceBoardLocal({
      ...boardRef.current,
      items: [],
      timer: null,
      lastResultsAt: null,
      allRevealed: false,
      votingLocked: false,
      editingLocked: false,
      phase: null, moodCheck: null,
    })) return;
    setConfirmClear(false);
  }, [isAdmin, replaceBoardLocal]);

  const adminResetVotes = useCallback(() => {
    if (!isAdmin) return;
    // Votes live in CRDT keys; clearing them re-renders via the vote subscription.
    window.storage?.clearAllVotes?.();
    const zoneEntries = resetVoteSessionEntries(boardRef.current.items);
    if (zoneEntries.length) {
      if (!storage.updateItems(zoneEntries)) { reportWriteFailure(); return; }
      const patchById = new Map(zoneEntries.map((entry) => [entry.id, entry.patch]));
      setBoard((prev) => ({
        ...prev,
        items: prev.items.map((it) => (
          patchById.has(it.id) ? { ...it, ...patchById.get(it.id) } : it
        )),
      }));
    }
    patchMeta({ lastResultsAt: null });
    setConfirmResetVotes(false);
    setToast({ msg: t('reset.done'), type: 'info' });
  }, [isAdmin, patchMeta, reportWriteFailure]);

  // Clears every protective flag on the board in one go: per-zone locks,
  // per-sticky privacy, and the board-wide edit lock. A durable reset (not a
  // display-only override like "reveal all cards") so the objects stay
  // unlocked/public after a reload, not just for the current view.
  const adminUnlockAll = useCallback(() => {
    if (!isAdmin) return;
    const entries = boardRef.current.items
      .filter((i) => (i.type === 'zone' && i.locked) || (i.type === 'sticky' && i.private))
      .map((i) => ({ id: i.id, patch: i.type === 'zone' ? { locked: false } : { private: false } }));
    if (entries.length) {
      if (!storage.updateItems(entries)) { reportWriteFailure(); return; }
      const patchById = new Map(entries.map((entry) => [entry.id, entry.patch]));
      setBoard((prev) => ({
        ...prev,
        items: prev.items.map((it) => (
          patchById.has(it.id) ? { ...it, ...patchById.get(it.id) } : it
        )),
      }));
    }
    patchMeta({ editingLocked: false });
    setConfirmUnlockAll(false);
    setToast({ msg: t('unlockAll.done'), type: 'info' });
  }, [isAdmin, patchMeta, reportWriteFailure]);

  /* ----- Export / Import ----- */
  const boardExports = useBoardExports({ boardRef, boardCode, userId, setToast });
  const actionItems = useActionItems({ items: board.items, userId, allRevealed: board.allRevealed });

  const fileInputRef = useRef(null);
  const [pendingImport, setPendingImport] = useState(null); // normalized manifest awaiting confirmation
  const [importBusy, setImportBusy] = useState(false); // sanitizing legacy images before write
  const [helpOpen, setHelpOpen] = useState(false);

  const onImportPick = useOnImportPick({ isAdmin, fileInputRef, setToast, setPendingImport, pendingImport, importBusy, setImportBusy, boardRef, setBoard }, [isAdmin]);

  const onImportFileChange = useOnImportFileChange({ isAdmin, fileInputRef, setToast, setPendingImport, pendingImport, importBusy, setImportBusy, boardRef, setBoard }, []);

  const confirmImport = useConfirmImport({ isAdmin, fileInputRef, setToast, setPendingImport, pendingImport, importBusy, setImportBusy, boardRef, setBoard }, [pendingImport, isAdmin, importBusy]);

  /* ============================================================
     Rendering helpers
     ============================================================ */

  const zoneHeaderActions = useZoneHeaderActions({ isAdmin, boardRef, canModifyOwnedItem, canDeleteItem,
    updateFocusedText, setTimerSetupZoneId, adminStopTimer, adminStartTimer, updateItem,
    exportZoneCsv: boardExports.exportCsv, openSaveTemplate, bringToFront, sendToBack, deleteItemsIfAllowed });
  const retroPhase = useRetroPhase({ mode, isAdmin, board, now, patchMeta, adminToggle, zoneActions: zoneHeaderActions,
    fitToItems, showActionItems: actionItems.show });
  const stackPhase = retroPhase.bar && { bar: retroPhase.bar, onShortcut: retroPhase.runShortcut, onAdvance: retroPhase.advance };
  const mood = useMoodCheck({ mode, isAdmin, userId, moodCheck: board.moodCheck, patchMeta, storage: window.storage, newRoundId: uid });
  const stackMood = (mood.banner || mood.result) && { banner: mood.banner, result: mood.result,
    onReopen: mood.reopen, onClose: mood.close, onDismiss: mood.dismissResult };
  const stackHeightPx = topStackHeightPx({ bannerCount: [stackFollow, stackPresenter, stackPhase, mood.banner].filter(Boolean).length,
    timerCount: stackTimers.length });
  const renderZone = (it) => (
    <ZoneCard mode={mode} zoom={viewport.zoom}
      key={it.id}
      item={it}
      selected={selectedIds.has(it.id)}
      isEditingTitle={focusedTextId === `${it.id}:title`}
      TextEditor={CollaborativeTextEditor}
      childCount={zoneChildCount.get(it.id) || 0}
      isAdmin={isAdmin}
      revealed={zoneEffectiveRevealed(it, board.items, board.allRevealed)}
      hasVoteTimer={!!it.voteTimer}
      actions={zoneHeaderActions}
      canEdit={canModifyOwnedItem(it)} canDelete={canDeleteItem(it)}
      timerSetupOpen={timerSetupZoneId === it.id}
      nestedZoneCount={timerSetupZoneId === it.id ? nestedZoneCount(it, board.items) : 0}
      lang={lang}
      onStartZoneDrag={startZoneDrag}
      onBeginFocus={beginFocus}
      onTextChange={onTextChange}
      onTextKeyDown={onTextKeyDown}
      onTextBlur={onTextBlur}
      editAreaRef={editAreaRef}
    />
  );

  const renderText = (it) => (
    <TextCard
      key={it.id}
      item={it}
      selected={selectedIds.has(it.id) && !remoteSelectorsByItem.has(it.id)}
      remoteSelected={remoteSelectorsByItem.has(it.id)}
      remoteSelectionHue={hueFromId(remoteSelectorsByItem.get(it.id)?.userId || '')}
      isEditing={focusedTextId === `${it.id}:text`}
      lang={lang}
      onStartDrag={startItemDrag}
      onBeginFocus={beginFocus}
      onTextChange={onTextChange}
      onTextKeyDown={onTextKeyDown}
      onTextBlur={onTextBlur}
      editAreaRef={editAreaRef}
    />
  );

  const stickyCardContext = useMemo(() => ({
    selectedIds, remoteSelectorsByItem, focusedTextId, userId, stickyVotingContext,
    allRevealed: board.allRevealed, denseRender, didUserVoteOn, voteCountOf, voteFlashes,
    topVotedRanks, commentCountOf, commentPreviewsByItem, lang, startItemDrag, beginFocus,
    onTextChange, onTextKeyDown, onTextBlur, toggleVote, openComments, editAreaRef,
  }), [selectedIds, remoteSelectorsByItem, focusedTextId, userId, stickyVotingContext,
    board.allRevealed, denseRender, didUserVoteOn, voteCountOf, voteFlashes,
    topVotedRanks, commentCountOf, commentPreviewsByItem, lang, startItemDrag, beginFocus,
    onTextChange, onTextKeyDown, onTextBlur, toggleVote, openComments]);

  /* ============================================================
     Action toolbar (screen space, above selected item)
     ============================================================ */
  const selectedItem = useMemo(
    () => board.items.find((i) => i.id === selectedId) || null,
    [board.items, selectedId],
  );

  // Union bounding box of multi-selection (used for group move/resize handles).
  const groupBBox = useMemo(() => {
    if (selectedIds.size < 2) return null;
    const items = board.items.filter((it) => selectedIds.has(it.id));
    if (!items.length) return null;
    let minX = Infinity; let minY = Infinity;
    let maxX = -Infinity; let maxY = -Infinity;
    items.forEach((it) => {
      const { w, h } = sizeForGroupBounds(it);
      if (it.x < minX) minX = it.x;
      if (it.y < minY) minY = it.y;
      if (it.x + w > maxX) maxX = it.x + w;
      if (it.y + h > maxY) maxY = it.y + h;
    });
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }, [board.items, selectedIds]);

  const renderImage = (it) => (
    <ImageCard
      key={it.id}
      item={it}
      selected={selectedIds.has(it.id) && !remoteSelectorsByItem.has(it.id)}
      remoteSelected={remoteSelectorsByItem.has(it.id)}
      remoteSelectionHue={hueFromId(remoteSelectorsByItem.get(it.id)?.userId || '')}
      dense={denseRender}
      onStartDrag={startItemDrag} zoom={viewport.zoom} viewportSize={viewportSize}
    />
  );

  // Memoize the rendered children list so pan/zoom (which only touch viewport)
  // don't rebuild the JSX tree for every card. Deps cover everything renderXxx
  // closes over; if none of those change, React reuses the same element array
  // and skips reconciliation entirely for the cards.
  const renderedItems = useMemo(
    () => <BoardRasterLayer items={sortedItems} detailedIds={stickyDetails} compact={compactRender} dense={denseRender} selectedIds={selectedIds}
      remoteSelectors={remoteSelectorsByItem} focusedTextId={focusedTextId} contexts={stickyVotingContext}
      allRevealed={board.allRevealed} userId={userId} winners={topVotedRanks} lang={lang}>{visibleItems.map((it) => {
      if (it.type === 'image') return renderImage(it);
      if (it.type === 'zone') return renderZone(it);
      if (it.type === 'text') return renderText(it);
      return <BoardStickyCard key={it.id} item={it} context={stickyCardContext}
        compact={usesCompactStickyPaint(it.id, compactRender, stickyDetails)} />;
    })}</BoardRasterLayer>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      visibleItems, sortedItems,
      selectedIds,
      remoteSelectorsByItem,
      focusedTextId,
      votesByItem,
      commentsByItem,
      commentPreviewsByItem,
      voteFlashes,
      topVotedRanks,
      stickyVotingContext,
      userId,
      denseRender, viewport.zoom, viewportSize,
      compactRender, stickyDetails, stickyCardContext,
      lang,
      zoneChildCount, isAdmin, board.items, board.allRevealed, zoneHeaderActions,
      canModifyOwnedItem, canDeleteItem, timerSetupZoneId,
      startItemDrag,
      startZoneDrag,
      beginFocus,
      onTextChange,
      onTextKeyDown,
      onTextBlur,
      toggleVote,
      openComments,
    ],
  );

  const renderGroupSelectionToolbar = (viewport) => {
    const lockedCount = board.items.reduce((count, item) => (
      selectedIds.has(item.id) && item.locked ? count + 1 : count
    ), 0);
    return (
      <GroupSelectionToolbar mode={mode}
        anchor={groupSelectionToolbarAnchor(groupBBox, viewport, stackHeightPx)}
        lockedCount={lockedCount}
        zoneCount={selectedZoneCount}
        onSaveTemplate={saveSelectedTemplate}
        canUnlock={editingAllowed && lockedCount > 0}
        onUnlockAll={unlockSelectedItems}
      />
    );
  };

  const renderActionToolbar = () => {
    if (focusedTextId) return null;
    const viewport = viewportRef.current;
    if (groupBBox && selectedIds.size > 1) return renderGroupSelectionToolbar(viewport);
    if (!selectedItem || selectedItem.type === 'zone') return null;
    const can = canModifyOwnedItem(selectedItem);
    const canDelete = canDeleteItem(selectedItem);
    return (
      <SelectionToolbar mode={mode}
        anchor={selectionToolbarAnchor(selectedItem, viewport, stackHeightPx)}
        item={{
          type: selectedItem.type, colorIndex: selectedItem.color,
          fontSize: selectedItem.fontSize, fontColor: selectedItem.fontColor,
          private: selectedItem.private, locked: selectedItem.locked, actionItem: selectedItem.actionItem,
        }}
        can={can}
        canDelete={canDelete}
        onEditDrawing={isEditableDrawingImage(selectedItem) ? () => drawingSession.edit(selectedItem) : undefined}
        onColor={(index) => can && updateItem(selectedItem.id, { color: index })}
        onFontSize={(fontSize) => can && updateItem(selectedItem.id, { fontSize })}
        onFontColor={(fontColor) => updateItem(selectedItem.id, { fontColor })}
        onTogglePrivate={() => can && updateItem(selectedItem.id, { private: !selectedItem.private })}
        onToggleAction={() => can && updateItem(selectedItem.id, actionTogglePatch(selectedItem))}
        onBringToFront={() => can && bringToFront(new Set([selectedItem.id]))}
        onSendToBack={() => can && sendToBack(new Set([selectedItem.id]))}
        onDelete={() => deleteItemsIfAllowed([selectedItem.id])}
      />
    );
  };

  const renderResizeHandles = () => {
    if (focusedTextId) return null;
    const v = viewportRef.current;

    // Group selection: draw bbox outline + corner handles that scale all items.
    if (groupBBox && selectedIds.size > 1) {
      const { x, y, w, h } = groupBBox;
      const corners = [
        { k: 'nw', sx: x,     sy: y,     cursor: 'nwse-resize' },
        { k: 'ne', sx: x + w, sy: y,     cursor: 'nesw-resize' },
        { k: 'sw', sx: x,     sy: y + h, cursor: 'nesw-resize' },
        { k: 'se', sx: x + w, sy: y + h, cursor: 'nwse-resize' },
      ];
      return (
        <>
          <div
            data-selection-bounds="true"
            style={{
              position: 'fixed',
              left: x * v.zoom + v.x,
              top: y * v.zoom + v.y,
              width: w * v.zoom,
              height: h * v.zoom,
              border: '2px dashed #2563eb',
              borderRadius: 'var(--radius-selection-outline)',
              pointerEvents: 'none',
              zIndex: Z.SELECTION_OUTLINE,
            }}
          />
          {corners.map((c) => (
            <div
              key={c.k}
              data-mobile-resize="true" data-selection-corner={c.k}
              onMouseDown={(e) => startGroupResize(e, c.k)}
              style={{
                position: 'fixed',
                left: c.sx * v.zoom + v.x,
                top: c.sy * v.zoom + v.y,
                width: 'var(--rb-resize-target-px, 14px)', height: 'var(--rb-resize-target-px, 14px)',
                transform: 'translate(-50%, -50%)', touchAction: 'none',
                background: 'var(--rb-resize-bg, var(--bg-panel))',
                border: 'var(--rb-resize-border, 2px solid #2563eb)',
                borderRadius: 'var(--radius-round)',
                cursor: c.cursor,
                zIndex: Z.SELECTION_HANDLE,
              }}
            />
          ))}
        </>
      );
    }

    if (!selectedItem) return null;
    if (selectedItem.type === 'zone' && selectedItem.locked) return null;
    const resizable = selectedItem.type === 'zone' || selectedItem.type === 'sticky' || selectedItem.type === 'image' || selectedItem.type === 'text';
    if (!resizable) return null;
    const { w, h } = sizeForResize(selectedItem);
    const corners = [
      { k: 'nw', sx: selectedItem.x,     sy: selectedItem.y,     cursor: 'nwse-resize' },
      { k: 'ne', sx: selectedItem.x + w, sy: selectedItem.y,     cursor: 'nesw-resize' },
      { k: 'sw', sx: selectedItem.x,     sy: selectedItem.y + h, cursor: 'nesw-resize' },
      { k: 'se', sx: selectedItem.x + w, sy: selectedItem.y + h, cursor: 'nwse-resize' },
    ];
    return corners.map((c) => (
      <div
        key={c.k}
        data-mobile-resize="true" data-selection-corner={c.k}
        onMouseDown={(e) => startItemResize(e, selectedItem, c.k)}
        style={{
          position: 'fixed',
          left: c.sx * v.zoom + v.x,
          top: c.sy * v.zoom + v.y,
          width: 'var(--rb-resize-target-px, 14px)', height: 'var(--rb-resize-target-px, 14px)',
          transform: 'translate(-50%, -50%)', touchAction: 'none',
          background: 'var(--rb-resize-bg, var(--bg-panel))',
          border: 'var(--rb-resize-border, 2px solid #2563eb)',
          borderRadius: 'var(--radius-round)',
          cursor: c.cursor,
          zIndex: Z.SELECTION_HANDLE,
        }}
      />
    ));
  };

  /* ============================================================
     Top bar / floating UI
     ============================================================ */
  const copyRoomLink = async () => {
    const share = shareLinkModel(window.location.origin, boardCode, boardToken);
    if (await copyTextToClipboard(navigator.clipboard, share.url)) {
      setToast({ msg: t('topbar.copied'), type: 'info' });
    } else {
      setToast({ msg: t('topbar.shareLink', { code: share.manualCode }), type: 'info', sticky: true });
    }
  };
  const topbarProps = useTopBarProps({
    boardState: { board, undoState },
    session: { mode, boardCode, isAdmin, canClaim, userId, userName },
    collaboration: { presence, onlineUsers, followedUserId, votesUsedByUser, activeZoneVoteLimit },
    appearance: { themePref, setThemePref, scrollWheelZoomEnabled, toggleScrollWheelZoom },
    workflow: { presenter, retroPhase, mood, boardExports, actionItems },
    actions: { setToast, copyRoomLink, doUndo, doRedo, adminToggle, adminClaim, setNameDraft, setNameModalOpen, onImportPick, setHelpOpen, setConfirmUnlockAll, setConfirmResetVotes, setConfirmClear, requirePrivateAdminPin, adminTransfer, startFollowing, stopFollowing },
  });

  const renderMinimap = () => (
    <MinimapPanel
      panelRef={minimapPanelRef}
      viewportRef={minimapViewportRef}
      model={minimapModel}
      colors={PALETTE}
      onReveal={revealMinimap}
      onNavigatePointerDown={startMinimapNavigation}
      onNavigateKeyDown={onMinimapKeyDown}
    />
  );

  const createAtViewportCenter = (create) => {
    if (!requireEdit() || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const world = screenToWorld(rect.width / 2, rect.height / 2);
    create(world.x, world.y);
  };
  const armPlacementTool = (tool) => {
    if (!requireEdit()) return;
    setCreationMode((mode) => toggleCreationMode(mode, tool));
    setSelectedIds(new Set());
  };
  const toolHandlers = {
    [TOOL_ID.SELECT]: () => {
      setCreationMode((mode) => (mode === TOOL_ID.SELECT ? null : TOOL_ID.SELECT));
      setSelectedIds(new Set());
    },
    [TOOL_ID.TEXT]: () => armPlacementTool(TOOL_ID.TEXT),
    [TOOL_ID.ZONE]: () => armPlacementTool(TOOL_ID.ZONE),
    [TOOL_ID.IMAGE]: pickImageFile,
    [TOOL_ID.DRAW]: drawingSession.toggle,
  };
  shortcutToolHandlersRef.current = {
    selectTool: toolHandlers[TOOL_ID.SELECT], textTool: toolHandlers[TOOL_ID.TEXT],
    zoneTool: toolHandlers[TOOL_ID.ZONE], drawTool: toolHandlers[TOOL_ID.DRAW],
    imageTool: toolHandlers[TOOL_ID.IMAGE], stickyTool: () => createAtViewportCenter(addSticky),
  };

  useEffect(() => {
    if (!loaded || !boardRootRef.current || !canvasRef.current) return undefined;
    return attachMobileGestures(boardRootRef.current, {
      getViewport: () => viewportRef.current,
      beginGesture: () => {
        window.storage?.stopUndoCapture?.();
        stopFollowing(); settleWheelBeforeInteraction();
      },
      endGesture: () => window.storage?.stopUndoCapture?.(),
      cancelGesture: () => {
        activeGeometryFinalizerRef.current?.();
        activeViewportFinalizerRef.current?.();
      },
      applyViewport: liveApplyViewport,
      commitViewport: commitViewportImmediately,
    }, { canvas: canvasRef.current });
  }, [loaded, stopFollowing, settleWheelBeforeInteraction, liveApplyViewport, commitViewportImmediately]);

  useEffect(() => {
    if (!loaded || !boardRootRef.current) return undefined;
    return attachMobileEditorViewport(boardRootRef.current, {
      getViewport: () => viewportRef.current,
      commitViewport: (next) => {
        stopFollowing(); settleWheelBeforeInteraction();
        commitViewportImmediately(next);
      },
    });
  }, [loaded, stopFollowing, settleWheelBeforeInteraction, commitViewportImmediately]);

  /* ============================================================
     Render
     ============================================================ */

  if (!loaded) return <BoardLoading />;

  return (
    <div
      ref={boardRootRef}
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: 'fixed', inset: 0, overflow: 'clip', fontFamily: 'var(--font-ui)' }}
    >
      <BoardCanvasStyles />

      {/* Grid background (screen-space, behind everything). Texture and
          compositor transform are applied only imperatively (see
          applyViewportToDom) so a render mid-gesture cannot reset them. */}
      <div
        ref={gridRef}
        style={{
          position: 'absolute', inset: 0, zIndex: Z.GRID,
          backgroundColor: 'var(--bg)',
        }}
      />

      {/* Canvas surface */}
      <div
        ref={canvasRef}
        onMouseDownCapture={onCanvasMouseDownCapture}
        onMouseDown={onCanvasMouseDown}
        onDoubleClick={onCanvasDoubleClick}
        onPointerMove={onCanvasPointerActivity}
        onPointerLeave={clearLocalCursor}
        onPointerCancel={clearLocalCursor}
        onDragOver={onCanvasDragOver}
        onDrop={onCanvasDrop}
        className="rb-no-select"
        style={{
          position: 'absolute', inset: 0, zIndex: Z.CANVAS,
          touchAction: focusedTextId ? 'pan-y' : 'none',
          cursor: canvasCursor(interactionRef.current?.kind, spaceHeldRef.current, creationMode),
        }}
      >
        {/* Transformed world — transform applied imperatively (see
            applyViewportToDom) so pan/zoom skip React reconciliation. */}
        <div
          ref={worldRef} {...worldMotionProps(denseRender)}
          style={{
            position: 'absolute', top: 0, left: 0,
            transformOrigin: '0 0',
          }}
        >
          {/* A fixed-size, invisible world-space ruler. Its rendered rect lets
              external file drops invert the browser's fully-composed transform
              without guessing how CSS/browser zoom affected the canvas. */}
          <div
            ref={worldMeasureRef}
            aria-hidden="true"
            style={{
              position: 'absolute', left: 0, top: 0,
              width: 100, height: 100,
              opacity: 0, pointerEvents: 'none',
            }}
          />
          {renderedItems}
          <LiveDrawingPreviews />

          <RemoteCollaborationLabels selectionLabels={selectionLabels} editingIndicators={editingIndicators} viewport={viewport} />

          {/* Zone-creation preview */}
          <ZonePreview zonePreview={zonePreview} />
        </div>

        {/* Empty hint */}
        <EmptyCanvasHint itemCount={board.items.length} creationMode={creationMode} />
      </div>

      <RemoteCursorLayer cursorLayerRef={cursorLayerRef} viewportRef={viewportRef} playerCursors={playerCursors} />

      {/* Floating UI */}
      <input ref={fileInputRef} type="file" accept="application/zip,.zip,application/json,.json,text/csv,.csv"
        onChange={onImportFileChange} style={{ display: 'none' }} />
      <TopBar {...topbarProps} />
      <TopCenterStack
        board={board} userId={userId} roomHandle={window.storage.getRoomHandle?.()} now={now}
        follow={stackFollow} presenter={stackPresenter} phase={stackPhase} mood={stackMood}
        timers={stackTimers}
        votesUsed={votesUsed}
        isAdmin={isAdmin}
        onStopFollowing={stopFollowing}
        onExtendTimer={adminExtendTimer}
        onStopTimer={adminStopTimer}
      />
      <ToolDock mode={mode}
        onAddSticky={() => createAtViewportCenter(addSticky)}
        creationMode={creationMode}
        templatesOpen={templatesOpen}
        rows={templateRows(getTemplates(), customTemplates)}
        selectedZoneCount={selectedZoneCount}
        onTool={(toolId) => toolHandlers[toolId]()}
        onTemplatesOpenChange={setTemplatesOpen}
        onApplyTemplate={applyTemplate}
        onDeleteCustomTemplate={deleteCustomTemplate} onRenameCustomTemplate={openRenameTemplate}
        onSaveTemplate={saveSelectedTemplate}
        isAdmin={isAdmin}
      />
      <DrawingTool exitRef={drawingExitRef} active={creationMode === TOOL_ID.DRAW} lang={lang} editingAllowed={editingAllowed} requireEdit={requireEdit}
        viewportRef={viewportRef} boardRef={boardRef} boardCanvasRef={canvasRef} storage={storage} target={drawingSession.target} onUpdateItem={updateItem} onRemoveItem={id => storage.removeItem(id)}
        userId={userId} userName={userName} onAddItem={addItemLocal} onSelectItem={setSelectedId}
        onClose={drawingSession.close} onApplyViewport={liveApplyViewport} onCommitViewport={commitViewportImmediately}
        onBeginGesture={settleWheelBeforeInteraction} onStopFollowing={stopFollowing} />
      <ZoomControls
        percentage={Math.round(viewport.zoom * 100)}
        onZoomOut={() => zoomBy(1 / ZOOM_STEP_FACTOR)}
        onResetZoom={resetZoom}
        onZoomIn={() => zoomBy(ZOOM_STEP_FACTOR)}
        onFitToContent={fitToContent}
      />
      {renderMinimap()}
      <div ref={selectionLayerRef} style={{ display: 'contents' }}
        {...selectionLayerAttributes({ item: selectedItem, groupBBox, selectedCount: selectedIds.size,
          stackHeightPx, editing: Boolean(focusedTextId) })}>
        {renderActionToolbar()}
        {renderResizeHandles()}
      </div>

      {/* Marquee selection box */}
      <MarqueeSelection marquee={marquee} />

      <BoardDialogs
        saveTemplateOpen={saveTemplateOpen}
        closeSaveDialog={closeSaveDialog}
        saveCurrentAsTemplate={saveCurrentAsTemplate}
        templateDraft={templateDraft}
        renameTarget={renameTarget}
        renameCustomTemplate={renameCustomTemplate}
        closeRenameDialog={closeRenameDialog}
        nameModalOpen={nameModalOpen}
        nameDraft={nameDraft}
        setNameDraft={setNameDraft}
        saveName={saveName}
        dismissName={dismissName}
        userName={userName}
        confirmUnlockAll={confirmUnlockAll}
        setConfirmUnlockAll={setConfirmUnlockAll}
        requireAdminPin={requireAdminPin}
        adminUnlockAll={adminUnlockAll}
        confirmResetVotes={confirmResetVotes}
        setConfirmResetVotes={setConfirmResetVotes}
        adminResetVotes={adminResetVotes}
        pendingImport={pendingImport}
        importBusy={importBusy}
        setPendingImport={setPendingImport}
        confirmImport={confirmImport}
        mood={mood}
        actionItems={actionItems}
        canModifyOwnedItem={canModifyOwnedItem}
        items={board.items}
        updateItem={updateItem}
        setSelectedIds={setSelectedIds}
        fitToItems={fitToItems}
        commentsOpenReadable={commentsOpenReadable}
        commentsOpenItem={commentsOpenItem}
        commentsByItem={commentsByItem}
        editingAllowed={editingAllowed}
        addCommentTo={addCommentTo}
        deleteCommentFrom={deleteCommentFrom}
        setCommentsOpenFor={setCommentsOpenFor}
        helpOpen={helpOpen}
        setHelpOpen={setHelpOpen}
        pinPromptCfg={pinPromptCfg}
        confirmClear={confirmClear}
        setConfirmClear={setConfirmClear}
        adminClearBoard={adminClearBoard}
      />

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
