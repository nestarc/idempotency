import assert from 'node:assert/strict';
import { Inject, Injectable, Module, type DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  IDEMPOTENCY_OPTIONS,
  IDEMPOTENCY_STORAGE,
  IdempotencyModule,
  type IdempotencyOptions,
  type IdempotencyOptionsFactory,
  type IdempotencyStorage,
} from '@nestarc/idempotency';

/** The same public TypeScript examples are typechecked, emitted and executed. */
export async function verifyModuleRegistrations(storage: IdempotencyStorage): Promise<void> {
  const APP_STORAGE = Symbol('APP_STORAGE');
  let factoryInstances = 0;

  @Injectable()
  class OptionsFactory implements IdempotencyOptionsFactory {
    constructor(@Inject(APP_STORAGE) private readonly configuredStorage: IdempotencyStorage) {
      factoryInstances += 1;
    }

    async createIdempotencyOptions(): Promise<IdempotencyOptions> {
      return { storage: this.configuredStorage, ttl: 86_400, processingTtl: 30 };
    }
  }

  @Module({
    providers: [{ provide: APP_STORAGE, useValue: storage }],
    exports: [APP_STORAGE],
  })
  class StorageConfigurationModule {}

  @Module({
    imports: [StorageConfigurationModule],
    providers: [OptionsFactory],
    exports: [OptionsFactory],
  })
  class ExistingOptionsModule {}

  const registrations: Array<[string, DynamicModule]> = [
    ['forRoot', IdempotencyModule.forRoot({ storage, ttl: 86_400, processingTtl: 30 })],
    [
      'forRootAsync/useFactory',
      IdempotencyModule.forRootAsync({
        imports: [StorageConfigurationModule],
        inject: [APP_STORAGE],
        useFactory: async (configuredStorage: IdempotencyStorage) => ({
          storage: configuredStorage,
          ttl: 86_400,
          processingTtl: 30,
        }),
      }),
    ],
    [
      'forRootAsync/useClass',
      IdempotencyModule.forRootAsync({
        imports: [StorageConfigurationModule],
        useClass: OptionsFactory,
      }),
    ],
    [
      'forRootAsync/useExisting',
      IdempotencyModule.forRootAsync({
        imports: [ExistingOptionsModule],
        useExisting: OptionsFactory,
      }),
    ],
  ];

  for (const [label, registration] of registrations) {
    const previousInstances = factoryInstances;
    const module = await Test.createTestingModule({ imports: [registration] }).compile();
    try {
      await module.init();
      assert.equal(module.get(IDEMPOTENCY_STORAGE), storage);
      assert.equal(module.get<IdempotencyOptions>(IDEMPOTENCY_OPTIONS).ttl, 86_400);
      if (label.endsWith('useClass') || label.endsWith('useExisting')) {
        assert.equal(factoryInstances - previousInstances, 1, `${label} creates one factory`);
        assert.equal(
          (await module.get(OptionsFactory).createIdempotencyOptions()).storage,
          storage,
        );
      }
    } finally {
      await module.close();
    }
    console.log(`PASS ${label} public TypeScript example compile/init/close`);
  }
}
