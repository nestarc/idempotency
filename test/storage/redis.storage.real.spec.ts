import { Redis } from 'ioredis';

import { RedisStorage } from '../../src/storage/redis.storage';
import { describeStorageContract } from '../support/shared-storage-contract';

const REDIS_URL = process.env.TEST_REDIS_URL;
const describeOrSkip = REDIS_URL ? describe : describe.skip;

if (!REDIS_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[redis.storage.real.spec] TEST_REDIS_URL not set - real Redis tests skipped.',
  );
}

describeOrSkip('RedisStorage real Redis', () => {
  const prefix = `idempotency:test:${Date.now()}:`;

  describeStorageContract('RedisStorage real Redis', async () => {
    const client = new Redis(REDIS_URL!);
    const storage = new RedisStorage({ client, keyPrefix: prefix });
    return {
      storage,
      cleanup: async () => {
        const keys = await client.keys(`${prefix}*`);
        if (keys.length > 0) {
          await client.del(...keys);
        }
        await client.quit();
      },
    };
  });
});
