/**
 * Regression: a loser of get → create must re-read the actual winner and
 * dispatch to replay, conflict, or fingerprint mismatch without business work.
 * The create barrier orders two real interceptor executions against MemoryStorage;
 * no canned storage return values fabricate a winner that never executed.
 */
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { defer, firstValueFrom, of, Subject } from 'rxjs';

import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import { IDEMPOTENT_METADATA_KEY } from '../../src/idempotency.constants';
import { MemoryStorage } from '../../src/storage/memory.storage';
import { globalRequestKey } from '../support/request-key';
import {
  buildCallHandler,
  buildExecutionContext,
  buildResponse,
} from '../support/execution-context.factory';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('REGRESSION: get → create race dispatch against actual winning work', () => {
  it.each(['replay', 'mismatch', 'processing', 'vanished'] as const)(
    '%s never re-executes the losing handler or changes the winner',
    async (scenario) => {
      const storage = new MemoryStorage();
      const interceptor = new IdempotencyInterceptor(new Reflector(), storage, {
        storage,
        ttl: 60,
        fingerprint: true,
        scope: 'global',
      });
      const handler = () => undefined;
      Reflect.defineMetadata(IDEMPOTENT_METADATA_KEY, { enabled: true }, handler);
      const makeContext = (amount: number) => {
        const res = buildResponse(201);
        return {
          ...buildExecutionContext({
            handler,
            res,
            req: { method: 'POST', headers: { 'idempotency-key': 'K-race' }, body: { amount } },
          }),
          res,
        };
      };
      const beforeCreate = deferred();
      const permitCreate = deferred();
      const create = jest.spyOn(storage, 'create').mockImplementationOnce(async (...args) => {
        beforeCreate.resolve();
        await permitCreate.promise;
        const result = await MemoryStorage.prototype.create.apply(storage, args);
        expect(result.acquired).toBe(false);
        if (scenario === 'vanished') {
          const record = await storage.get(args[0]);
          expect(record).not.toBeNull();
          await storage.delete(args[0], record!.token);
        }
        return result;
      });
      const loserContext = makeContext(scenario === 'mismatch' ? 999 : 100);
      const loser = buildCallHandler(of({ duplicate: true }));
      // Attach both handlers immediately so a deliberately rejected loser cannot
      // become an unhandled rejection while the winner is being inspected.
      const result = firstValueFrom(interceptor.intercept(loserContext.context, loser)).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      const work = new Subject<unknown>();
      let winnerRequest: Promise<unknown> | undefined;
      try {
        await beforeCreate.promise;
        const started = deferred();
        const winner = buildCallHandler(
          defer(() => {
            started.resolve();
            return scenario === 'processing' ? work : of({ id: 'winner' });
          }),
        );
        winnerRequest = firstValueFrom(interceptor.intercept(makeContext(100).context, winner));
        await started.promise;
        if (scenario !== 'processing')
          await expect(winnerRequest).resolves.toEqual({ id: 'winner' });
        const winnerRecord = await storage.get(globalRequestKey('K-race'));
        expect(winnerRecord).toMatchObject({
          status: scenario === 'processing' ? 'PROCESSING' : 'COMPLETED',
        });
        permitCreate.resolve();
        const outcome = await result;
        if (scenario === 'replay') {
          expect(outcome).toEqual({ value: { id: 'winner' }, error: undefined });
          expect(loserContext.res.statusCode).toBe(201);
        } else {
          expect(outcome.error).toMatchObject({ status: scenario === 'mismatch' ? 422 : 409 });
          expect(outcome.value).toBeUndefined();
        }
        expect(loser.handleSpy).not.toHaveBeenCalled();
        expect(winner.handleSpy).toHaveBeenCalledTimes(1);
        expect(create).toHaveBeenCalledTimes(2);
        expect(await storage.get(globalRequestKey('K-race'))).toEqual(
          scenario === 'vanished' ? null : winnerRecord,
        );
        if (scenario === 'processing') {
          work.next({ id: 'winner' });
          work.complete();
          await expect(winnerRequest).resolves.toEqual({ id: 'winner' });
        }
      } finally {
        permitCreate.resolve();
        work.next({ id: 'cleanup' });
        work.complete();
        await Promise.allSettled([result, ...(winnerRequest ? [winnerRequest] : [])]);
        await storage.onModuleDestroy();
        jest.restoreAllMocks();
      }
    },
  );
});
