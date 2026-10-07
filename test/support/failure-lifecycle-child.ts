/**
 * A real process boundary, launched by failure-lifecycle.real.spec.ts.
 * IPC gates order the crash relative to commit/complete; no timing guesses.
 * The response below is the interceptor's HTTP status/body boundary, not a
 * TCP HTTP connection. PostgreSQL and Redis connections are real.
 */
import 'reflect-metadata';
import { HttpException, Logger, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { defer, firstValueFrom } from 'rxjs';

import { IDEMPOTENT_METADATA_KEY } from '../../src/idempotency.constants';
import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import type { IdempotencyStorage } from '../../src/interfaces/idempotency-storage.interface';
import {
  connectFailureFixture,
  type CrashPoint,
  type FailureChildConfig,
  type FailureClientResult,
} from './failure-lifecycle-real';

const config = JSON.parse(process.argv[2]) as FailureChildConfig;

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('IPC channel is required'));
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function barrier(point: CrashPoint): Promise<void> {
  if (config.crashPoint !== point) return;
  const resumed = new Promise<void>((resolve) => {
    process.once('message', () => resolve());
  });
  await send({ type: 'barrier', point });
  await resumed;
}

async function main() {
  Logger.overrideLogger(false);
  const fixture = await connectFailureFixture(config);
  const { storage, pool, tables } = fixture;
  const events: string[] = [];
  const wrappedStorage: IdempotencyStorage = {
    get: (key) => storage.get(key),
    create: (key, fingerprint, ttl) => storage.create(key, fingerprint, ttl),
    delete: (key, token) => storage.delete(key, token),
    complete: async (...args) => {
      await barrier('after-business-commit');
      // Application-boundary injection. This does not simulate a network outage.
      if (config.completeFailure === 'before-write-rejection') {
        throw new Error('fixture rejected before invoking adapter.complete');
      }
      const result = await storage.complete(...args);
      if (config.completeFailure === 'applied-write-rejection') {
        if (result !== 'ok') throw new Error('Expected complete to be applied');
        throw new Error('fixture discarded successful adapter.complete reply');
      }
      await barrier('after-complete');
      return result;
    },
  };
  const interceptor = new IdempotencyInterceptor(new Reflector(), wrappedStorage, {
    storage: wrappedStorage,
    scope: 'global',
    processingTtl: 120,
    ttl: 300,
    observability: {
      onEvent: (event) => {
        events.push(event.outcome);
      },
    },
  });
  const handler = () => undefined;
  Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, { enabled: true }, handler);
  const headers: Record<string, string> = {};
  const response = {
    statusCode: 201,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    getHeaders() {
      return { ...headers };
    },
  };
  const request = {
    method: 'POST',
    originalUrl: '/failure-lifecycle/charge',
    headers: { 'idempotency-key': config.rawKey },
    body: { amount: 100 },
  };
  const context = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class FailureLifecycleController {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;

  let clientResult: FailureClientResult;
  try {
    const body = await firstValueFrom(
      interceptor.intercept(context, {
        handle: () =>
          defer(async () => {
            const attemptId = randomUUID();
            // Durable attempt is outside the business transaction, so the parent
            // can prove the killed handler ran even when its effect rolls back.
            await pool.query(
              `INSERT INTO "${tables.attempts}" (id, operation_key) VALUES ($1, $2)`,
              [attemptId, config.rawKey],
            );
            const transaction = await pool.connect();
            try {
              await transaction.query('BEGIN');
              await transaction.query(
                `INSERT INTO "${tables.effects}" (id, operation_key) VALUES ($1, $2)`,
                [attemptId, config.rawKey],
              );
              await barrier('before-business-commit');
              await transaction.query('COMMIT');
            } finally {
              transaction.release();
            }
            return { charged: true, operationId: config.rawKey };
          }),
      }),
    );
    clientResult = {
      status: response.statusCode,
      body,
      idempotencyStatus: headers['idempotency-status'],
      events,
    };
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    clientResult = {
      status: error.getStatus(),
      idempotencyStatus: headers['idempotency-status'],
      events,
    };
  } finally {
    await fixture.close();
  }
  await send({ type: 'result', result: clientResult });
  process.disconnect();
}

void main().catch(async (error: unknown) => {
  await send({ type: 'fatal', error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
});
