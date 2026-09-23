// Frontend defense-in-depth helpers for data that crosses a file/Yjs boundary.
// These checks reduce accidental disclosure and client-side resource abuse;
// they are not an authorization boundary for peers that already have a room URL.

export const BOARD_TEXT_MAX_LENGTH = 20_000;
export const ZONE_TITLE_MAX_LENGTH = 500;
export const DISPLAY_NAME_MAX_LENGTH = 120;
export const TEMPLATE_NAME_MAX_LENGTH = 120;

export const IMPORT_COORDINATE_MAX_ABS = 10_000_000;
export const IMPORT_DIMENSION_MAX = 100_000;
export const IMPORT_FONT_SIZE_MAX = 512;
export const IMPORT_MAX_CUSTOM_TEMPLATES = 100;
export const IMPORT_MAX_TEMPLATE_ZONES = 500;
export const IMPORT_MAX_TOTAL_TEMPLATE_ZONES = 2_000;

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_OUTPUT_MAX_DIMENSION = 1200;
export const IMAGE_SOURCE_MAX_DIMENSION = 8192;
export const IMAGE_SOURCE_MAX_PIXELS = 20_000_000;
export const GIF_MAX_DIMENSION = IMAGE_OUTPUT_MAX_DIMENSION;
export const GIF_MAX_PIXELS = GIF_MAX_DIMENSION * GIF_MAX_DIMENSION;
export const GIF_MAX_FRAMES = 120;
export const GIF_MAX_TOTAL_FRAME_PIXELS = 80_000_000;

const SAFE_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
]);
const REENCODE_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/webp',
]);
const IMAGE_FILE_RE_SOURCE = '[a-f0-9-]{8,128}\\.(?:png|jpe?g|webp|gif)';
const SERVER_IMAGE_PATH_RE = new RegExp(
  `^/(?:yjs/)?(?:images/${IMAGE_FILE_RE_SOURCE}|rooms/[A-Za-z0-9_-]{32}/images/${IMAGE_FILE_RE_SOURCE})$`,
  'i',
);
const DATA_IMAGE_PREFIX_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,/i;
const IMAGE_URL_MAX_LENGTH = 2048;
const IMAGE_DATA_URL_MAX_LENGTH = Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 64;

export const isSafeImageMime = (value) => SAFE_IMAGE_MIMES.has(value);
export const shouldReencodeImageMime = (value) => REENCODE_IMAGE_MIMES.has(value);

const base64DecodedLength = (payload) => {
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return -1;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return (payload.length / 4) * 3 - padding;
};

// Accept only legacy base64 raster data URLs or the exact image URL shape
// produced by yjs-server. Runtime code additionally restricts absolute URLs to
// the current page/relay origins before rendering them.
export function classifyImportedImageSource(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const prefix = value.match(DATA_IMAGE_PREFIX_RE);
  if (prefix) {
    if (value.length > IMAGE_DATA_URL_MAX_LENGTH) return null;
    const payload = value.slice(prefix[0].length);
    const byteLength = base64DecodedLength(payload);
    if (byteLength < 1 || byteLength > IMAGE_MAX_BYTES) return null;
    return {
      kind: 'data',
      mime: prefix[1].toLowerCase(),
      payload,
      byteLength,
      source: value,
    };
  }
  if (value.length > IMAGE_URL_MAX_LENGTH) return null;
  if (SERVER_IMAGE_PATH_RE.test(value)) return { kind: 'server', source: value };
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!SERVER_IMAGE_PATH_RE.test(url.pathname)) return null;
  return { kind: 'server', source: url.href };
}

export const isSafeImportedImageSource = (value) => !!classifyImportedImageSource(value);

// Resolve a validated source only against origins the app itself talks to. A
// backup copied from another deployment must re-upload its images; silently
// contacting an arbitrary origin would turn imported boards into tracking pixels.
export function normalizeRuntimeImageSource(value, { pageOrigin, relayBaseUrl, roomHandle } = {}) {
  const source = classifyImportedImageSource(value);
  if (!source) return null;
  if (source.kind === 'data') return source.source;
  let page;
  let relay;
  try {
    page = new URL(pageOrigin);
    relay = new URL(relayBaseUrl);
  } catch {
    return null;
  }
  let url;
  try {
    if (source.source.startsWith('/images/') || source.source.startsWith('/rooms/')) {
      // Production serves relay assets below /yjs/, while local development
      // serves them from the relay origin root. Resolve relative to the full
      // relay base instead of relay.origin so the production prefix survives.
      const base = relay.href.endsWith('/') ? relay.href : `${relay.href}/`;
      url = new URL(source.source.slice(1), base);
    } else {
      url = new URL(source.source, page.origin);
    }
  } catch {
    return null;
  }
  if (url.origin !== page.origin && url.origin !== relay.origin) return null;
  if (!SERVER_IMAGE_PATH_RE.test(url.pathname) || url.search || url.hash) return null;
  const roomImage = url.pathname.match(/^\/(?:yjs\/)?rooms\/([A-Za-z0-9_-]{32})\/images\//);
  if (roomImage && roomImage[1] !== roomHandle) return null;
  return url.href;
}

const readU16BE = (bytes, offset) => (bytes[offset] << 8) | bytes[offset + 1];
const readU16LE = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);
const readU24LE = (bytes, offset) => (
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
);
const readU32BE = (bytes, offset) => (
  bytes[offset] * 0x1000000
  + (bytes[offset + 1] << 16)
  + (bytes[offset + 2] << 8)
  + bytes[offset + 3]
);

const inspectPng = (bytes) => {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return null;
  return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20), frameCount: 1 };
};

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const inspectJpeg = (bytes) => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = readU16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) return null;
      return {
        width: readU16BE(bytes, offset + 5),
        height: readU16BE(bytes, offset + 3),
        frameCount: 1,
      };
    }
    offset += segmentLength;
  }
  return null;
};

const inspectWebp = (bytes) => {
  if (bytes.length < 30
    || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF'
    || String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP') return null;
  const chunk = String.fromCharCode(...bytes.slice(12, 16));
  if (chunk === 'VP8X') {
    return {
      width: readU24LE(bytes, 24) + 1,
      height: readU24LE(bytes, 27) + 1,
      frameCount: 1,
      animated: (bytes[20] & 0x02) !== 0,
    };
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
      frameCount: 1,
    };
  }
  if (chunk === 'VP8 '
    && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: readU16LE(bytes, 26) & 0x3fff,
      height: readU16LE(bytes, 28) & 0x3fff,
      frameCount: 1,
    };
  }
  return null;
};

const skipGifSubBlocks = (bytes, start) => {
  let offset = start;
  while (offset < bytes.length) {
    const size = bytes[offset];
    offset += 1;
    if (size === 0) return offset;
    if (offset + size > bytes.length) return -1;
    offset += size;
  }
  return -1;
};

const inspectGif = (bytes) => {
  if (bytes.length < 14) return null;
  const header = String.fromCharCode(...bytes.slice(0, 6));
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;
  const width = readU16LE(bytes, 6);
  const height = readU16LE(bytes, 8);
  const packed = bytes[10];
  let offset = 13;
  if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
  if (offset >= bytes.length) return null;
  let frameCount = 0;
  let totalFramePixels = 0;
  let hasTrailer = false;
  while (offset < bytes.length) {
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x3b) {
      hasTrailer = true;
      break;
    }
    if (marker === 0x21) {
      if (offset >= bytes.length) return null;
      offset += 1; // extension label
      offset = skipGifSubBlocks(bytes, offset);
      if (offset < 0) return null;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) return null;
    const left = readU16LE(bytes, offset);
    const top = readU16LE(bytes, offset + 2);
    const frameWidth = readU16LE(bytes, offset + 4);
    const frameHeight = readU16LE(bytes, offset + 6);
    const framePacked = bytes[offset + 8];
    offset += 9;
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height) return null;
    frameCount += 1;
    totalFramePixels += frameWidth * frameHeight;
    if (frameCount > GIF_MAX_FRAMES || totalFramePixels > GIF_MAX_TOTAL_FRAME_PIXELS) return null;
    if (framePacked & 0x80) offset += 3 * (2 ** ((framePacked & 0x07) + 1));
    if (offset >= bytes.length) return null;
    offset += 1; // LZW minimum code size
    offset = skipGifSubBlocks(bytes, offset);
    if (offset < 0) return null;
  }
  if (!hasTrailer || frameCount < 1) return null;
  return { width, height, frameCount, totalFramePixels };
};

export function inspectRasterImageBytes(value, mime) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
  let dimensions = null;
  if (mime === 'image/png') dimensions = inspectPng(bytes);
  else if (mime === 'image/jpeg') dimensions = inspectJpeg(bytes);
  else if (mime === 'image/webp') dimensions = inspectWebp(bytes);
  else if (mime === 'image/gif') dimensions = inspectGif(bytes);
  if (!dimensions) return null;
  return { mime, ...dimensions };
}

export async function inspectRasterImageBlob(blob) {
  if (!blob || !isSafeImageMime(blob.type) || blob.size < 1 || blob.size > IMAGE_MAX_BYTES) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return inspectRasterImageBytes(bytes, blob.type);
}

export function imageInfoIsWithinLimits(info) {
  if (!info || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height)) return false;
  if (info.width < 1 || info.height < 1) return false;
  const pixels = info.width * info.height;
  if (!Number.isSafeInteger(pixels)) return false;
  if (info.mime === 'image/gif') {
    return info.width <= GIF_MAX_DIMENSION
      && info.height <= GIF_MAX_DIMENSION
      && pixels <= GIF_MAX_PIXELS
      && Number.isSafeInteger(info.frameCount)
      && info.frameCount >= 1
      && info.frameCount <= GIF_MAX_FRAMES
      && Number.isSafeInteger(info.totalFramePixels)
      && info.totalFramePixels <= GIF_MAX_TOTAL_FRAME_PIXELS;
  }
  return shouldReencodeImageMime(info.mime)
    && info.animated !== true
    && info.width <= IMAGE_SOURCE_MAX_DIMENSION
    && info.height <= IMAGE_SOURCE_MAX_DIMENSION
    && pixels <= IMAGE_SOURCE_MAX_PIXELS;
}

export const stickyTextForDom = (item, hidden) => (
  hidden ? null : (typeof item?.text === 'string' ? item.text : '')
);

// Clone only what needs redaction; do not mutate the live React/Yjs snapshot.
export function redactBoardExportForViewer(items, comments, isHiddenSticky) {
  const hiddenIds = new Set();
  const safeItems = (Array.isArray(items) ? items : []).map((item) => {
    if (!item || item.type !== 'sticky' || !isHiddenSticky(item)) return item;
    hiddenIds.add(item.id);
    return { ...item, text: '' };
  });
  const safeComments = Object.fromEntries(
    Object.entries(comments && typeof comments === 'object' ? comments : {})
      .filter(([itemId]) => !hiddenIds.has(itemId)),
  );
  return { items: safeItems, comments: safeComments };
}
