// Module + interceptor + decorator
export { IdempotencyModule } from './idempotency.module';
export { IdempotencyInterceptor } from './idempotency.interceptor';
export { Idempotent } from './idempotency.decorator';

// Storage adapters
export { MemoryStorage } from './storage/memory.storage';
export { RedisStorage, type RedisStorageOptions } from './storage/redis.storage';

// Constants (injection tokens, metadata key, defaults)
export {
  IDEMPOTENCY_OPTIONS,
  IDEMPOTENCY_STORAGE,
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
  IdempotentOptions,
  IdempotentMetadata,
} from './interfaces/idempotency-options.interface';
