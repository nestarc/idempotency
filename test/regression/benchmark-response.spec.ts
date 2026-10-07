/**
 * BUG: The benchmark timed every HTTP response as success without checking its
 * status, replay payload, storage-completion outcome or handler invocation.
 * Fast error responses and duplicate replay executions could appear as wins.
 * FIX: Only accept the expected response contract and exact handler delta for
 * each measured scenario, including the untimed payload-mismatch probe.
 */
import type { BenchmarkResponse } from '../../bench/http';
import { assertBenchmarkResponse, type ExpectedOutcome } from '../../bench/validation';

const SUCCESS_BODY = JSON.stringify({ id: 'pay_1', amount: 100 });
const MISMATCH_BODY = JSON.stringify({
  statusCode: 422,
  message: 'Idempotency-Key reused with a different payload',
  error: 'Unprocessable Entity',
});

function responseFor(outcome: ExpectedOutcome): BenchmarkResponse {
  return {
    status: outcome === 'mismatch' ? 422 : 201,
    body: outcome === 'mismatch' ? MISMATCH_BODY : SUCCESS_BODY,
    headers:
      outcome === 'baseline'
        ? {}
        : {
            'idempotency-status': outcome,
            ...(outcome === 'replayed' ? { 'idempotency-replayed': 'true' } : {}),
          },
    durationMs: 1,
  };
}

function check(response: BenchmarkResponse, outcome: ExpectedOutcome): void {
  const executes = outcome === 'baseline' || outcome === 'created';
  assertBenchmarkResponse(response, outcome, 10, executes ? 11 : 10);
}

describe('REGRESSION: benchmark response correctness gate', () => {
  it.each(['baseline', 'created', 'replayed', 'mismatch'] as const)(
    'accepts the complete %s contract',
    (outcome) => expect(() => check(responseFor(outcome), outcome)).not.toThrow(),
  );

  it.each([400, 409, 422, 500, 503])('rejects fast HTTP %s errors as created samples', (status) => {
    expect(() => check({ ...responseFor('created'), status }, 'created')).toThrow();
  });

  it.each(['complete_error', 'stale', 'store_error', 'conflict'])(
    'rejects HTTP 201 with storage outcome %s',
    (status) => {
      const response = responseFor('created');
      response.headers['idempotency-status'] = status;
      expect(() => check(response, 'created')).toThrow();
    },
  );

  it.each([
    'not JSON',
    'null',
    JSON.stringify({ id: 'pay_1', amount: 99 }),
    JSON.stringify({ amount: 100 }),
    JSON.stringify({ id: 'pay_1', amount: 100, unexpected: true }),
  ])('rejects an invalid replay payload: %s', (body) => {
    expect(() => check({ ...responseFor('replayed'), body }, 'replayed')).toThrow();
  });

  it('compares JSON content independently of property order', () => {
    const response = { ...responseFor('replayed'), body: '{"amount":100,"id":"pay_1"}' };
    expect(() => check(response, 'replayed')).not.toThrow();
  });

  it.each(['created', 'replayed', 'mismatch'] as const)(
    'requires an unambiguous status header for %s',
    (outcome) => {
      const response = responseFor(outcome);
      delete response.headers['idempotency-status'];
      expect(() => check(response, outcome)).toThrow();
      response.headers['idempotency-status'] = [outcome];
      expect(() => check(response, outcome)).toThrow();
    },
  );

  it('requires the replay flag and forbids it on created responses', () => {
    const replay = responseFor('replayed');
    delete replay.headers['idempotency-replayed'];
    expect(() => check(replay, 'replayed')).toThrow();
    replay.headers['idempotency-replayed'] = 'false';
    expect(() => check(replay, 'replayed')).toThrow();

    const created = responseFor('created');
    created.headers['idempotency-replayed'] = 'true';
    expect(() => check(created, 'created')).toThrow();
  });

  it('rejects a baseline that unexpectedly passes through idempotency', () => {
    const baseline = responseFor('baseline');
    baseline.headers['idempotency-status'] = 'created';
    expect(() => check(baseline, 'baseline')).toThrow();
  });

  it.each(['replayed', 'mismatch'] as const)('%s must not execute the handler', (outcome) => {
    expect(() => assertBenchmarkResponse(responseFor(outcome), outcome, 10, 11)).toThrow();
  });

  it.each(['baseline', 'created'] as const)(
    '%s must execute the handler exactly once',
    (outcome) => {
      expect(() => assertBenchmarkResponse(responseFor(outcome), outcome, 10, 10)).toThrow();
      expect(() => assertBenchmarkResponse(responseFor(outcome), outcome, 10, 12)).toThrow();
    },
  );

  it('requires the complete mismatch error body', () => {
    expect(() => check({ ...responseFor('mismatch'), body: '{}' }, 'mismatch')).toThrow();
    expect(() => check({ ...responseFor('mismatch'), status: 201 }, 'mismatch')).toThrow();
  });
});
