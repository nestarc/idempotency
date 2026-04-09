import { SetMetadata } from '@nestjs/common';
import { IDEMPOTENT_METADATA_KEY } from './idempotency.constants';
import type {
  IdempotentMetadata,
  IdempotentOptions,
} from './interfaces/idempotency-options.interface';

/**
 * Marks a NestJS controller handler as idempotent.
 *
 * The {@link IdempotencyInterceptor} reads this metadata to decide whether to
 * apply duplicate-request protection: extracting the `Idempotency-Key` header,
 * computing a request fingerprint, and replaying cached responses for repeats.
 *
 * @example Basic usage — header is required, body fingerprinted, default TTL.
 * ```ts
 * @Post()
 * @Idempotent()
 * createPayment(@Body() dto: CreatePaymentDto) { ... }
 * ```
 *
 * @example Per-handler overrides.
 * ```ts
 * @Post('refunds')
 * @Idempotent({ ttl: 3600, fingerprint: false })
 * createRefund(@Body() dto: CreateRefundDto) { ... }
 * ```
 */
export const Idempotent = (options?: IdempotentOptions): MethodDecorator => {
  const metadata: IdempotentMetadata = {
    ...(options ?? {}),
    enabled: true,
  };
  return SetMetadata(IDEMPOTENT_METADATA_KEY, metadata);
};
