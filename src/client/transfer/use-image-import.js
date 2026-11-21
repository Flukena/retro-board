import { useCallback } from 'react';
import { IMAGE_MAX_BYTES, isSafeImageMime } from '../../domain/security-boundaries.js';
import { IMAGE_MAX_MIB_LABEL, prepareImageBlob, canStartImageImport } from './image-upload.js';
import { t as translate } from '../ui/i18n.js';

export function createImageImport({
  view = globalThis.window, setToast, t = translate, prepareImage = prepareImageBlob, addImage,
}) {
  const importImageFromBlob = async (blob, worldX, worldY) => {
    if (!canStartImageImport(blob, view.storage)) return;
    if (!isSafeImageMime(blob.type)) {
      setToast({ msg: t('image.unsupportedFormat'), type: 'warn' });
      return;
    }
    if (blob.size > IMAGE_MAX_BYTES) {
      setToast({
        msg: t('image.tooLarge', { mb: IMAGE_MAX_MIB_LABEL }),
        type: 'warn',
      });
      return;
    }
    let prepared;
    try {
      prepared = await prepareImage(blob);
    } catch {
      prepared = null;
    }
    if (!prepared) {
      setToast({
        msg: t('image.tooLarge', { mb: IMAGE_MAX_MIB_LABEL }),
        type: 'warn',
      });
      return;
    }
    let url;
    try {
      url = await view.storage.uploadImage(prepared.blob);
    } catch {
      setToast({ msg: t('image.uploadFailed'), type: 'warn' });
      return;
    }
    addImage(worldX, worldY, url, prepared.nw, prepared.nh);
  };
  return { importImageFromBlob };
}

export function useImageImport(options, dependencies) {
  return useCallback(createImageImport(options).importImageFromBlob, dependencies);
}
