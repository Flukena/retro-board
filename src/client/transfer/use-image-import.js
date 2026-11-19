import { useCallback } from 'react';
import { IMAGE_MAX_BYTES as MAX_BYTES, isSafeImageMime as safeMime } from '../../domain/security-boundaries.js';
import { IMAGE_MAX_MIB_LABEL as MAX_MIB_LABEL, prepareImageBlob as prepareBlob, canStartImageImport as canStart } from './image-upload.js';
import { t as translate } from '../ui/i18n.js';

export function createController({canStartImageImport = canStart, window = globalThis.window, isSafeImageMime = safeMime, setToast, t = translate, IMAGE_MAX_BYTES = MAX_BYTES, IMAGE_MAX_MIB_LABEL = MAX_MIB_LABEL, prepareImageBlob = prepareBlob, addImage}) {
const importImageFromBlob = async (blob, worldX, worldY) => {
    if (!canStartImageImport(blob, window.storage)) return;
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
      prepared = await prepareImageBlob(blob);
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
      url = await window.storage.uploadImage(prepared.blob);
    } catch {
      setToast({ msg: t('image.uploadFailed'), type: 'warn' });
      return;
    }
    addImage(worldX, worldY, url, prepared.nw, prepared.nh);
  };
return {importImageFromBlob, dispose() {}};
}

export function useImageImport(options, dependencies) {
  return useCallback(createController(options).importImageFromBlob, dependencies);
}
