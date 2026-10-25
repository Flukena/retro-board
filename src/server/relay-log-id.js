import { createHmac, randomBytes } from 'crypto';

const ROOM_LOG_KEY_BYTES = 32;
const ROOM_LOG_ID_HEX_CHARACTERS = 12;
const ROOM_LOG_KEY = randomBytes(ROOM_LOG_KEY_BYTES);
export const roomLogId = (docName) => createHmac('sha256', ROOM_LOG_KEY)
  .update(String(docName))
  .digest('hex')
  .slice(0, ROOM_LOG_ID_HEX_CHARACTERS);
