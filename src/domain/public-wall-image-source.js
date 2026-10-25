import { PUBLIC_RELAY_PREFIX } from './public-wall-contract.js';

const IMAGE_SOURCE_MAX_CHARACTERS = 2_048;
const PUBLIC_IMAGE_PATH = /^\/(?:yjs-public\/)?rooms\/([A-Za-z0-9_-]{32})\/images\/[a-f0-9-]{8,128}\.(?:png|jpe?g|webp|gif)$/;
const ABSOLUTE_HTTP_IMAGE = /^https?:\/\/[^/?#]+(\/[^?#]*)$/i;
const AMBIGUOUS_URL_CHARACTERS = /[\s\\%]/;

export function canonicalPublicImageSource(value, roomHandle) {
  if (typeof value !== 'string' || value.length > IMAGE_SOURCE_MAX_CHARACTERS
    || AMBIGUOUS_URL_CHARACTERS.test(value)) return null;
  let path = value;
  if (!value.startsWith('/')) {
    const absolute = value.match(ABSOLUTE_HTTP_IMAGE);
    if (!absolute || !URL.canParse(value)) return null;
    const url = new URL(value);
    if (url.username || url.password) return null;
    path = absolute[1];
  }
  const match = path.match(PUBLIC_IMAGE_PATH);
  if (!match || (roomHandle !== undefined && match[1] !== roomHandle)) return null;
  const roomPath = path.startsWith(`${PUBLIC_RELAY_PREFIX}/`) ? path.slice(PUBLIC_RELAY_PREFIX.length) : path;
  return `${PUBLIC_RELAY_PREFIX}${roomPath}`;
}
