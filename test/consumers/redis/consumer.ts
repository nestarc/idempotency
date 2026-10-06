import { RedisStorage, type RedisStorageOptions } from '@nestarc/idempotency/redis';
import Redis from 'ioredis';
import { consumerOptions } from './common/public-api';

export const storageOptions: RedisStorageOptions = {
  connection: { host: '127.0.0.1', lazyConnect: true },
  clientFactory: (connection) => new Redis(connection),
  keyPrefix: 'consumer-types:',
};
export const options = consumerOptions(new RedisStorage(storageOptions));
