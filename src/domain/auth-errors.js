// Sign-in failure codes the relay puts in `?auth_error=` and the client turns
// into translated messages. Only these values ever cross that boundary.
export const AUTH_ERROR = Object.freeze({
  STATE_MISMATCH: 'state_mismatch',
  ACCESS_DENIED: 'access_denied',
  PROVIDER_ERROR: 'provider_error',
  TOKEN_EXCHANGE_FAILED: 'token_exchange_failed',
  INVALID_ID_TOKEN: 'invalid_id_token',
  EMAIL_UNVERIFIED: 'email_unverified',
  // Relay busy, shutting down or out of storage; nothing was signed in.
  UNAVAILABLE: 'unavailable',
});

export const AUTH_ERROR_CODES = Object.freeze(Object.values(AUTH_ERROR));

export const isAuthErrorCode = (code) => AUTH_ERROR_CODES.includes(code);
