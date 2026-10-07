import { Test, type TestingModule } from '@nestjs/testing';
import { Inject, Injectable, Module } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';

import { IdempotencyModule } from '../src/idempotency.module';
import { IdempotencyInterceptor } from '../src/idempotency.interceptor';
import { Idempotent } from '../src/idempotency.decorator';
import { IDEMPOTENCY_OPTIONS, IDEMPOTENCY_STORAGE } from '../src/idempotency.constants';
import { MemoryStorage } from '../src/storage/memory.storage';
import type {
  IdempotencyOptions,
  IdempotencyOptionsFactory,
} from '../src/interfaces/idempotency-options.interface';
import { buildCallHandler, buildExecutionContext } from './support/execution-context.factory';

@Injectable()
class FeatureConsumer {
  constructor(
    @Inject(IDEMPOTENCY_STORAGE) readonly storage: MemoryStorage,
    @Inject(IDEMPOTENCY_OPTIONS) readonly options: IdempotencyOptions,
    readonly interceptor: IdempotencyInterceptor,
  ) {}
}

@Module({ providers: [FeatureConsumer] })
class FeatureModule {}

describe('IdempotencyModule', () => {
  const modules: TestingModule[] = [];
  const storages: MemoryStorage[] = [];
  const storageForTest = () => {
    const storage = new MemoryStorage();
    storages.push(storage);
    return storage;
  };
  const track = (moduleRef: TestingModule) => {
    modules.push(moduleRef);
    return moduleRef;
  };

  afterEach(async () => {
    for (const moduleRef of modules.splice(0)) await moduleRef.close();
    // Also release storage when compilation intentionally fails. Successful
    // lifecycle behavior is asserted before this fallback cleanup runs.
    for (const storage of storages.splice(0)) await storage.onModuleDestroy();
  });

  describe('forRoot', () => {
    it('exports working providers to a sibling feature module by default', async () => {
      const storage = storageForTest();
      const moduleRef = track(
        await Test.createTestingModule({
          imports: [IdempotencyModule.forRoot({ storage, ttl: 600 }), FeatureModule],
        }).compile(),
      );
      const feature = moduleRef.get(FeatureConsumer);
      expect(feature.storage).toBe(storage);
      expect(feature.options.ttl).toBe(600);

      class Handler {
        @Idempotent()
        execute() {
          return undefined;
        }
      }
      const request = () =>
        buildExecutionContext({
          req: {
            method: 'POST',
            url: '/payments',
            headers: { 'idempotency-key': 'di-key' },
            body: { amount: 100 },
          },
          handler: Handler.prototype.execute,
        });
      const next = buildCallHandler(of({ id: 'pay-1' }));
      await expect(
        firstValueFrom(feature.interceptor.intercept(request().context, next)),
      ).resolves.toEqual({ id: 'pay-1' });
      const duplicate = buildCallHandler(of({ id: 'duplicate-effect' }));
      await expect(
        firstValueFrom(feature.interceptor.intercept(request().context, duplicate)),
      ).resolves.toEqual({ id: 'pay-1' });
      expect(next.handleSpy).toHaveBeenCalledTimes(1);
      expect(duplicate.handleSpy).not.toHaveBeenCalled();
    });

    it('does not expose providers to sibling modules when isGlobal=false', async () => {
      const storage = storageForTest();
      await expect(
        Test.createTestingModule({
          imports: [IdempotencyModule.forRoot({ storage, isGlobal: false }), FeatureModule],
        }).compile(),
      ).rejects.toThrow(/FeatureConsumer/);
    });

    it('exports non-global providers to modules that explicitly import it', async () => {
      const storage = storageForTest();
      @Module({
        imports: [IdempotencyModule.forRoot({ storage, isGlobal: false })],
        providers: [FeatureConsumer],
      })
      class ImportingFeatureModule {}
      const moduleRef = track(
        await Test.createTestingModule({ imports: [ImportingFeatureModule] }).compile(),
      );
      expect(moduleRef.get(FeatureConsumer).storage).toBe(storage);
    });

    it('lets Nest module shutdown dispose the registered memory storage', async () => {
      const storage = storageForTest();
      const moduleRef = track(
        await Test.createTestingModule({
          imports: [IdempotencyModule.forRoot({ storage })],
        }).compile(),
      );
      await storage.create('shutdown-key', 'fingerprint', 600);
      expect(await storage.get('shutdown-key')).not.toBeNull();
      await moduleRef.close();
      modules.splice(modules.indexOf(moduleRef), 1);
      expect(await storage.get('shutdown-key')).toBeNull();
    });
  });

  describe('forRootAsync', () => {
    it('awaits an asynchronous factory and injects its exported providers', async () => {
      const storage = storageForTest();
      const factory = jest.fn(async () => {
        await Promise.resolve();
        return { storage, ttl: 1234 };
      });
      const moduleRef = track(
        await Test.createTestingModule({
          imports: [IdempotencyModule.forRootAsync({ useFactory: factory }), FeatureModule],
        }).compile(),
      );
      const feature = moduleRef.get(FeatureConsumer);
      expect(feature.options.ttl).toBe(1234);
      expect(feature.storage).toBe(storage);
      expect(feature.interceptor).toBeInstanceOf(IdempotencyInterceptor);
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('passes imported dependencies to the asynchronous factory', async () => {
      const storage = storageForTest();
      @Injectable()
      class ConfigStub {
        readonly ttl = 999;
      }
      @Module({ providers: [ConfigStub], exports: [ConfigStub] })
      class ConfigStubModule {}
      const factory = jest.fn(async (config: ConfigStub) => ({ storage, ttl: config.ttl }));
      const moduleRef = track(
        await Test.createTestingModule({
          imports: [
            IdempotencyModule.forRootAsync({
              imports: [ConfigStubModule],
              inject: [ConfigStub],
              useFactory: factory,
            }),
          ],
        }).compile(),
      );
      expect(factory).toHaveBeenCalledWith(moduleRef.get(ConfigStub));
      expect(moduleRef.get<IdempotencyOptions>(IDEMPOTENCY_OPTIONS).ttl).toBe(999);
      expect(moduleRef.get(IDEMPOTENCY_STORAGE)).toBe(storage);
    });

    it('constructs useClass through Nest dependency injection', async () => {
      const storage = storageForTest();
      @Module({
        providers: [{ provide: 'configured-ttl', useValue: 42 }],
        exports: ['configured-ttl'],
      })
      class ConfigurationModule {}
      @Injectable()
      class IdempotencyConfig implements IdempotencyOptionsFactory {
        constructor(@Inject('configured-ttl') private readonly ttl: number) {}
        async createIdempotencyOptions(): Promise<IdempotencyOptions> {
          return { storage, ttl: this.ttl };
        }
      }
      const moduleRef = track(
        await Test.createTestingModule({
          imports: [
            IdempotencyModule.forRootAsync({
              imports: [ConfigurationModule],
              useClass: IdempotencyConfig,
            }),
          ],
        }).compile(),
      );
      expect(moduleRef.get<IdempotencyOptions>(IDEMPOTENCY_OPTIONS).ttl).toBe(42);
      expect(moduleRef.get(IDEMPOTENCY_STORAGE)).toBe(storage);
    });

    it('reuses the existing imported factory instance without constructing another', async () => {
      const storage = storageForTest();
      let constructions = 0;
      @Injectable()
      class ExistingConfig implements IdempotencyOptionsFactory {
        constructor() {
          constructions += 1;
        }
        readonly createIdempotencyOptions = jest.fn(async () => ({ storage, ttl: 321 }));
      }
      @Module({ providers: [ExistingConfig], exports: [ExistingConfig] })
      class ConfigurationModule {}
      const moduleRef = track(
        await Test.createTestingModule({
          imports: [
            ConfigurationModule,
            IdempotencyModule.forRootAsync({
              imports: [ConfigurationModule],
              useExisting: ExistingConfig,
            }),
            FeatureModule,
          ],
        }).compile(),
      );
      expect(constructions).toBe(1);
      expect(moduleRef.get(ExistingConfig).createIdempotencyOptions).toHaveBeenCalledTimes(1);
      expect(moduleRef.get(FeatureConsumer).options.ttl).toBe(321);
      expect(moduleRef.get(FeatureConsumer).storage).toBe(storage);
    });

    it('does not make asynchronous providers global when isGlobal=false', async () => {
      const storage = storageForTest();
      await expect(
        Test.createTestingModule({
          imports: [
            IdempotencyModule.forRootAsync({
              isGlobal: false,
              useFactory: async () => ({ storage }),
            }),
            FeatureModule,
          ],
        }).compile(),
      ).rejects.toThrow(/FeatureConsumer/);
    });

    it('propagates asynchronous configuration failure instead of registering partial providers', async () => {
      const failure = new Error('configuration unavailable');
      await expect(
        Test.createTestingModule({
          imports: [
            IdempotencyModule.forRootAsync({
              useFactory: async () => {
                throw failure;
              },
            }),
          ],
        }).compile(),
      ).rejects.toBe(failure);
    });

    it('rejects missing asynchronous provider configuration', () => {
      expect(() => IdempotencyModule.forRootAsync({})).toThrow(
        'IdempotencyModule.forRootAsync requires one of: useFactory, useClass, or useExisting',
      );
    });
  });
});
