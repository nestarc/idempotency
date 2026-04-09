import { Test } from '@nestjs/testing';
import { Injectable, Module } from '@nestjs/common';

import { IdempotencyModule } from '../src/idempotency.module';
import { IdempotencyInterceptor } from '../src/idempotency.interceptor';
import {
  IDEMPOTENCY_OPTIONS,
  IDEMPOTENCY_STORAGE,
} from '../src/idempotency.constants';
import { MemoryStorage } from '../src/storage/memory.storage';
import type {
  IdempotencyOptions,
  IdempotencyOptionsFactory,
} from '../src/interfaces/idempotency-options.interface';

describe('IdempotencyModule', () => {
  describe('forRoot', () => {
    it('registers options, storage, and interceptor providers', async () => {
      const storage = new MemoryStorage();
      const moduleRef = await Test.createTestingModule({
        imports: [IdempotencyModule.forRoot({ storage, ttl: 600 })],
      }).compile();

      expect(moduleRef.get<IdempotencyOptions>(IDEMPOTENCY_OPTIONS).ttl).toBe(
        600,
      );
      expect(moduleRef.get(IDEMPOTENCY_STORAGE)).toBe(storage);
      expect(moduleRef.get(IdempotencyInterceptor)).toBeInstanceOf(
        IdempotencyInterceptor,
      );

      await storage.onModuleDestroy();
      await moduleRef.close();
    });

    it('defaults to global=true so consumers do not need to re-import', async () => {
      const storage = new MemoryStorage();
      const dynamicModule = IdempotencyModule.forRoot({ storage });
      expect(dynamicModule.global).toBe(true);
      await storage.onModuleDestroy();
    });

    it('respects an explicit isGlobal=false', async () => {
      const storage = new MemoryStorage();
      const dynamicModule = IdempotencyModule.forRoot({
        storage,
        isGlobal: false,
      });
      expect(dynamicModule.global).toBe(false);
      await storage.onModuleDestroy();
    });
  });

  describe('forRootAsync (useFactory)', () => {
    it('resolves options through a factory', async () => {
      const storage = new MemoryStorage();
      const moduleRef = await Test.createTestingModule({
        imports: [
          IdempotencyModule.forRootAsync({
            useFactory: () => ({ storage, ttl: 1234 }),
          }),
        ],
      }).compile();

      expect(moduleRef.get<IdempotencyOptions>(IDEMPOTENCY_OPTIONS).ttl).toBe(
        1234,
      );
      expect(moduleRef.get(IDEMPOTENCY_STORAGE)).toBe(storage);

      await storage.onModuleDestroy();
      await moduleRef.close();
    });

    it('passes injected dependencies into the factory', async () => {
      @Injectable()
      class ConfigStub {
        readonly storage = new MemoryStorage();
        readonly ttl = 999;
      }

      @Module({
        providers: [ConfigStub],
        exports: [ConfigStub],
      })
      class ConfigStubModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [
          IdempotencyModule.forRootAsync({
            imports: [ConfigStubModule],
            inject: [ConfigStub],
            useFactory: (cfg: ConfigStub) => ({
              storage: cfg.storage,
              ttl: cfg.ttl,
            }),
          }),
        ],
      }).compile();

      const options = moduleRef.get<IdempotencyOptions>(IDEMPOTENCY_OPTIONS);
      expect(options.ttl).toBe(999);

      await (options.storage as MemoryStorage).onModuleDestroy();
      await moduleRef.close();
    });
  });

  describe('forRootAsync (useClass)', () => {
    it('resolves options via createIdempotencyOptions()', async () => {
      const storage = new MemoryStorage();

      class IdempotencyConfig implements IdempotencyOptionsFactory {
        createIdempotencyOptions(): IdempotencyOptions {
          return { storage, ttl: 42 };
        }
      }

      const moduleRef = await Test.createTestingModule({
        imports: [
          IdempotencyModule.forRootAsync({
            useClass: IdempotencyConfig,
          }),
        ],
      }).compile();

      const options = moduleRef.get<IdempotencyOptions>(IDEMPOTENCY_OPTIONS);
      expect(options.ttl).toBe(42);
      expect(moduleRef.get(IDEMPOTENCY_STORAGE)).toBe(storage);

      await storage.onModuleDestroy();
      await moduleRef.close();
    });
  });
});
