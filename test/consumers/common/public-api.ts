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
