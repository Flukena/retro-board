import * as decoding from 'lib0/decoding';
import { PUBLIC_QUOTA_MESSAGE_TYPE } from '../../domain/public-wall-contract.js';

export function attachPublicCreationBudget(provider, guard) {
  provider.messageHandlers[PUBLIC_QUOTA_MESSAGE_TYPE] = (_encoder, decoder, _provider, fromSocket) => {
    if (!fromSocket) return;
    try {
      guard.applyBudget(JSON.parse(decoding.readVarString(decoder)));
    } catch (error) {
      if (!(error instanceof SyntaxError) && error.message !== 'Unexpected end of array') throw error;
    }
  };
}
