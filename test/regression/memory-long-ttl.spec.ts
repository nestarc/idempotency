import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { MemoryStorage } from '../../src/storage/memory.storage';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_TTL_SECONDS = 2_147_483_647;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const START = new Date('2026-10-07T00:00:00Z').getTime();

describe('REGRESSION: Memory deadline-based eviction with long TTLs', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await storage.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each([
    ['create', THIRTY_DAYS_SECONDS],
    ['create', MAX_TTL_SECONDS],
    ['complete', THIRTY_DAYS_SECONDS],
    ['complete', MAX_TTL_SECONDS],
  ] as const)('%s retains a %s-second record until its exact deadline', async (operation, ttl) => {
    const timerSpy = jest.spyOn(global, 'setTimeout');
    const created = await storage.create('key', 'fp', operation === 'create' ? ttl : 60);
    if (operation === 'complete') {
      await expect(
        storage.complete('key', created.token!, { statusCode: 201, body: 'first' }, ttl),
      ).resolves.toBe('ok');
    }
    const original = await storage.get('key');
    expect(original!.expiresAt.getTime()).toBe(START + ttl * 1000);

    jest.advanceTimersByTime(MAX_TIMER_DELAY_MS);
    expect(await storage.get('key')).toEqual(original);
    expect(jest.getTimerCount()).toBe(1);

    // The maximum TTL crosses 1,000 native timer windows. All chunks must
    // preserve the original deadline instead of granting a fresh TTL.
    jest.advanceTimersByTime(ttl * 1000 - MAX_TIMER_DELAY_MS - 1);
    expect(await storage.get('key')).toEqual(original);
    expect(jest.getTimerCount()).toBe(1);
    for (const [, delay] of timerSpy.mock.calls) {
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
    }
    if (ttl === MAX_TTL_SECONDS) {
      expect(timerSpy).toHaveBeenCalledTimes(operation === 'create' ? 1000 : 1001);
    }

    jest.advanceTimersByTime(1);
    expect(jest.getTimerCount()).toBe(0);
    await expect(storage.get('key')).resolves.toBeNull();
  });

  it.each([-1, 0, 1])(
    'honors a long TTL boundary at offset %s ms with timers delayed',
    async (offset) => {
      const { token } = await storage.create('key', 'fp', THIRTY_DAYS_SECONDS);
      jest.setSystemTime(START + THIRTY_DAYS_SECONDS * 1000 + offset);
      await expect(storage.complete('key', token!, { statusCode: 201 }, 60)).resolves.toBe(
        offset < 0 ? 'ok' : 'stale',
      );
      expect(jest.getTimerCount()).toBe(offset < 0 ? 1 : 0);
    },
  );

  it('rechecks the wall clock after rollback and keeps only one pending timer', async () => {
    const timerSpy = jest.spyOn(global, 'setTimeout');
    await storage.create('key', 'fp', 10);
    jest.setSystemTime(START - 60_000);
    jest.advanceTimersByTime(10_000);

    await expect(storage.get('key')).resolves.toMatchObject({ status: 'PROCESSING' });
    expect(timerSpy.mock.calls[1][1]).toBe(60_000);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(59_999);
    await expect(storage.get('key')).resolves.not.toBeNull();
    jest.advanceTimersByTime(1);
    await expect(storage.get('key')).resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a delayed chunk callback evicts immediately when the logical deadline has passed', async () => {
    const timerSpy = jest.spyOn(global, 'setTimeout');
    await storage.create('key', 'fp', THIRTY_DAYS_SECONDS);
    // setSystemTime moves wall time without dispatching the original timer.
    jest.setSystemTime(START + THIRTY_DAYS_SECONDS * 1000 + 1000);
    jest.advanceTimersToNextTimer();
    expect(timerSpy).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    await expect(storage.get('key')).resolves.toBeNull();
  });

  it('a queued processing callback cannot remove or reschedule the completed entry', async () => {
    const timerSpy = jest.spyOn(global, 'setTimeout');
    const { token } = await storage.create('key', 'fp', 1);
    const oldCallback = timerSpy.mock.calls[0][0] as () => void;
    jest.advanceTimersByTime(500);
    await storage.complete('key', token!, { statusCode: 201, body: 'saved' }, THIRTY_DAYS_SECONDS);
    const completed = await storage.get('key');

    jest.setSystemTime(START + 1000);
    oldCallback();
    expect(await storage.get('key')).toEqual(completed);
    expect(timerSpy).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('a queued callback cannot remove or reschedule a replacement owner', async () => {
    const timerSpy = jest.spyOn(global, 'setTimeout');
    await storage.create('key', 'old', 1);
    const oldCallback = timerSpy.mock.calls[0][0] as () => void;
    jest.setSystemTime(START + 1000);
    const replacement = await storage.create('key', 'new', THIRTY_DAYS_SECONDS);
    expect(replacement.acquired).toBe(true);

    oldCallback();
    await expect(storage.get('key')).resolves.toMatchObject({ token: replacement.token });
    expect(timerSpy).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
  });

  it.each(['delete', 'destroy'] as const)(
    '%s clears the current chunk and a queued callback cannot rearm it',
    async (operation) => {
      const timerSpy = jest.spyOn(global, 'setTimeout');
      const { token } = await storage.create('key', 'fp', MAX_TTL_SECONDS);
      jest.advanceTimersByTime(MAX_TIMER_DELAY_MS);
      const queuedCallback = timerSpy.mock.calls.at(-1)![0] as () => void;
      const scheduled = timerSpy.mock.calls.length;
      if (operation === 'delete') await storage.delete('key', token!);
      else await storage.onModuleDestroy();

      expect(jest.getTimerCount()).toBe(0);
      queuedCallback();
      expect(timerSpy).toHaveBeenCalledTimes(scheduled);
      expect(jest.getTimerCount()).toBe(0);
      await expect(storage.get('key')).resolves.toBeNull();
    },
  );
});

it('REGRESSION: native Node timers retain long TTL records without overflow and remain unrefed', () => {
  // A fresh Node process ensures this exercises native timer overflow, outside
  // Jest's timer implementation. Timer bounds and warning checks are decisive;
  // bounded polling additionally verifies survival across native timer turns.
  const probe = spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      '-e',
      `
      const assert = require('node:assert/strict');
      const { performance } = require('node:perf_hooks');
      const { setTimeout: sleep } = require('node:timers/promises');
      const { MemoryStorage } = require('./src/storage/memory.storage');
      const originalSetTimeout = global.setTimeout;
      const scheduled = [];
      const warnings = [];
      process.on('warning', warning => warnings.push(warning.name));
      global.setTimeout = (callback, delay, ...args) => {
        const timer = originalSetTimeout(callback, delay, ...args);
        scheduled.push({ delay, timer });
        return timer;
      };
      (async () => {
        const storage = new MemoryStorage();
        try {
          for (const ttl of [${THIRTY_DAYS_SECONDS}, ${MAX_TTL_SECONDS}]) {
            await storage.create('create-' + ttl, 'fp', ttl);
            const { token } = await storage.create('complete-' + ttl, 'fp', 60);
            await storage.complete('complete-' + ttl, token, { statusCode: 201 }, ttl);
          }
          const started = performance.now();
          let rounds = 0;
          while (rounds < 3 || performance.now() - started < 40) {
            assert.ok(performance.now() - started < 2000, 'polling exceeded 2 seconds');
            await sleep(5);
            rounds++;
            for (const ttl of [${THIRTY_DAYS_SECONDS}, ${MAX_TTL_SECONDS}]) {
              assert.ok(await storage.get('create-' + ttl), 'processing record expired early');
              assert.ok(await storage.get('complete-' + ttl), 'completed record expired early');
            }
          }
          assert.ok(scheduled.every(({ delay }) => delay > 0 && delay <= ${MAX_TIMER_DELAY_MS}));
          assert.ok(scheduled.every(({ timer }) => !timer.hasRef()));
          assert.ok(!warnings.includes('TimeoutOverflowWarning'));
          process.stdout.write('native long-TTL checks passed');
        } finally {
          await storage.onModuleDestroy();
          global.setTimeout = originalSetTimeout;
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
      `,
    ],
    { cwd: resolve(__dirname, '../..'), encoding: 'utf8', timeout: 10_000 },
  );
  expect(probe.error).toBeUndefined();
  expect({ status: probe.status, stderr: probe.stderr }).toEqual({ status: 0, stderr: '' });
  expect(probe.stdout).toBe('native long-TTL checks passed');
});
