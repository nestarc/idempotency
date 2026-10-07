/**
 * BUG: The benchmark accepted malformed options, selected the next percentile
 * rank, and let stalled or truncated HTTP responses masquerade as useful runs.
 * FIX: Validate configuration before connecting, use nearest-rank percentiles,
 * and bound the complete HTTP exchange while retaining status/body for the
 * runner's correctness assertions. Explicit keep-alive makes runs comparable.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { postJSON, type BenchmarkAddress } from '../../bench/http';
import { parseOptions } from '../../bench/options';
import { computeStats } from '../../bench/statistics';

describe('REGRESSION: benchmark configuration', () => {
  it('uses both service environment variables and explicit arguments take precedence', () => {
    const env = {
      TEST_REDIS_URL: 'redis://localhost:6379/2',
      TEST_DATABASE_URL: 'postgresql://test:secret@localhost/benchmark',
    };
    expect(parseOptions(['--require-services'], env)).toMatchObject({
      redisUrl: env.TEST_REDIS_URL,
      postgresUrl: env.TEST_DATABASE_URL,
      iterations: 200,
      warmup: 20,
      requestTimeoutMs: 5000,
      adapter: 'express',
    });
    expect(
      parseOptions(
        ['--redis-url', 'rediss://other:6380', '--postgres-url', 'postgres://other/test'],
        env,
      ),
    ).toMatchObject({ redisUrl: 'rediss://other:6380', postgresUrl: 'postgres://other/test' });
  });

  it('permits zero warmup and all declared adapters', () => {
    for (const adapter of ['express', 'fastify', 'both']) {
      expect(parseOptions(['--warmup', '0', '--adapter', adapter], {})).toMatchObject({
        warmup: 0,
        adapter,
      });
    }
  });

  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '01', '1e2', '+1', '1000001', '9007199254740992'])(
    'rejects invalid iteration count %s before measuring',
    (value) => expect(() => parseOptions(['--iterations', value], {})).toThrow('--iterations'),
  );

  it.each(
    [
      ['--unknown'],
      ['--iterations=3'],
      ['--iterations'],
      ['--iterations', '--warmup', '1'],
      ['--iterations', '2', '--iterations', '3'],
      ['--require-services', '--require-services'],
      ['--warmup', '-1'],
      ['--request-timeout-ms', '0'],
      ['--request-timeout-ms', '300001'],
      ['--adapter', 'koa'],
      ['--output', 'report\n.json'],
    ].map((args) => ({ args })),
  )('rejects malformed argument list $args', ({ args }) => {
    expect(() => parseOptions(args, {})).toThrow();
  });

  it.each([
    {},
    { TEST_REDIS_URL: 'redis://localhost:6379' },
    { TEST_DATABASE_URL: 'postgresql://localhost/test' },
  ])('fails required services when either endpoint is absent: %j', (env) => {
    expect(() => parseOptions(['--require-services'], env)).toThrow('requires both');
  });

  it('rejects invalid URLs without disclosing their credential-bearing values', () => {
    for (const [flag, value] of [
      ['--redis-url', 'https://user:private-password@example.test'],
      ['--postgres-url', 'postgresql://user:private-password@/test'],
      ['--redis-url', 'redis://user:private-password@localhost\n'],
    ]) {
      let thrown: unknown;
      try {
        parseOptions([flag, value], {});
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).not.toContain('private-password');
      expect(String(thrown)).not.toContain(value);
    }
  });

  it('keeps help usable when ambient service configuration is invalid', () => {
    expect(parseOptions(['--help'], { TEST_REDIS_URL: 'invalid' }).help).toBe(true);
  });
});

describe('REGRESSION: benchmark percentiles', () => {
  it('uses nearest-rank p50/p95/p99 and does not mutate input', () => {
    const samples = Array.from({ length: 100 }, (_, index) => 100 - index);
    expect(computeStats(samples)).toEqual({
      count: 100,
      avg: 50.5,
      min: 1,
      max: 100,
      p50: 50,
      p95: 95,
      p99: 99,
    });
    expect(samples[0]).toBe(100);
  });

  it('handles a single zero-duration sample and finite values whose sum overflows', () => {
    expect(computeStats([0])).toEqual({ count: 1, avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 });
    expect(computeStats([Number.MAX_VALUE, Number.MAX_VALUE]).avg).toBe(Number.MAX_VALUE);
  });

  it.each([[], [-1], [NaN], [Infinity], [-Infinity]].map((samples) => ({ samples })))(
    'rejects unusable sample set $samples',
    ({ samples }) => {
      expect(() => computeStats(samples)).toThrow();
    },
  );
});

async function withServer(
  handler: http.RequestListener,
  check: (address: BenchmarkAddress, agent: http.Agent) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    await check({ host: '127.0.0.1', port: address.port }, agent);
  } finally {
    agent.destroy();
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

describe('REGRESSION: complete and bounded benchmark HTTP transport', () => {
  it('preserves error status/body for correctness checks and reuses the explicit connection', async () => {
    const sockets = new Set<http.IncomingMessage['socket']>();
    await withServer(
      (request, response) => {
        sockets.add(request.socket);
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          response.writeHead(500, { 'idempotency-status': 'store_error' });
          response.end(Buffer.concat(chunks));
        });
      },
      async (address, agent) => {
        for (let iteration = 0; iteration < 2; iteration++) {
          const response = await postJSON(address, '/probe', { amount: 1 }, {}, agent, 2000);
          expect(response).toMatchObject({ status: 500, body: '{"amount":1}' });
          expect(response.headers['idempotency-status']).toBe('store_error');
          expect(Number.isFinite(response.durationMs)).toBe(true);
          expect(response.durationMs).toBeGreaterThanOrEqual(0);
        }
        expect(sockets.size).toBe(1);
      },
    );
  });

  it('enforces an overall deadline even while response bytes keep arriving', async () => {
    const timers = new Set<ReturnType<typeof setInterval>>();
    try {
      await withServer(
        (_request, response) => {
          response.writeHead(201);
          response.write('a');
          const timer = setInterval(() => response.write('a'), 10);
          timers.add(timer);
          response.on('close', () => {
            clearInterval(timer);
            timers.delete(timer);
          });
        },
        async (address, agent) => {
          const started = performance.now();
          await expect(postJSON(address, '/', {}, {}, agent, 100)).rejects.toThrow(
            'overall deadline',
          );
          // A generous bound detects a hanging/inactivity-only timeout without
          // turning scheduler noise into a latency-performance requirement.
          expect(performance.now() - started).toBeLessThan(2000);
        },
      );
    } finally {
      for (const timer of timers) clearInterval(timer);
    }
  });

  it('rejects a response whose advertised body is truncated', async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(201, { 'Content-Length': '100' });
        response.write('partial');
        setImmediate(() => response.destroy());
      },
      async (address, agent) => {
        await expect(postJSON(address, '/', {}, {}, agent, 2000)).rejects.toThrow(
          /aborted|before completion|request failed/,
        );
      },
    );
  });

  it('rejects oversized responses instead of retaining unbounded data', async () => {
    await withServer(
      (_request, response) => response.end(Buffer.alloc(1024 * 1024 + 1)),
      async (address, agent) => {
        await expect(postJSON(address, '/', {}, {}, agent, 2000)).rejects.toThrow('1 MiB limit');
      },
    );
  });

  it('rejects connection errors rather than leaving measurement pending', async () => {
    await withServer(
      (request) => request.socket.destroy(),
      async (address, agent) => {
        await expect(postJSON(address, '/', {}, {}, agent, 2000)).rejects.toThrow('request failed');
      },
    );
  });
});
