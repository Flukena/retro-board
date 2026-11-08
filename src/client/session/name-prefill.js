import { ACCOUNT_STATUS } from '../account/account-api.js';
import { normalizeDisplayName } from './local-preferences.js';

/**
 * The name dialog's draft after the account check returns. A signed-in Google
 * name replaces only the generated guest placeholder, and only while the user
 * has not typed anything and the dialog still holds that placeholder
 * (`placeholder` is null once the name was saved or the dialog closed).
 */
export function prefillNameDraft(draft, placeholder, accountResult) {
  if (placeholder === null || draft !== placeholder) return draft;
  if (accountResult?.status !== ACCOUNT_STATUS.SIGNED_IN) return draft;
  return normalizeDisplayName(accountResult.account.name) || draft;
}
