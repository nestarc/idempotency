import {
  Module,
  type DynamicModule,
  type Provider,
  type Type,
} from '@nestjs/common';

import {
  IDEMPOTENCY_OPTIONS,
  IDEMPOTENCY_STORAGE,
} from './idempotency.constants';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import type {
  IdempotencyAsyncOptions,
  IdempotencyOptions,
  IdempotencyOptionsFactory,
} from './interfaces/idempotency-options.interface';

/**
 * NestJS dynamic module exposing the {@link IdempotencyInterceptor} and the
 * configured {@link IdempotencyStorage}.
 *
 * The module does **not** auto-register the interceptor as `APP_INTERCEPTOR` —
 * consumers opt in via one of three patterns:
 *
 * 1. App-global:
 *    `providers: [{ provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }]`
 * 2. Controller-scoped: `@UseInterceptors(IdempotencyInterceptor)` on the class
 * 3. Method-scoped: `@UseInterceptors(IdempotencyInterceptor)` on the handler
 *
 * The module is registered as global by default so consumers can wire any of
 * the three patterns without re-importing it everywhere.
 */
@Module({})
export class IdempotencyModule {
  static forRoot(options: IdempotencyOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: IDEMPOTENCY_OPTIONS,
      useValue: options,
    };
    const storageProvider: Provider = {
      provide: IDEMPOTENCY_STORAGE,
      useValue: options.storage,
    };

    return {
      module: IdempotencyModule,
      global: options.isGlobal ?? true,
      providers: [optionsProvider, storageProvider, IdempotencyInterceptor],
      exports: [
        IDEMPOTENCY_OPTIONS,
        IDEMPOTENCY_STORAGE,
        IdempotencyInterceptor,
      ],
    };
  }

  static forRootAsync(options: IdempotencyAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);
    const storageProvider: Provider = {
      provide: IDEMPOTENCY_STORAGE,
      inject: [IDEMPOTENCY_OPTIONS],
      useFactory: (resolved: IdempotencyOptions) => resolved.storage,
    };

    return {
      module: IdempotencyModule,
      global: options.isGlobal ?? true,
      imports: options.imports ?? [],
      providers: [...asyncProviders, storageProvider, IdempotencyInterceptor],
      exports: [
        IDEMPOTENCY_OPTIONS,
        IDEMPOTENCY_STORAGE,
        IdempotencyInterceptor,
      ],
    };
  }

  private static createAsyncProviders(
    options: IdempotencyAsyncOptions,
  ): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: IDEMPOTENCY_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }

    if (options.useExisting) {
      return [
        {
          provide: IDEMPOTENCY_OPTIONS,
          useFactory: (factory: IdempotencyOptionsFactory) =>
            factory.createIdempotencyOptions(),
          inject: [options.useExisting],
        },
      ];
    }

    if (options.useClass) {
      const useClass: Type<IdempotencyOptionsFactory> = options.useClass;
      return [
        {
          provide: useClass,
          useClass,
        },
        {
          provide: IDEMPOTENCY_OPTIONS,
          useFactory: (factory: IdempotencyOptionsFactory) =>
            factory.createIdempotencyOptions(),
          inject: [useClass],
        },
      ];
    }

    throw new Error(
      'IdempotencyModule.forRootAsync requires one of: useFactory, useClass, or useExisting',
    );
  }
}
