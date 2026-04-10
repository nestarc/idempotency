/**
 * Idempotency benchmark — measures interceptor overhead and replay speed.
 *
 * Scenarios:
 *   A) POST — no idempotency (baseline)
 *   B) First request — MemoryStorage
 *   C) Replay — MemoryStorage
 *   D) First request — RedisStorage
 *   E) Replay — RedisStorage
 *
 * Usage:
 *   npx ts-node bench/idempotency.bench.ts
 *   npx ts-node bench/idempotency.bench.ts --iterations 500
 *   npx ts-node bench/idempotency.bench.ts --redis-url redis://localhost:6379
 */
import 'reflect-metadata';
import {
  Body,
  Controller,
  HttpCode,
  Module,
  Post,
  UseInterceptors,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import http from 'http';

import { IdempotencyModule } from '../src/idempotency.module';
import { IdempotencyInterceptor } from '../src/idempotency.interceptor';
import { Idempotent } from '../src/idempotency.decorator';
import { MemoryStorage } from '../src/storage/memory.storage';
import type { IdempotencyStorage } from '../src/interfaces/idempotency-storage.interface';

// ── CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const ITERATIONS = Number(flag('iterations', '200'));
const WARMUP = Number(flag('warmup', '20'));
const REDIS_URL = flag('redis-url', '');

// Unique run ID ensures keys never collide across repeated executions
// (Redis TTL is 86400s — without this, a second run replays cached
// responses from the first, measuring "replay" instead of "first request").
const RUN_ID = Date.now().toString(36);

// ── Test controllers ──────────────────────────────────────────────────
@Controller('baseline')
class BaselineController {
  @Post()
  @HttpCode(201)
  create(@Body() dto: { amount: number }) {
    return { id: 'pay_1', amount: dto.amount };
  }
}

@Controller('idempotent')
class IdempotentController {
  @Post()
  @HttpCode(201)
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: { amount: number }) {
    return { id: 'pay_1', amount: dto.amount };
  }
}

// ── HTTP helper (zero-dep, no supertest overhead) ─────────────────────
function postJSON(
  server: http.Server,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        method: 'POST',
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
        port: (server.address() as { port: number }).port,
        host: '127.0.0.1',
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

// ── Stats ─────────────────────────────────────────────────────────────
interface Stats {
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

function computeStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    avg: sum / sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
  };
}

function fmt(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

// ── Runner ────────────────────────────────────────────────────────────
async function measure(
  label: string,
  fn: (i: number) => Promise<void>,
): Promise<Stats> {
  // Warmup — offset indices to avoid key collision with measurement
  for (let i = 0; i < WARMUP; i++) {
    await fn(ITERATIONS + i);
  }

  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await fn(i);
    samples.push(performance.now() - start);
  }

  const stats = computeStats(samples);
  console.log(
    `  ${label.padEnd(42)} Avg ${fmt(stats.avg).padStart(8)}  P50 ${fmt(stats.p50).padStart(8)}  P95 ${fmt(stats.p95).padStart(8)}  P99 ${fmt(stats.p99).padStart(8)}`,
  );
  return stats;
}

// ── App factory ───────────────────────────────────────────────────────
async function createApp(
  storage: IdempotencyStorage,
): Promise<INestApplication> {
  @Module({
    imports: [
      IdempotencyModule.forRoot({ storage, ttl: 86400 }),
    ],
    controllers: [BaselineController, IdempotentController],
  })
  class BenchModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [BenchModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0); // random port
  return app;
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nIdempotency Benchmark (run: ${RUN_ID})`);
  console.log(`  iterations: ${ITERATIONS}, warmup: ${WARMUP}\n`);

  // ── Memory Storage scenarios ────────────────────────────────────
  const memStorage = new MemoryStorage();
  const memApp = await createApp(memStorage);
  const memServer = memApp.getHttpServer() as http.Server;

  const requestBody = { amount: 100 };

  // A) Baseline — no idempotency
  await measure('A) POST — no idempotency (baseline)', async () => {
    await postJSON(memServer, '/baseline', requestBody);
  });

  // B) First request — MemoryStorage (each iteration uses a unique key)
  await measure('B) First request — MemoryStorage', async (i) => {
    await postJSON(memServer, '/idempotent', requestBody, {
      'Idempotency-Key': `${RUN_ID}-first-mem-${i}`,
    });
  });

  // C) Replay — MemoryStorage
  const replayMemKey = `${RUN_ID}-replay-mem`;
  await postJSON(memServer, '/idempotent', requestBody, {
    'Idempotency-Key': replayMemKey,
  });
  await measure('C) Replay — MemoryStorage', async () => {
    await postJSON(memServer, '/idempotent', requestBody, {
      'Idempotency-Key': replayMemKey,
    });
  });

  await memApp.close();

  // ── Redis Storage scenarios (optional) ──────────────────────────
  if (REDIS_URL) {
    let RedisStorageCtor: typeof import('../src/storage/redis.storage').RedisStorage;
    let RedisClient: any;
    try {
      const ioredis = await import('ioredis');
      RedisClient = ioredis.default ?? ioredis;
      RedisStorageCtor = (await import('../src/storage/redis.storage')).RedisStorage;
    } catch {
      console.log('\n  [skip] ioredis not available — skipping Redis benchmarks\n');
      return;
    }

    const client = new RedisClient(REDIS_URL);
    const redisStorage = new RedisStorageCtor({ client });
    const redisApp = await createApp(redisStorage);
    const redisServer = redisApp.getHttpServer() as http.Server;

    // D) First request — RedisStorage
    await measure('D) First request — RedisStorage', async (i) => {
      await postJSON(redisServer, '/idempotent', requestBody, {
        'Idempotency-Key': `${RUN_ID}-first-redis-${i}`,
      });
    });

    // E) Replay — RedisStorage
    const replayRedisKey = `${RUN_ID}-replay-redis`;
    await postJSON(redisServer, '/idempotent', requestBody, {
      'Idempotency-Key': replayRedisKey,
    });
    await measure('E) Replay — RedisStorage', async () => {
      await postJSON(redisServer, '/idempotent', requestBody, {
        'Idempotency-Key': replayRedisKey,
      });
    });

    await redisApp.close();
    await client.quit();
  } else {
    console.log(
      '\n  [skip] No --redis-url provided — skipping Redis benchmarks (D, E)',
    );
    console.log('         Run with: npx ts-node bench/idempotency.bench.ts --redis-url redis://localhost:6379\n');
  }

  console.log('Done.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
