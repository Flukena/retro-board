export const COMMENT_MAX_LEN = 2000;
export const COMMENT_AUTHOR_NAME_MAX_LEN = 120;
export const COMMENT_ID_MAX_LEN = 128;

const ID_SAFE_RE = /^[A-Za-z0-9_-]+$/;

export const isSafeId = (value) => (
  typeof value === 'string'
  && value.length > 0
  && value.length <= COMMENT_ID_MAX_LEN
  && ID_SAFE_RE.test(value)
);

const boundedString = (value, maxLength) => (
  typeof value === 'string' ? value.slice(0, maxLength) : ''
);

const normalizedTimestamp = (value, fallback) => (
  Number.isSafeInteger(value) && value >= 0 ? value : fallback
);

// Comment values can originate from imported backups or older/hostile peers.
// Keep this normalizer free of browser/Yjs dependencies so every adapter and
// import path can enforce the same shape before data reaches React.
export const normalizeComment = (value, keyId, fallbackCreatedAt = 0) => {
  if (!isSafeId(keyId) || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = typeof value.text === 'string'
    ? value.text.trim().slice(0, COMMENT_MAX_LEN)
    : '';
  if (!text) return null;
  return {
    id: keyId,
    authorId: isSafeId(value.authorId) ? value.authorId : '',
    authorName: boundedString(value.authorName, COMMENT_AUTHOR_NAME_MAX_LEN),
    text,
    createdAt: normalizedTimestamp(value.createdAt, fallbackCreatedAt),
    editedAt: value.editedAt == null ? null : normalizedTimestamp(value.editedAt, null),
  };
};
