import { createHash } from 'crypto';

/**
 * Persisted v1 fixture format, independent of the production encoder. Importing
 * createRequestKey here would change both existing-record fixtures and expected
 * storage arguments when the implementation regresses. Fixed vectors in
 * request-key.spec.ts also pin this fixture's format.
 */
export const globalRequestKey = (rawKey: string): string =>
  '@nestarc/idempotency:key:v1:' +
  createHash('sha256')
    .update(JSON.stringify([['global'], rawKey]))
    .digest('hex');
