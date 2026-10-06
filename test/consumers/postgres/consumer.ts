import {
  PostgresStorage,
  PostgresSweepService,
  type PostgresStorageOptions,
  type SweepOptions,
} from '@nestarc/idempotency/postgres';
import { Pool } from 'pg';
import { consumerOptions } from './common/public-api';

export const storageOptions: PostgresStorageOptions = {
  connection: { host: '127.0.0.1' },
  poolFactory: (connection) => new Pool(connection),
  tableName: 'consumer_typecheck',
};
export const storage = new PostgresStorage(storageOptions);
export const options = consumerOptions(storage);
export const sweepOptions: SweepOptions = { enabled: false, intervalMs: 60_000 };
export const sweep = new PostgresSweepService(storage, sweepOptions);
