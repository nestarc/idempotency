#!/usr/bin/env node
/** Exact versions shared by source CI and installed-tarball consumer checks. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_MAJORS = ['22', '24'];
export const NEST_VERSIONS = Object.fromEntries(
  Object.entries({ 10: '10.4.22', 11: '11.1.18' }).map(([major, version]) => [
    major,
    Object.fromEntries(
      ['common', 'core', 'testing', 'platform-express', 'platform-fastify'].map((name) => [
        `@nestjs/${name}`,
        version,
      ]),
    ),
  ]),
);
export const PEER_PROFILES = {
  representative: { ioredis: '5.10.1', pg: '8.20.0', '@types/pg': '8.20.0' },
  minimum: { ioredis: '5.0.0', pg: '8.11.0', '@types/pg': '8.11.0' },
};

export function matrixVersions(nestMajor = '11', peerProfile = 'representative') {
  assert(Object.hasOwn(NEST_VERSIONS, nestMajor), '--nest must be 10 or 11');
  assert(
    Object.hasOwn(PEER_PROFILES, peerProfile),
    '--peer-profile must be representative or minimum',
  );
  return { ...NEST_VERSIONS[nestMajor], ...PEER_PROFILES[peerProfile] };
}

// Source tests must use the same explicit Nest + adapter + optional-peer pins as
// the tarball consumer. This command changes only the installed development tree.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.equal(
    args.shift(),
    'install',
    'Usage: release-matrix.mjs install --nest 10|11 --peer-profile representative|minimum',
  );
  let nestMajor = '11';
  let peerProfile = 'representative';
  while (args.length) {
    const flag = args.shift();
    assert(args[0] && !args[0].startsWith('--'), `${flag} value required`);
    if (flag === '--nest') nestMajor = args.shift();
    else if (flag === '--peer-profile') peerProfile = args.shift();
    else throw new Error(`Unknown argument: ${flag}`);
  }
  const versions = matrixVersions(nestMajor, peerProfile);
  const result = spawnSync(
    'npm',
    [
      'install',
      '--no-save',
      '--package-lock=false',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...Object.entries(versions).map(([name, version]) => `${name}@${version}`),
    ],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
