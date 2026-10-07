import type { Logger } from '@nestjs/common';
import type { IdempotencyEvent } from '../interfaces/idempotency-options.interface';

const diagnostics = {
  response_not_replayable: ['warn', 'Response is not replayable; retaining the PROCESSING record until its lease expires'],
  stale_completion: ['warn', 'Stale token when completing; response not cached'],
  complete_failure: ['error', 'storage.complete() failed; handler succeeded, retaining the record'],
  cleanup_failure: ['warn', 'storage.delete() failed during handler-error cleanup; propagating original handler error'],
  callback_failure: ['warn', 'observability onEvent failed; request processing is unchanged'],
  sweep_failure: ['error', 'Idempotency sweep failed'],
} as const;

/** Only package-owned codes and generated hashes may enter internal logs. */
export function logDiagnostic(
  logger: Pick<Logger, 'warn' | 'error'>,
  code: keyof typeof diagnostics,
  context?: Pick<IdempotencyEvent, 'namespace' | 'keyHash'>,
): void {
  const [level, message] = diagnostics[code];
  try {
    // Isolate throws and any Promise returned by this Logger method. Nest can
    // discard a transport's Promise internally; such transports must handle
    // their own asynchronous failures.
    void Promise.resolve(logger[level](message, { code, ...context })).catch(
      () => undefined,
    );
  } catch {
    // No recursive logging and no inspection of the logger's thrown value.
  }
}
