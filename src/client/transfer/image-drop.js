export const allowCanvasFileDrop = (event) => {
  // Finder/browser integrations are allowed to hide file details during
  // dragover. Always opt the canvas into receiving the eventual drop, then
  // validate the actual files in droppedImageBlobs once they are available.
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
};

export const dragClientPoint = (event) => {
  const x = Number(event?.clientX ?? event?.x);
  const y = Number(event?.clientY ?? event?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
};

export const resolveDropClientPoint = (dropEvent, lastDragPoint) => {
  const droppedAt = dragClientPoint(dropEvent);
  // Some Finder/browser combinations zero the coordinates on the final drop
  // event. Treat that sentinel as missing and reuse the immediately preceding
  // dragover position, which is the same pointer gesture.
  if (droppedAt && (droppedAt.x !== 0 || droppedAt.y !== 0)) return droppedAt;
  return dragClientPoint(lastDragPoint);
};

const IMAGE_MIME_BY_EXTENSION = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
]);

export const shouldDownscaleImage = (mimeType, maxEdge, maxDimension) => (
  mimeType !== 'image/gif' && maxEdge > maxDimension
);

const imageBlobFromFile = (file) => {
  if (file.type?.startsWith('image/')) return file;
  const extension = String(file.name || '').split('.').pop()?.toLowerCase();
  const inferredType = IMAGE_MIME_BY_EXTENSION.get(extension);
  if (!inferredType || typeof file.slice !== 'function') return null;
  return file.slice(0, file.size, inferredType);
};

export const droppedImageBlobs = (dataTransfer) => (
  Array.from(dataTransfer?.files || [])
    .map(imageBlobFromFile)
    .filter(Boolean)
);
