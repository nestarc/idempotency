/**
 * S5 failure boundary regression: retaining an idempotency record prevents an
 * immediate duplicate execution after an ambiguous completion or process crash.
 * It cannot make the business commit and idempotency completion atomic. Real
 * Redis/PostgreSQL state plus an independent PostgreSQL ledger demonstrate both
 * the protected retry window and duplicate effects after expiry. IPC-gated
 * SIGKILLs are real process crashes; complete rejections are application-boundary
 * injections, and client assertions observe the interceptor rather than TCP.
 */
import { fork, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { join } from 'path';

import { PostgresStorage } from '../../src/storage/postgres.storage';
import { createRequestKey } from '../../src/utils/request-key';
import {
  connectFailureFixture,
  type CompleteFailure,
  type CrashPoint,
  type FailureBackend,
  type FailureChildConfig,
  type FailureClientResult,
} from '../support/failure-lifecycle-real';

const available = !!process.env.TEST_REDIS_URL && !!process.env.TEST_DATABASE_URL;
if (process.env.S5_REQUIRE_REAL_STORAGE === '1' && !available) {
  throw new Error('S5 real failure tests require both TEST_REDIS_URL and TEST_DATABASE_URL');
}
const describeReal = available ? describe : describe.skip;
if (!available) {
  // eslint-disable-next-line no-console
  console.warn(
    '[failure-lifecycle.real.spec] Real Redis/PostgreSQL crash experiments skipped: both TEST_REDIS_URL and TEST_DATABASE_URL are required.',
  );
}

jest.setTimeout(45_000);

interface ChildMessage {
  type: 'barrier' | 'result' | 'fatal';
  point?: CrashPoint;
  result?: FailureClientResult;
  error?: string;
}

const activeChildren = new Set<ChildProcess>();
const evidence: unknown[] = [];

async function startChild(config: FailureChildConfig, expected: 'barrier' | 'result') {
  const child = fork(
    join(__dirname, '../support/failure-lifecycle-child.ts'),
    [JSON.stringify(config)],
    {
      execArgv: ['-r', require.resolve('ts-node/register/transpile-only')],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  activeChildren.add(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const messages: ChildMessage[] = [];
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      activeChildren.delete(child);
      resolve({ code, signal });
    });
  });
  const message = await new Promise<ChildMessage>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Child did not reach ${expected}: ${output}`)),
      20_000,
    );
    child.on('message', (raw: ChildMessage) => {
      messages.push(raw);
      if (raw.type === expected) {
        clearTimeout(timer);
        resolve(raw);
      } else if (raw.type === 'fatal') {
        clearTimeout(timer);
        reject(new Error(raw.error));
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    void exited.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(new Error(`Child exited before ${expected} (${code ?? signal}): ${output}`));
    });
  });
  return { child, message, messages, exited };
}

async function request(config: FailureChildConfig): Promise<FailureClientResult> {
  const process = await startChild(config, 'result');
  expect(await process.exited).toEqual({ code: 0, signal: null });
  return process.message.result!;
}

afterEach(async () => {
  await Promise.all(
    Array.from(
      activeChildren,
      (child) =>
        new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          child.kill('SIGKILL');
        }),
    ),
  );
});

afterAll(() => {
  if (process.env.S5_EVIDENCE_PATH && available) {
    writeFileSync(
      process.env.S5_EVIDENCE_PATH,
      JSON.stringify(
        {
          fixture: 'failure-lifecycle.real.spec.ts',
          capturedAt: new Date().toISOString(),
          boundaries: {
            crash: 'Real child-process SIGKILL ordered by IPC barriers',
            client: 'Interceptor status/body boundary; no TCP HTTP server',
            ledger: 'Separate PostgreSQL transaction for both storage adapters',
            expiry:
              'Test-only shortening of server expiry after the pre-expiry retry; PROCESSING lease is 120 seconds and COMPLETED retention is 300 seconds',
            completeFailure:
              'Application-boundary rejection before invoking adapter or after its successful reply; not a network-outage simulation',
          },
          scenarios: evidence,
        },
        null,
        2,
      ),
    );
  }
});

describeReal.each<FailureBackend>(['redis', 'postgres'])(
  'S5 real %s failure lifecycle',
  (backend) => {
    const namespace = `s5_${randomUUID().replace(/-/g, '')}`;
    let fixture: Awaited<ReturnType<typeof connectFailureFixture>>;

    beforeAll(async () => {
      fixture = await connectFailureFixture({ backend, namespace, rawKey: 'setup' });
      await PostgresStorage.createSchema(fixture.pool, fixture.tables.records);
      for (const table of [fixture.tables.attempts, fixture.tables.effects]) {
        await fixture.pool.query(
          `CREATE TABLE "${table}" (id UUID PRIMARY KEY, operation_key TEXT NOT NULL)`,
        );
      }
      if (fixture.redis) expect(await fixture.redis.ping()).toBe('PONG');
    });

    afterAll(async () => {
      if (!fixture) return;
      try {
        if (fixture.redis) {
          const keys = await fixture.redis.keys(`${namespace}:*`);
          if (keys.length) await fixture.redis.del(...keys);
        }
        for (const table of Object.values(fixture.tables)) {
          await fixture.pool.query(`DROP TABLE IF EXISTS "${table}"`);
        }
      } finally {
        await fixture.close();
      }
    });

    async function snapshot(rawKey: string) {
      const key = createRequestKey(['global'], rawKey).key;
      const [record, attempts, effects] = await Promise.all([
        fixture.storage.get(key),
        fixture.pool.query<{ count: string }>(
          `SELECT count(*) FROM "${fixture.tables.attempts}" WHERE operation_key = $1`,
          [rawKey],
        ),
        fixture.pool.query<{ count: string }>(
          `SELECT count(*) FROM "${fixture.tables.effects}" WHERE operation_key = $1`,
          [rawKey],
        ),
      ]);
      return {
        record: record && {
          token: record.token,
          status: record.status,
          expiresAt: record.expiresAt.toISOString(),
        },
        handlerExecutions: Number(attempts.rows[0].count),
        committedEffects: Number(effects.rows[0].count),
      };
    }

    async function expire(rawKey: string) {
      const key = createRequestKey(['global'], rawKey).key;
      // Crash ordering and the pre-expiry retry already finished at IPC gates.
      // Shorten the current lease/retention in the isolated fixture namespace,
      // then observe the actual adapter's expiry behavior (no fake clocks).
      if (fixture.redis) {
        expect(await fixture.redis.pexpire(`${namespace}:${key}`, 100)).toBe(1);
      } else {
        const changed = await fixture.pool.query(
          `UPDATE "${fixture.tables.records}" SET expires_at = now() + interval '100 milliseconds' WHERE key = $1`,
          [key],
        );
        expect(changed.rowCount).toBe(1);
      }
      const deadline = Date.now() + 5000;
      while (await fixture.storage.get(key)) {
        if (Date.now() > deadline)
          throw new Error('Real storage did not expire the shortened fixture lease');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    it.each<CrashPoint>(['before-business-commit', 'after-business-commit', 'after-complete'])(
      'SIGKILL at %s, restart, retry before/after expiry, and inspect the business ledger',
      async (crashPoint) => {
        const rawKey = randomUUID();
        const config = { backend, namespace, rawKey };
        const key = createRequestKey(['global'], rawKey).key;
        const original = await startChild({ ...config, crashPoint }, 'barrier');
        expect(original.message.point).toBe(crashPoint);
        const barrierState = await snapshot(rawKey);
        expect(barrierState.handlerExecutions).toBe(1);
        expect(barrierState.committedEffects).toBe(crashPoint === 'before-business-commit' ? 0 : 1);
        expect(barrierState.record?.status).toBe(
          crashPoint === 'after-complete' ? 'COMPLETED' : 'PROCESSING',
        );

        original.child.kill('SIGKILL');
        const exit = await original.exited;
        expect(exit).toEqual({ code: null, signal: 'SIGKILL' });
        expect(original.messages.some((message) => message.type === 'result')).toBe(false);
        const afterCrash = await snapshot(rawKey);
        expect(afterCrash).toEqual(barrierState);

        // Each retry starts a fresh process, reflector, interceptor, and clients.
        const beforeExpiry = await request(config);
        expect(beforeExpiry.status).toBe(crashPoint === 'after-complete' ? 201 : 409);
        expect(beforeExpiry.idempotencyStatus).toBe(
          crashPoint === 'after-complete' ? 'replayed' : 'conflict',
        );
        if (crashPoint === 'after-complete') {
          expect(beforeExpiry.body).toEqual({ charged: true, operationId: rawKey });
        }
        expect(await snapshot(rawKey)).toEqual(afterCrash);

        await expire(rawKey);
        const expired = await snapshot(rawKey);
        expect(expired.record).toBeNull();
        // D06: an expired original token cannot resurrect the old response,
        // including PostgreSQL's physically retained, logically expired row.
        expect(
          await fixture.storage.complete(
            key,
            afterCrash.record!.token,
            { statusCode: 201, body: 'old' },
            300,
          ),
        ).toBe('stale');
        expect(await fixture.storage.get(key)).toBeNull();
        const afterExpiry = await request(config);
        expect(afterExpiry).toMatchObject({
          status: 201,
          idempotencyStatus: 'created',
          body: { charged: true, operationId: rawKey },
        });
        const finalState = await snapshot(rawKey);
        expect(finalState.handlerExecutions).toBe(2);
        expect(finalState.committedEffects).toBe(crashPoint === 'before-business-commit' ? 1 : 2);
        expect(finalState.record?.status).toBe('COMPLETED');
        expect(finalState.record?.token).not.toBe(afterCrash.record?.token);
        expect(
          await fixture.storage.complete(
            key,
            afterCrash.record!.token,
            { statusCode: 201, body: 'old' },
            300,
          ),
        ).toBe('stale');
        expect(await fixture.storage.delete(key, afterCrash.record!.token)).toBe('stale');
        expect(await snapshot(rawKey)).toEqual(finalState);

        evidence.push({
          backend,
          scenario: crashPoint,
          originalClient: 'no response (SIGKILL)',
          exit,
          afterCrash,
          beforeExpiry,
          expired,
          afterExpiry,
          finalState,
        });
      },
    );

    it.each<CompleteFailure>(['before-write-rejection', 'applied-write-rejection'])(
      'application-boundary %s preserves the business result and exposes the actual storage outcome',
      async (completeFailure) => {
        const rawKey = randomUUID();
        const config = { backend, namespace, rawKey };
        const originalClient = await request({ ...config, completeFailure });
        expect(originalClient).toMatchObject({
          status: 201,
          idempotencyStatus: 'complete_error',
          body: { charged: true, operationId: rawKey },
        });
        expect(originalClient.events.filter((event) => event === 'complete_error')).toHaveLength(1);
        const afterOriginal = await snapshot(rawKey);
        expect(afterOriginal).toMatchObject({ handlerExecutions: 1, committedEffects: 1 });
        expect(afterOriginal.record?.status).toBe(
          completeFailure === 'applied-write-rejection' ? 'COMPLETED' : 'PROCESSING',
        );

        const beforeExpiry = await request(config);
        expect(beforeExpiry.status).toBe(completeFailure === 'applied-write-rejection' ? 201 : 409);
        expect(beforeExpiry.idempotencyStatus).toBe(
          completeFailure === 'applied-write-rejection' ? 'replayed' : 'conflict',
        );
        if (completeFailure === 'applied-write-rejection') {
          expect(beforeExpiry.body).toEqual(originalClient.body);
        }
        expect(await snapshot(rawKey)).toEqual(afterOriginal);

        await expire(rawKey);
        const afterExpiry = await request(config);
        expect(afterExpiry).toMatchObject({ status: 201, idempotencyStatus: 'created' });
        const finalState = await snapshot(rawKey);
        expect(finalState).toMatchObject({
          handlerExecutions: 2,
          committedEffects: 2,
          record: { status: 'COMPLETED' },
        });
        expect(finalState.record?.token).not.toBe(afterOriginal.record?.token);
        evidence.push({
          backend,
          scenario: completeFailure,
          injection: 'application boundary; no network outage',
          originalClient,
          afterOriginal,
          beforeExpiry,
          afterExpiry,
          finalState,
        });
      },
    );
  },
);
