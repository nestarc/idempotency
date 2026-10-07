import { createHash } from 'crypto';

/** Internal v1 wire format. Keep component boundaries before hashing. */
export type RequestNamespace = ['global'] | ['endpoint', readonly string[], readonly string[]];

export function createRequestKey(
  namespace: RequestNamespace,
  rawKey: string,
): { key: string; namespace: string } {
  const hash = (value: unknown): string =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    key: `@nestarc/idempotency:key:v1:${hash([namespace, rawKey])}`,
    namespace: `@nestarc/idempotency:namespace:v1:${hash(namespace)}`,
  };
}

/** Reject lossy UTF-8 input and invisible control characters. */
export function isValidKeyString(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  // Iteration yields complete code points; only unpaired surrogates remain
  // in D800-DFFF. Node would otherwise encode these as replacement characters.
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)) {
      return false;
    }
  }
  return true;
}
