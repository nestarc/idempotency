#!/usr/bin/env node
/** S7 gate: real services are mandatory; the consumer runner verifies public imports. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
for (const name of ['TEST_DATABASE_URL', 'TEST_REDIS_URL']) {
  if (!process.env[name]) {
    console.error(`${name} is required for the adoption gate. Use a test-only service.`);
    process.exit(1);
  }
}

const commands = [
  [
    'test', '--', '--runInBand',
    'test/regression/postgres-sweep-wiring.spec.ts',
    'test/regression/adoption-migration.spec.ts',
  ],
  ['run', 'test:e2e', '--', 'test/e2e/adoption-recipes.e2e-spec.ts'],
  ['run', 'test:consumers'],
];
for (const args of commands) {
  const result = spawnSync('npm', args, { cwd, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
