import { useCallback, useEffect, useMemo, useState } from 'react';
import { TEMPLATE_NAME_MAX_LENGTH } from './security-boundaries.js';
import { t } from './i18n.js';

export const subscribeTemplates = (storage, onSnapshot) => {
  let active = true;
  const refresh = () => {
    if (active) onSnapshot(storage?.snapshotTemplates?.() || []);
  };
  storage?.onTemplatesChange?.(refresh);
  const offSync = storage?.onSynced?.(refresh);
  refresh();
  return () => {
    active = false;
    storage?.offTemplatesChange?.(refresh);
    offSync?.();
  };
};

const currentTemplateZones = (items) => {
  const zones = items.filter((item) => item.type === 'zone');
  if (!zones.length) return [];
  const minX = Math.min(...zones.map((zone) => zone.x));
  const minY = Math.min(...zones.map((zone) => zone.y));
  return zones.map((zone) => ({
    title: zone.title, color: zone.color,
    x: zone.x - minX, y: zone.y - minY, w: zone.w, h: zone.h,
  }));
};

export const createTemplateActions = ({ storage, boardRef, createId, setToast, closeSaveDialog }) => {
  const warn = (key) => setToast({ msg: t(key), type: 'warn' });
  const saveCurrentAsTemplate = (rawName) => {
    const name = (rawName || '').trim().slice(0, TEMPLATE_NAME_MAX_LENGTH);
    if (!name) return;
    const zones = currentTemplateZones(boardRef.current.items);
    if (!zones.length) { warn('tmpl.empty'); return; }
    const saved = storage?.putTemplate?.({ id: createId(), name, zones, createdAt: Date.now() });
    if (!saved) { warn('tmpl.saveFailed'); return; }
    closeSaveDialog();
    setToast({ msg: t('tmpl.saved', { name }), type: 'info' });
  };
  const deleteCustomTemplate = (id) => {
    if (!storage?.removeTemplate?.(id)) warn('tmpl.saveFailed');
  };
  return { saveCurrentAsTemplate, deleteCustomTemplate };
};

export const useBoardTemplates = ({ storage, boardRef, createId, setToast, setSaveTemplateOpen }) => {
  const [customTemplates, setCustomTemplates] = useState(() => storage?.snapshotTemplates?.() || []);
  useEffect(() => subscribeTemplates(storage, setCustomTemplates), [storage]);
  const closeSaveDialog = useCallback(() => setSaveTemplateOpen(false), [setSaveTemplateOpen]);
  const actions = useMemo(() => createTemplateActions({
    storage, boardRef, createId, setToast, closeSaveDialog,
  }), [storage, boardRef, createId, setToast, closeSaveDialog]);
  return { customTemplates, ...actions };
};
