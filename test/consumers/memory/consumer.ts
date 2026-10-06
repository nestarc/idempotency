import { MemoryStorage } from '@nestarc/idempotency';
import { consumerOptions } from './common/public-api';

export const options = consumerOptions(new MemoryStorage());
