// Module + interceptor + decorator
export { IdempotencyModule } from './idempotency.module';
export { IdempotencyInterceptor } from './idempotency.interceptor';
export { Idempotent } from './idempotency.decorator';

// Driver-free storage. Optional adapters have their own package subpaths.
export { MemoryStorage } from './storage/memory.storage';

// Constants (injection tokens, metadata key, defaults)
export {
  IDEMPOTENCY_OPTIONS,
  IDEMPOTENCY_STORAGE,
  IDEMPOTENCY_SWEEP_OPTIONS,
  IDEMPOTENT_METADATA_KEY,
  DEFAULT_HEADER_NAME,
  DEFAULT_TTL_SECONDS,
} from './idempotency.constants';

// Interfaces
export type {
  IdempotencyRecord,
  IdempotencyStatus,
} from './interfaces/idempotency-record.interface';
export type {
  IdempotencyStorage,
  CompleteResponse,
  CreateResult,
  MutateResult,
} from './interfaces/idempotency-storage.interface';
export type {
  IdempotencyOptions,
  IdempotencyAsyncOptions,
  IdempotencyOptionsFactory,
  IdempotencyScope,
  ReplayHeadersOption,
  IdempotentOptions,
  IdempotentMetadata,
  IdempotencyKeyResolver,
  IdempotencyFingerprintInput,
  IdempotencyFingerprintResolver,
  IdempotencyEvent,
  IdempotencyEventError,
  IdempotencyStorageOperation,
  IdempotencyOutcome,
  IdempotencyObservabilityOptions,
} from './interfaces/idempotency-options.interface';
