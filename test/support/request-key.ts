import { createRequestKey } from '../../src/utils/request-key';

/** Encoded global key for seeded interceptor records and storage assertions. */
export const globalRequestKey = (rawKey: string): string =>
  createRequestKey(['global'], rawKey).key;
