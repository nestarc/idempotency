import {
  DEFAULT_HEADER_NAME,
  DEFAULT_TTL_SECONDS,
  IDEMPOTENCY_OPTIONS,
  IDEMPOTENCY_STORAGE,
  IDEMPOTENCY_SWEEP_OPTIONS,
  IDEMPOTENT_METADATA_KEY,
  IdempotencyInterceptor,
  IdempotencyModule,
  Idempotent,
  type CompleteResponse,
  type CreateResult,
  type IdempotencyAsyncOptions,
  type IdempotencyEvent,
  type IdempotencyEventError,
  type IdempotencyFingerprintInput,
  type IdempotencyFingerprintResolver,
  type IdempotencyKeyResolver,
  type IdempotencyObservabilityOptions,
  type IdempotencyOptions,
  type IdempotencyOptionsFactory,
  type IdempotencyOutcome,
  type IdempotencyRecord,
  type IdempotencyScope,
  type IdempotencyStatus,
  type IdempotencyStorage,
  type IdempotencyStorageOperation,
  type IdempotentMetadata,
  type IdempotentOptions,
  type MutateResult,
  type ReplayHeadersOption,
} from '@nestarc/idempotency';

// The consumer never imports declarations through dist/ or src/ internals.
export type StorageContract = {
  storage: IdempotencyStorage;
  record: IdempotencyRecord;
  status: IdempotencyStatus;
  response: CompleteResponse;
  createResult: CreateResult;
  mutateResult: MutateResult;
};

export type ObservabilityContract = {
  namespace: IdempotencyEvent['namespace'];
  keyHash: IdempotencyEvent['keyHash'];
  error: IdempotencyEventError;
  operation: IdempotencyStorageOperation;
};

// @ts-expect-error The raw-key-bearing scope field was removed from public events.
export type RemovedEventScope = IdempotencyEvent['scope'];
// @ts-expect-error Event errors contain fixed classifications, never driver messages.
export type RemovedEventErrorMessage = IdempotencyEventError['message'];

export const storageOperations: IdempotencyStorageOperation[] = [
  'get',
  'create',
  'race_get',
  'complete',
  'delete',
];

export const eventErrors: IdempotencyEventError[] = [
  { code: 'storage_failure', operation: 'race_get' },
  { code: 'response_not_replayable' },
];

export const publicValues = {
  DEFAULT_HEADER_NAME,
  DEFAULT_TTL_SECONDS,
  IDEMPOTENCY_OPTIONS,
  IDEMPOTENCY_STORAGE,
  IDEMPOTENCY_SWEEP_OPTIONS,
  IDEMPOTENT_METADATA_KEY,
  IdempotencyInterceptor,
};

export function consumerOptions(storage: IdempotencyStorage): IdempotencyOptions {
  const keyResolver: IdempotencyKeyResolver = async (context) => context.getHandler().name;
  const fingerprint: IdempotencyFingerprintResolver = (input: IdempotencyFingerprintInput) =>
    input.defaultFingerprint();
  const outcomes: IdempotencyOutcome[] = [];
  const observability: IdempotencyObservabilityOptions = {
    exposeStatusHeaders: true,
    onEvent: async (event: IdempotencyEvent) => {
      outcomes.push(event.outcome);
      const namespace: string = event.namespace;
      const keyHash: string = event.keyHash;
      const error: IdempotencyEventError | undefined = event.error;
      if (error?.code === 'storage_failure') {
        const operation: IdempotencyStorageOperation = error.operation;
        void operation;
      }
      void namespace;
      void keyHash;
    },
  };
  const scope: IdempotencyScope = (context) =>
    [context.getClass().name, context.getHandler().name] as const;
  const replayHeaders: ReplayHeadersOption = ['content-type'];
  const options: IdempotencyOptions = {
    storage,
    keyResolver,
    fingerprint,
    observability,
    scope,
    replayHeaders,
    ttl: 60,
    processingTtl: 30,
  };
  const decoratorOptions: IdempotentOptions = {
    required: true,
    keyResolver,
    fingerprint,
    maxKeyLength: 128,
  };
  const metadata: IdempotentMetadata = {
    enabled: true,
    ...decoratorOptions,
  };
  Idempotent(metadata);
  const factory: IdempotencyOptionsFactory = {
    createIdempotencyOptions: () => options,
  };
  const asyncOptions: IdempotencyAsyncOptions = {
    useFactory: () => factory.createIdempotencyOptions(),
  };
  IdempotencyModule.forRoot(options);
  IdempotencyModule.forRootAsync(asyncOptions);
  return options;
}
