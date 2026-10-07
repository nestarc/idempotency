/** Shared seconds limit for interceptor options and direct storage calls. */
export const MAX_TTL_SECONDS = 2_147_483_647;

/** Validate before reading storage, scheduling timers, or issuing commands. */
export function assertTtlSeconds(value: number, context: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TTL_SECONDS) {
    // JavaScript callers can bypass the number type. Do not invoke an invalid
    // object's conversion hooks while reporting the validation failure.
    const received =
      value !== null && (typeof value === 'object' || typeof value === 'function')
        ? typeof value
        : String(value);
    throw new RangeError(
      `${context} must be a positive integer number of seconds between 1 and ${MAX_TTL_SECONDS}, received ${received}`,
    );
  }
}
