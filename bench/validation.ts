import { isDeepStrictEqual } from 'node:util';

import type { BenchmarkResponse } from './http';

export type ExpectedOutcome = 'baseline' | 'created' | 'replayed' | 'mismatch';

/** Reject fast failure paths and duplicate handler execution before accepting a sample. */
export function assertBenchmarkResponse(
  response: BenchmarkResponse,
  expected: ExpectedOutcome,
  callsBefore: number,
  callsAfter: number,
): void {
  const status = expected === 'mismatch' ? 422 : 201;
  if (response.status !== status) {
    throw new Error(`Benchmark ${expected} expected HTTP ${status}, received ${response.status}.`);
  }
  const statusHeader = expected === 'baseline' ? undefined : expected;
  if (response.headers['idempotency-status'] !== statusHeader) {
    throw new Error(`Benchmark ${expected} received an unexpected idempotency status header.`);
  }
  const replayHeader = expected === 'replayed' ? 'true' : undefined;
  if (response.headers['idempotency-replayed'] !== replayHeader) {
    throw new Error(`Benchmark ${expected} received an unexpected replay header.`);
  }
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new Error(`Benchmark ${expected} received invalid JSON.`);
  }
  const expectedBody =
    expected === 'mismatch'
      ? {
          statusCode: 422,
          message: 'Idempotency-Key reused with a different payload',
          error: 'Unprocessable Entity',
        }
      : { id: 'pay_1', amount: 100 };
  if (!isDeepStrictEqual(body, expectedBody)) {
    throw new Error(`Benchmark ${expected} received an unexpected response body.`);
  }
  const expectedCalls = expected === 'baseline' || expected === 'created' ? 1 : 0;
  if (callsAfter - callsBefore !== expectedCalls) {
    throw new Error(`Benchmark ${expected} expected ${expectedCalls} handler execution(s).`);
  }
}
