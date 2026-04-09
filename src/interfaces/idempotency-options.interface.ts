import type { ModuleMetadata, Type } from '@nestjs/common';
import type { IdempotencyStorage } from './idempotency-storage.interface';

/**
 * Module-level configuration passed to {@link IdempotencyModule.forRoot}.
 */
export interface IdempotencyOptions {
  /**
   * The storage adapter instance to use. Construct it yourself
   * (e.g. `new MemoryStorage()` or `new RedisStorage({ host, port })`)
   * for full type-safe control over adapter wiring.
   */
  storage: IdempotencyStorage;

  /**
   * Default time-to-live for idempotency records, in seconds.
   * Per-handler `@Idempotent({ ttl })` overrides this.
   *
   * @default 86400 (24 hours)
   */
  ttl?: number;

  /**
   * The HTTP header name carrying the idempotency key. Override only if you
   * need to deviate from the IETF draft default.
   *
   * @default 'Idempotency-Key'
   */
  headerName?: string;

  /**
   * When true, the interceptor computes a SHA-256 fingerprint of the request body
   * and verifies it on subsequent requests. A mismatch produces HTTP 422.
   *
   * @default true
   */
  fingerprint?: boolean;

  /**
   * When true, the module is registered as a global module (no need to import
   * it into every consumer module).
   *
   * @default true
   */
  isGlobal?: boolean;
}

/**
 * Factory contract for `useClass` / `useExisting` async registration paths.
 */
export interface IdempotencyOptionsFactory {
  createIdempotencyOptions():
    | Promise<IdempotencyOptions>
    | IdempotencyOptions;
}

/**
 * Async configuration passed to {@link IdempotencyModule.forRootAsync}.
 * Mirrors the standard NestJS async-module pattern (useFactory / useClass / useExisting).
 */
export interface IdempotencyAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useExisting?: Type<IdempotencyOptionsFactory>;
  useClass?: Type<IdempotencyOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => Promise<IdempotencyOptions> | IdempotencyOptions;
  inject?: any[];
  isGlobal?: boolean;
}

/**
 * Per-handler overrides accepted by the {@link Idempotent} decorator.
 */
export interface IdempotentOptions {
  /**
   * When true, the `Idempotency-Key` header is mandatory and a missing header
   * produces HTTP 400. When false, requests without the header pass through
   * normally (no idempotency check).
   *
   * @default true
   */
  required?: boolean;

  /**
   * Override the module-level TTL for this handler (in seconds).
   */
  ttl?: number;

  /**
   * Override the module-level fingerprint setting for this handler.
   */
  fingerprint?: boolean;
}

/**
 * The metadata shape persisted via `SetMetadata` by the {@link Idempotent} decorator.
 * The `enabled: true` flag lets the interceptor distinguish "decorator applied
 * with no overrides" from "no decorator at all".
 */
export interface IdempotentMetadata extends IdempotentOptions {
  enabled: true;
}
