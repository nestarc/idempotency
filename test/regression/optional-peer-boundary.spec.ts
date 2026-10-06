/**
 * Optional drivers used to be pulled in by the root barrel: the pg value
 * import failed even for Memory-only users. Keep root/subpath imports and
 * injected clients driver-free, diagnose a missing owned driver precisely,
 * and retain the DatabaseError identity check in the lazy PG error path.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

const missingModule = (name: string): Error =>
  Object.assign(new Error(`Cannot find module '${name}'`), {
    code: 'MODULE_NOT_FOUND',
  });

const loadPostgres = (): typeof import('../../src/postgres') => require('../../src/postgres');
const loadRedis = (): typeof import('../../src/redis') => require('../../src/redis');

describe('optional peer boundaries', () => {
  beforeEach(() => jest.resetModules());
  afterEach(() => {
    jest.dontMock('pg');
    jest.dontMock('ioredis');
  });

  it('imports root and both adapter subpaths without evaluating either driver', () => {
    const pgLoader = jest.fn(() => {
      throw missingModule('pg');
    });
    const redisLoader = jest.fn(() => {
      throw missingModule('ioredis');
    });
    jest.doMock('pg', pgLoader);
    jest.doMock('ioredis', redisLoader);

    const root = require('../../src') as typeof import('../../src');
    expect(root.MemoryStorage).toBeDefined();
    expect(root).not.toHaveProperty('RedisStorage');
    expect(root).not.toHaveProperty('PostgresStorage');
    expect(root).not.toHaveProperty('PostgresSweepService');
    expect(loadPostgres().PostgresSweepService).toBeDefined();
    expect(loadRedis().RedisStorage).toBeDefined();
    expect(pgLoader).not.toHaveBeenCalled();
    expect(redisLoader).not.toHaveBeenCalled();
  });

  it('uses supplied clients and factories without loading drivers', async () => {
    const pgLoader = jest.fn(() => {
      throw missingModule('pg');
    });
    const redisLoader = jest.fn(() => {
      throw missingModule('ioredis');
    });
    jest.doMock('pg', pgLoader);
    jest.doMock('ioredis', redisLoader);
    const { PostgresStorage } = loadPostgres();
    const { RedisStorage } = loadRedis();
    const pool = {
      query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
      end: jest.fn(),
    } as unknown as Pool;
    const client = {
      defineCommand: jest.fn(),
      hgetall: jest.fn().mockResolvedValue({}),
      quit: jest.fn(),
    } as unknown as Redis;
    const suppliedPg = new PostgresStorage({ pool });
    const suppliedRedis = new RedisStorage({ client });
    await expect(suppliedPg.get('missing')).resolves.toBeNull();
    await expect(suppliedRedis.get('missing')).resolves.toBeNull();
    await suppliedPg.close();
    await suppliedRedis.close();
    expect(pool.end).not.toHaveBeenCalled();
    expect(client.quit).not.toHaveBeenCalled();

    await new PostgresStorage({ connection: {}, poolFactory: () => pool }).close();
    await new RedisStorage({ connection: {}, clientFactory: () => client }).close();
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(pgLoader).not.toHaveBeenCalled();
    expect(redisLoader).not.toHaveBeenCalled();
  });

  it.each(['pg', 'ioredis'])(
    'explains installation only when constructing an owned %s connection',
    (peer) => {
      const cause = missingModule(peer);
      jest.doMock(peer, () => {
        throw cause;
      });
      const construct = () =>
        peer === 'pg'
          ? new (loadPostgres().PostgresStorage)({ connection: {} })
          : new (loadRedis().RedisStorage)({ connection: {} });
      expect(construct).toThrow(`npm install ${peer}`);
      try {
        construct();
      } catch (error) {
        expect((error as Error).cause).toBe(cause);
      }
    },
  );

  it.each(['pg', 'ioredis'])(
    'preserves initialization failures and missing transitive dependencies of %s',
    (peer) => {
      for (const failure of [
        new Error('initialization failed'),
        missingModule('nested-driver-dependency'),
      ]) {
        jest.doMock(peer, () => {
          throw failure;
        });
        const construct = () =>
          peer === 'pg'
            ? new (loadPostgres().PostgresStorage)({ connection: {} })
            : new (loadRedis().RedisStorage)({ connection: {} });
        expect(construct).toThrow(failure);
      }
    },
  );

  it('preserves unrelated injected-pool errors without attempting to load pg', async () => {
    const pgLoader = jest.fn(() => {
      throw missingModule('pg');
    });
    jest.doMock('pg', pgLoader);
    const failure = new Error('connection lost');
    const pool = { query: jest.fn().mockRejectedValue(failure) } as unknown as Pool;
    const storage = new (loadPostgres().PostgresStorage)({ pool });
    await expect(storage.complete('key', 'token', { statusCode: 200 }, 60)).rejects.toBe(failure);
    await expect(storage.delete('key', 'token')).rejects.toBe(failure);
    expect(pgLoader).not.toHaveBeenCalled();
  });

  it('preserves a 22P02 lookalike when the injected pool has no pg driver', async () => {
    jest.doMock('pg', () => {
      throw missingModule('pg');
    });
    const failure = Object.assign(new Error('not a DatabaseError'), { code: '22P02' });
    const pool = { query: jest.fn().mockRejectedValue(failure) } as unknown as Pool;
    const storage = new (loadPostgres().PostgresStorage)({ pool });
    await expect(storage.complete('key', 'token', { statusCode: 200 }, 60)).rejects.toBe(failure);
    await expect(storage.delete('key', 'token')).rejects.toBe(failure);
  });

  it('maps only pg DatabaseError instances with SQLSTATE 22P02 to stale', async () => {
    const { DatabaseError } = jest.requireActual<typeof import('pg')>('pg');
    const malformedToken = new DatabaseError('invalid uuid', 0, 'error');
    malformedToken.code = '22P02';
    const query = jest.fn().mockRejectedValue(malformedToken);
    const storage = new (loadPostgres().PostgresStorage)({ pool: { query } as unknown as Pool });
    await expect(storage.complete('key', 'wrong-token', { statusCode: 200 }, 60)).resolves.toBe(
      'stale',
    );
    query.mockRejectedValueOnce(malformedToken).mockResolvedValueOnce({ rowCount: 1, rows: [{}] });
    await expect(storage.delete('key', 'wrong-token')).resolves.toBe('stale');

    const lookalike = Object.assign(new Error('not a DatabaseError'), { code: '22P02' });
    query.mockRejectedValue(lookalike);
    await expect(storage.complete('key', 'token', { statusCode: 200 }, 60)).rejects.toBe(lookalike);
    const otherDatabaseError = new DatabaseError('not invalid text', 0, 'error');
    otherDatabaseError.code = '08006';
    query.mockRejectedValue(otherDatabaseError);
    await expect(storage.delete('key', 'token')).rejects.toBe(otherDatabaseError);
  });
});
