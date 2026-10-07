/** Sequential loopback HTTP latency with correctness checks. See bench/README.md. */
import 'reflect-metadata';
import {
  Body,
  Controller,
  HttpCode,
  Injectable,
  Post,
  UseInterceptors,
  type INestApplication,
} from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { version as packageVersion } from '../package.json';
import {
  IdempotencyModule,
  IdempotencyInterceptor,
  Idempotent,
  type IdempotencyStorage,
} from '../src/index';
import { postJSON, type BenchmarkAddress } from './http';
import { BENCHMARK_HELP, parseOptions, type BenchmarkOptions } from './options';
import { computeStats, type Stats } from './statistics';
import {
  createBenchmarkStorage,
  BenchmarkStorageSetupError,
  type BenchmarkStorageKind,
  type BenchmarkStorageHandle,
} from './storage';
import { assertBenchmarkResponse, type ExpectedOutcome } from './validation';

type Adapter = 'express' | 'fastify';
type Scenario = 'baseline' | 'first' | 'replay';

@Injectable()
class HandlerCalls {
  baseline = 0;
  idempotent = 0;
}

@Controller('baseline')
class BaselineController {
  constructor(private readonly calls: HandlerCalls) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: { amount: number }) {
    this.calls.baseline++;
    return { id: 'pay_1', amount: dto.amount };
  }
}

@Controller('idempotent')
class IdempotentController {
  constructor(private readonly calls: HandlerCalls) {}

  @Post()
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: { amount: number }) {
    this.calls.idempotent++;
    return { id: 'pay_1', amount: dto.amount };
  }
}

interface ScenarioResult {
  scenario: Scenario;
  warmup: number;
  samplesMs: number[];
  latencyMs: Stats;
}

export interface BenchmarkCell {
  adapter: Adapter;
  storage: BenchmarkStorageKind;
  namespaceId: string;
  status: 'pending' | 'pass' | 'fail' | 'skipped' | 'not-run';
  cleanup: 'not-needed' | 'pass' | 'fail';
  reason?: string;
  metadata?: Record<string, string>;
  handlerCalls?: { baseline: number; idempotent: number };
  scenarios: ScenarioResult[];
}

export interface BenchmarkReport {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: 'pass' | 'pass-with-skips' | 'fail';
  error?: string;
  environment: Record<string, unknown>;
  configuration: {
    iterations: number;
    warmup: number;
    requestTimeoutMs: number;
    adapter: BenchmarkOptions['adapter'];
    requireServices: boolean;
    redisConfigured: boolean;
    postgresConfigured: boolean;
    concurrency: 1;
    keepAlive: true;
    ttlSeconds: 86400;
    requestBody: { amount: number };
    percentileMethod: 'nearest-rank';
  };
  cells: BenchmarkCell[];
}

function environment(): Record<string, unknown> {
  const root = path.resolve(__dirname, '..');
  const git = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
    } catch {
      return null;
    }
  };
  const versions: Record<string, string> = {};
  for (const name of [
    '@nestjs/common',
    '@nestjs/core',
    '@nestjs/platform-express',
    '@nestjs/platform-fastify',
    'ioredis',
    'pg',
    'typescript',
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as {
        version: string;
      };
      versions[name] = pkg.version;
    } catch {
      versions[name] = 'unavailable';
    }
  }
  const changes = git(['status', '--porcelain']);
  return {
    packageVersion,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    versions,
    sourceCommit: git(['rev-parse', 'HEAD']),
    sourceDirty: changes === null ? null : changes.length > 0,
    measurement: 'Sequential loopback HTTP round-trip through the complete response body',
  };
}

class BenchmarkAppSetupError extends Error {
  constructor() {
    super('Benchmark application startup and cleanup failed.');
  }
}

async function createApp(storage: IdempotencyStorage, adapter: Adapter): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [IdempotencyModule.forRoot({ storage, ttl: 86400 })],
    controllers: [BaselineController, IdempotentController],
    providers: [HandlerCalls],
  }).compile();
  let app: INestApplication | undefined;
  try {
    app =
      adapter === 'fastify'
        ? moduleRef.createNestApplication(new FastifyAdapter(), { logger: false })
        : moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    return app;
  } catch (error) {
    try {
      if (app) await app.close();
      else await moduleRef.close();
    } catch {
      throw new BenchmarkAppSetupError();
    }
    throw error;
  }
}

function errorMessage(error: unknown, options: BenchmarkOptions): string {
  let message = error instanceof Error ? error.message : 'Unknown benchmark failure.';
  for (const value of [options.redisUrl, options.postgresUrl]) {
    if (!value) continue;
    message = message.split(value).join('[service URL]');
    const url = new URL(value);
    for (const secret of [url.username, url.password]) {
      if (secret) {
        message = message.split(secret).join('[redacted]');
        try {
          message = message.split(decodeURIComponent(secret)).join('[redacted]');
        } catch {
          // An encoded URL component need not have a decoded representation.
        }
      }
    }
  }
  return message.replace(/(?:postgres(?:ql)?|rediss?):\/\/\S+/gi, '[service URL]');
}

async function runCell(
  cell: BenchmarkCell,
  options: BenchmarkOptions,
  signal?: AbortSignal,
): Promise<void> {
  let handle: BenchmarkStorageHandle | undefined;
  let app: INestApplication | undefined;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const checkAbort = (): void => {
    if (signal?.aborted) throw new Error('Benchmark interrupted.');
  };
  const failures: string[] = [];
  try {
    checkAbort();
    handle = await createBenchmarkStorage(cell.storage, options, cell.namespaceId);
    cell.metadata = handle.metadata;
    app = await createApp(handle.storage, cell.adapter);
    const bound = (app.getHttpServer() as http.Server).address();
    if (!bound || typeof bound === 'string') throw new Error('Benchmark app has no TCP address.');
    const address: BenchmarkAddress = { host: '127.0.0.1', port: bound.port };
    const calls = app.get(HandlerCalls);

    const request = async (expected: ExpectedOutcome, key?: string): Promise<number> => {
      checkAbort();
      const counter = expected === 'baseline' ? 'baseline' : 'idempotent';
      const before = calls[counter];
      const response = await postJSON(
        address,
        expected === 'baseline' ? '/baseline' : '/idempotent',
        { amount: expected === 'mismatch' ? 101 : 100 },
        key ? { 'Idempotency-Key': key } : {},
        agent,
        options.requestTimeoutMs,
      );
      assertBenchmarkResponse(response, expected, before, calls[counter]);
      checkAbort();
      return response.durationMs;
    };

    // Establish the HTTP connection before sampling, including with --warmup 0.
    await request('baseline');
    const replayKey = `${cell.namespaceId}-replay`;
    await request('created', replayKey);
    await request('replayed', replayKey);
    await request('mismatch', replayKey);
    await request('replayed', replayKey);

    const measure = async (
      scenario: Scenario,
      fn: (key: string) => Promise<number>,
    ): Promise<void> => {
      for (let i = 0; i < options.warmup; i++) {
        await fn(`${cell.namespaceId}-${scenario}-warmup-${i}`);
      }
      const samplesMs: number[] = [];
      for (let i = 0; i < options.iterations; i++) {
        samplesMs.push(await fn(`${cell.namespaceId}-${scenario}-sample-${i}`));
      }
      cell.scenarios.push({
        scenario,
        warmup: options.warmup,
        samplesMs,
        latencyMs: computeStats(samplesMs),
      });
    };
    await measure('baseline', () => request('baseline'));
    await measure('first', (key) => request('created', key));
    await measure('replay', () => request('replayed', replayKey));
    cell.handlerCalls = { baseline: calls.baseline, idempotent: calls.idempotent };
  } catch (error) {
    if (
      error instanceof BenchmarkAppSetupError ||
      (error instanceof BenchmarkStorageSetupError && error.cleanupFailed)
    ) {
      cell.cleanup = 'fail';
    }
    failures.push(errorMessage(error, options));
  } finally {
    agent.destroy();
    // Always clean storage, including after an app shutdown failure.
    for (const cleanup of [app?.close.bind(app), handle?.cleanup.bind(handle)]) {
      if (!cleanup) continue;
      try {
        await cleanup();
      } catch (error) {
        cell.cleanup = 'fail';
        failures.push(`Cleanup: ${errorMessage(error, options)}`);
      }
    }
    if (cell.cleanup !== 'fail') cell.cleanup = 'pass';
  }
  if (failures.length > 0) {
    cell.status = 'fail';
    cell.reason = failures.join(' ');
    cell.scenarios = [];
    throw new Error(cell.reason);
  }
  cell.status = 'pass';
}

/** Exported for regression tests; importing never starts a benchmark. */
export async function runBenchmark(
  options: BenchmarkOptions,
  signal?: AbortSignal,
): Promise<BenchmarkReport> {
  const report: BenchmarkReport = {
    schemaVersion: 1,
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    status: 'fail',
    environment: environment(),
    configuration: {
      iterations: options.iterations,
      warmup: options.warmup,
      requestTimeoutMs: options.requestTimeoutMs,
      adapter: options.adapter,
      requireServices: options.requireServices,
      redisConfigured: Boolean(options.redisUrl),
      postgresConfigured: Boolean(options.postgresUrl),
      concurrency: 1,
      keepAlive: true,
      ttlSeconds: 86400,
      requestBody: { amount: 100 },
      percentileMethod: 'nearest-rank',
    },
    cells: [],
  };
  const adapters: Adapter[] =
    options.adapter === 'both' ? ['express', 'fastify'] : [options.adapter];
  for (const adapter of adapters) {
    for (const storage of ['memory', 'redis', 'postgres'] as const) {
      const missing =
        (storage === 'redis' && !options.redisUrl) ||
        (storage === 'postgres' && !options.postgresUrl);
      report.cells.push({
        adapter,
        storage,
        namespaceId: randomUUID(),
        status: missing ? 'skipped' : 'pending',
        cleanup: 'not-needed',
        ...(missing ? { reason: 'Service URL not configured.' } : {}),
        scenarios: [],
      });
    }
  }
  try {
    if (options.requireServices && (!options.redisUrl || !options.postgresUrl)) {
      throw new Error('--require-services requires both Redis and PostgreSQL service URLs.');
    }
    for (const cell of report.cells) {
      if (cell.status !== 'skipped') await runCell(cell, options, signal);
    }
    if (signal?.aborted) throw new Error('Benchmark interrupted.');
    report.status = report.cells.some((cell) => cell.status === 'skipped')
      ? 'pass-with-skips'
      : 'pass';
  } catch (error) {
    report.error = errorMessage(error, options);
  }
  for (const cell of report.cells) {
    if (cell.status === 'pending') cell.status = 'not-run';
    // Discard partial timings when any cell or cleanup invalidated the run.
    if (report.status === 'fail') cell.scenarios = [];
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

async function main(): Promise<void> {
  const options = parseOptions();
  if (options.help) {
    console.log(BENCHMARK_HELP);
    return;
  }
  const output = options.output ? await open(options.output, 'wx', 0o600) : undefined;
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    console.log('Running sequential loopback HTTP benchmark (concurrency 1, keep-alive).');
    const report = await runBenchmark(options, controller.signal);
    if (output) await output.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
    for (const cell of report.cells) {
      console.log(
        `[${cell.status}] ${cell.adapter}/${cell.storage}${cell.reason ? `: ${cell.reason}` : ''}`,
      );
      for (const result of cell.scenarios) {
        const stats = result.latencyMs;
        console.log(
          `  ${result.scenario.padEnd(8)} n=${stats.count} avg=${stats.avg.toFixed(3)}ms p50=${stats.p50.toFixed(3)}ms p95=${stats.p95.toFixed(3)}ms p99=${stats.p99.toFixed(3)}ms`,
        );
      }
    }
    console.log(`Result: ${report.status}. These timings are diagnostics, not a release gate.`);
    if (options.iterations < 1000) {
      console.log(
        'Small sample count: tail percentiles are unstable; repeat longer runs for comparisons.',
      );
    }
    if (report.status === 'fail') {
      console.error(report.error);
      process.exitCode = 1;
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await output?.close();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    // CLI errors omit values. Avoid dumping filesystem paths or driver stacks.
    console.error(
      error instanceof Error && !('code' in error)
        ? error.message
        : 'Benchmark could not read or write its report. Use a fresh, writable output path.',
    );
    process.exitCode = 1;
  });
}
