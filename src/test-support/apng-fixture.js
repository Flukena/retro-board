// Real PNG bytes with the APNG animation chunks (acTL, fcTL, fdAT) spliced in
// after IHDR, the way an animated PNG is laid out. CRCs are not checked by the
// inspector, so the filler chunk payloads are zeroed.
const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
const PNG_IHDR_END_BYTES = 33;
const CHUNK_OVERHEAD_BYTES = 12;
const CHUNK_TYPE_OFFSET_BYTES = 4;
const CHUNK_DATA_BYTES = 8;
const ANIMATION_CHUNK_TYPES = ['acTL', 'fcTL', 'fdAT'];

const chunk = (type) => {
  const bytes = Buffer.alloc(CHUNK_OVERHEAD_BYTES + CHUNK_DATA_BYTES);
  bytes.writeUInt32BE(CHUNK_DATA_BYTES);
  bytes.write(type, CHUNK_TYPE_OFFSET_BYTES);
  return bytes;
};

export const STILL_PNG_BYTES = Buffer.from(PNG_1X1_BASE64, 'base64');

export const apngBytes = () => Buffer.concat([
  STILL_PNG_BYTES.subarray(0, PNG_IHDR_END_BYTES),
  ...ANIMATION_CHUNK_TYPES.map(chunk),
  STILL_PNG_BYTES.subarray(PNG_IHDR_END_BYTES),
]);

export const apngBlob = () => new Blob([apngBytes()], { type: 'image/png' });
export const stillPngBlob = () => new Blob([STILL_PNG_BYTES], { type: 'image/png' });
