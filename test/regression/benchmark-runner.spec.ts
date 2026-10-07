/**
 * BUG: The old benchmark recorded unchecked responses as timings and allowed
 * failed setup or teardown to leave partial success output and live resources.
 * FIX: The runner exercises real Memory HTTP on both adapters, proves handler
 * execution and replay invariants, cleans up every failure path, and discards
 * every timing if any configured cell or cleanup fails.
 */
import { NestApplication } from '@nestjs/core/nest-application';
import { Test } from '@nestjs/testing';

import * as benchmarkHttp from '../../bench/http';
import { runBenchmark } from '../../bench/idempotency.bench';
import { parseOptions, type BenchmarkOptions } from '../../bench/options';
import * as benchmarkStorage from '../../bench/storage';

const originalPostJSON = benchmarkHttp.postJSON;
const originalCreateStorage = benchmarkStorage.createBenchmarkStorage;
const originalClose = NestApplication.prototype.close;

function options(extra: string[] = []): BenchmarkOptions {
  return parseOptions(['--iterations', '2', '--warmup', '1', ...extra], {});
}

function trackMemoryCleanup(): jest.Mock<Promise<void>, []> {
  const cleanup = jest.fn<Promise<void>, []>();
  jest
    .spyOn(benchmarkStorage, 'createBenchmarkStorage')
    .mockImplementation(async (kind, opts, id) => {
      if (kind !== 'memory') throw new Error('Unexpected service access in a Memory regression.');
      const handle = await originalCreateStorage(kind, opts, id);
      cleanup.mockImplementation(handle.cleanup);
      return { ...handle, cleanup };
    });
  return cleanup;
}

describe('REGRESSION: trustworthy benchmark orchestration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('measures verified Memory requests on Express and Fastify with explicit skips', async () => {
    const report = await runBenchmark(options(['--adapter', 'both']));

    expect(report.status).toBe('pass-with-skips');
    expect(report.error).toBeUndefined();
    expect(report.finishedAt).toEqual(expect.any(String));
    expect(report.configuration).toMatchObject({
      iterations: 2,
      warmup: 1,
      adapter: 'both',
      concurrency: 1,
      keepAlive: true,
      percentileMethod: 'nearest-rank',
      redisConfigured: false,
      postgresConfigured: false,
    });
    expect(report.cells).toHaveLength(6);
    expect(new Set(report.cells.map((cell) => cell.namespaceId)).size).toBe(6);
    for (const adapter of ['express', 'fastify']) {
      const cell = report.cells.find(
        (candidate) => candidate.adapter === adapter && candidate.storage === 'memory',
      );
      expect(cell).toMatchObject({
        status: 'pass',
        cleanup: 'pass',
        // One initial connection/creation probe plus warmup and measured work.
        // Replay and mismatch probes must never execute the idempotent handler.
        handlerCalls: { baseline: 4, idempotent: 4 },
      });
      expect(cell?.scenarios.map((scenario) => scenario.scenario)).toEqual([
        'baseline',
        'first',
        'replay',
      ]);
      for (const scenario of cell!.scenarios) {
        expect(scenario.warmup).toBe(1);
        expect(scenario.samplesMs).toHaveLength(2);
        expect(scenario.latencyMs.count).toBe(2);
        expect(scenario.samplesMs.every((sample) => Number.isFinite(sample) && sample >= 0)).toBe(
          true,
        );
        expect(
          Object.values(scenario.latencyMs).every((value) => Number.isFinite(value) && value >= 0),
        ).toBe(true);
        expect(scenario.latencyMs.min).toBe(Math.min(...scenario.samplesMs));
        expect(scenario.latencyMs.max).toBe(Math.max(...scenario.samplesMs));
      }
      for (const skipped of report.cells.filter(
        (candidate) => candidate.adapter === adapter && candidate.storage !== 'memory',
      )) {
        expect(skipped).toMatchObject({ status: 'skipped', cleanup: 'not-needed', scenarios: [] });
      }
    }
  });

  it('rejects required services before creating storage or an application', async () => {
    const factory = jest.spyOn(benchmarkStorage, 'createBenchmarkStorage');
    const createApp = jest.spyOn(Test, 'createTestingModule');
    // Defensive API validation still applies when callers bypass CLI parsing.
    const report = await runBenchmark({ ...options(), requireServices: true });

    expect(report.status).toBe('fail');
    expect(report.error).toContain('requires both');
    expect(factory).not.toHaveBeenCalled();
    expect(createApp).not.toHaveBeenCalled();
    expect(
      report.cells.every((cell) => cell.status !== 'pending' && cell.scenarios.length === 0),
    ).toBe(true);
  });

  it('fails a configured service setup and removes timings from earlier successful cells', async () => {
    const redisUrl = 'redis://runner:private-credential@localhost:6379';
    const factory = jest
      .spyOn(benchmarkStorage, 'createBenchmarkStorage')
      .mockImplementation(async (kind, opts, id) => {
        if (kind !== 'memory') throw new Error(`Setup failed for ${redisUrl}`);
        return originalCreateStorage(kind, opts, id);
      });
    const report = await runBenchmark(
      options([
        '--redis-url',
        redisUrl,
        '--postgres-url',
        'postgresql://localhost/benchmark',
        '--require-services',
      ]),
    );

    expect(report.status).toBe('fail');
    expect(report.cells.map((cell) => cell.status)).toEqual(['pass', 'fail', 'not-run']);
    expect(report.cells.every((cell) => cell.scenarios.length === 0)).toBe(true);
    expect(factory.mock.calls.map(([kind]) => kind)).toEqual(['memory', 'redis']);
    expect(report.error).toContain('Setup failed');
    expect(JSON.stringify(report)).not.toContain('private-credential');
    expect(JSON.stringify(report)).not.toContain(redisUrl);
  });

  it('closes the real app and storage after a measured response fails correctness assertions', async () => {
    const cleanup = trackMemoryCleanup();
    const close = jest.spyOn(NestApplication.prototype, 'close');
    jest.spyOn(benchmarkHttp, 'postJSON').mockImplementation(async (...args) => {
      const response = await originalPostJSON(...args);
      if (args[3]['Idempotency-Key']?.endsWith('-first-sample-1')) {
        return { ...response, status: 500 };
      }
      return response;
    });
    const report = await runBenchmark(options());

    expect(report.status).toBe('fail');
    expect(report.cells[0]).toMatchObject({ status: 'fail', cleanup: 'pass', scenarios: [] });
    expect(report.error).toContain('expected HTTP 201, received 500');
    expect(close).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('closes storage and the partially created app when startup fails', async () => {
    const cleanup = trackMemoryCleanup();
    const close = jest.spyOn(NestApplication.prototype, 'close');
    jest
      .spyOn(NestApplication.prototype, 'listen')
      .mockRejectedValueOnce(new Error('Injected startup failure'));
    const request = jest.spyOn(benchmarkHttp, 'postJSON');
    const report = await runBenchmark(options());

    expect(report.status).toBe('fail');
    expect(report.error).toContain('Injected startup failure');
    expect(report.cells[0]).toMatchObject({ status: 'fail', cleanup: 'pass', scenarios: [] });
    expect(close).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  it('invalidates otherwise successful measurements if storage cleanup fails', async () => {
    const cleanup = jest.fn<Promise<void>, []>();
    jest
      .spyOn(benchmarkStorage, 'createBenchmarkStorage')
      .mockImplementation(async (kind, opts, id) => {
        if (kind !== 'memory') throw new Error('Unexpected service access in a Memory regression.');
        const handle = await originalCreateStorage(kind, opts, id);
        cleanup.mockImplementation(async () => {
          await handle.cleanup();
          throw new Error('Injected storage cleanup failure');
        });
        return { ...handle, cleanup };
      });
    const report = await runBenchmark(options());

    expect(report.status).toBe('fail');
    expect(report.error).toContain('Cleanup: Injected storage cleanup failure');
    expect(report.cells[0]).toMatchObject({ status: 'fail', cleanup: 'fail', scenarios: [] });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('records cleanup failure when a partially started app cannot close successfully', async () => {
    const cleanup = trackMemoryCleanup();
    jest
      .spyOn(NestApplication.prototype, 'listen')
      .mockRejectedValueOnce(new Error('Injected startup failure'));
    const close = jest
      .spyOn(NestApplication.prototype, 'close')
      .mockImplementationOnce(async function (this: NestApplication) {
        // Release actual test resources before reporting the injected failure.
        await originalClose.call(this);
        throw new Error('Injected app cleanup failure');
      });
    const report = await runBenchmark(options());

    expect(report.status).toBe('fail');
    expect(report.error).toContain('startup and cleanup failed');
    expect(report.cells[0]).toMatchObject({ status: 'fail', cleanup: 'fail', scenarios: [] });
    expect(close).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('preserves failed namespace cleanup evidence from a storage setup error', async () => {
    jest
      .spyOn(benchmarkStorage, 'createBenchmarkStorage')
      .mockImplementation(async (kind, opts, id) => {
        if (kind === 'memory') return originalCreateStorage(kind, opts, id);
        throw new benchmarkStorage.BenchmarkStorageSetupError(
          'Injected service initialization and namespace cleanup failure',
          true,
        );
      });
    const report = await runBenchmark(options(['--redis-url', 'redis://localhost:6379']));

    expect(report.status).toBe('fail');
    expect(report.cells[1]).toMatchObject({
      storage: 'redis',
      status: 'fail',
      cleanup: 'fail',
      scenarios: [],
    });
    expect(report.error).toContain('namespace cleanup failure');
    expect(report.cells.every((cell) => cell.scenarios.length === 0)).toBe(true);
  });

  it('returns a failed completed report for a pre-aborted signal without starting work', async () => {
    const controller = new AbortController();
    controller.abort();
    const factory = jest.spyOn(benchmarkStorage, 'createBenchmarkStorage');
    const createApp = jest.spyOn(Test, 'createTestingModule');
    const report = await runBenchmark(options(['--adapter', 'both']), controller.signal);

    expect(report.status).toBe('fail');
    expect(report.error).toContain('interrupted');
    expect(report.finishedAt).toEqual(expect.any(String));
    expect(
      report.cells.every((cell) => cell.status !== 'pending' && cell.scenarios.length === 0),
    ).toBe(true);
    expect(factory).not.toHaveBeenCalled();
    expect(createApp).not.toHaveBeenCalled();
  });

  it('does not publish successful timings when interrupted during the final cleanup', async () => {
    const controller = new AbortController();
    const cleanup = jest.fn<Promise<void>, []>();
    jest
      .spyOn(benchmarkStorage, 'createBenchmarkStorage')
      .mockImplementation(async (kind, opts, id) => {
        if (kind !== 'memory') throw new Error('Unexpected service access in a Memory regression.');
        const handle = await originalCreateStorage(kind, opts, id);
        cleanup.mockImplementation(async () => {
          await handle.cleanup();
          controller.abort();
        });
        return { ...handle, cleanup };
      });
    const report = await runBenchmark(options(), controller.signal);

    expect(report.status).toBe('fail');
    expect(report.error).toContain('interrupted');
    expect(report.cells[0]).toMatchObject({ cleanup: 'pass', scenarios: [] });
    expect(report.cells.every((cell) => cell.scenarios.length === 0)).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
