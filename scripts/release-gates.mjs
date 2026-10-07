/** Fail-closed, independently testable S8 evidence checks. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { matrixVersions } from './release-matrix.mjs';

// Reviewed source-test baseline (2026-10-07). Deleting or excluding a spec
// requires an explicit policy edit. Counts detect lost coverage, while real
// behavior assertions and isolated mutation probes establish test effectiveness.
export const REQUIRED_SPECS = Object.freeze({
  'test/e2e/adoption-recipes.e2e-spec.ts': 22,
  'test/e2e/fastify.e2e-spec.ts': 6,
  'test/e2e/idempotency.e2e-spec.ts': 11,
  'test/e2e/postgres.e2e-spec.ts': 3,
  'test/e2e/request-isolation.e2e-spec.ts': 58,
  'test/idempotency.decorator.spec.ts': 5,
  'test/idempotency.interceptor.spec.ts': 61,
  'test/idempotency.module.spec.ts': 11,
  'test/regression/adoption-migration.spec.ts': 3,
  'test/regression/benchmark-helpers.spec.ts': 40,
  'test/regression/benchmark-response.spec.ts': 29,
  'test/regression/benchmark-runner.spec.ts': 10,
  'test/regression/benchmark-storage.real.spec.ts': 4,
  'test/regression/benchmark-storage.spec.ts': 28,
  'test/regression/complete-failure-cascade.spec.ts': 1,
  'test/regression/failure-lifecycle.real.spec.ts': 10,
  'test/regression/failure-lifecycle.spec.ts': 17,
  'test/regression/memory-long-ttl.spec.ts': 14,
  'test/regression/observability-headers-sweep.spec.ts': 9,
  'test/regression/observability-safety.spec.ts': 65,
  'test/regression/optional-peer-boundary.spec.ts': 9,
  'test/regression/path-based-scope.spec.ts': 2,
  'test/regression/postgres-adapter.spec.ts': 2,
  'test/regression/postgres-sweep-wiring.spec.ts': 4,
  'test/regression/race-completed-winner.spec.ts': 4,
  'test/regression/replay-body-format.spec.ts': 56,
  'test/regression/request-isolation.spec.ts': 27,
  'test/regression/request-key-validation.spec.ts': 165,
  'test/regression/response-capture-failure.spec.ts': 12,
  'test/regression/response-completion.spec.ts': 7,
  'test/regression/response-replay-boundary.spec.ts': 9,
  'test/regression/response-replay-http.spec.ts': 28,
  'test/regression/storage-lifecycle-contract.spec.ts': 14,
  'test/regression/storage-ttl-validation.spec.ts': 5,
  'test/regression/ttl-validation.spec.ts': 30,
  'test/services/postgres-sweep.service.spec.ts': 6,
  'test/storage/memory.storage.spec.ts': 61,
  'test/storage/postgres.storage.lifecycle.spec.ts': 2,
  'test/storage/postgres.storage.spec.ts': 55,
  'test/storage/redis.storage.lifecycle.spec.ts': 3,
  'test/storage/redis.storage.real.spec.ts': 56,
  'test/storage/redis.storage.spec.ts': 63,
  'test/utils/request-key.spec.ts': 4,
  'test/utils/request-scope.spec.ts': 8,
  'test/utils/response-headers.spec.ts': 27,
  'test/utils/stable-json.spec.ts': 27,
});

export const REQUIRED_PACKAGE_FILES = Object.freeze([
  'package/package.json',
  'package/dist/index.js',
  'package/dist/index.d.ts',
  'package/dist/redis.js',
  'package/dist/redis.d.ts',
  'package/dist/postgres.js',
  'package/dist/postgres.d.ts',
  'package/sql/init.sql',
  'package/README.md',
  'package/CHANGELOG.md',
  'package/LICENSE',
]);

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function readJson(path) {
  assert(existsSync(path), `Required evidence file missing: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function requiredServiceUrls(env = process.env) {
  for (const name of ['TEST_DATABASE_URL', 'TEST_REDIS_URL']) {
    assert(
      typeof env[name] === 'string' && env[name].trim(),
      `${name} is required for release validation`,
    );
    const parsed = new URL(env[name]);
    const protocols =
      name === 'TEST_DATABASE_URL' ? ['postgres:', 'postgresql:'] : ['redis:', 'rediss:'];
    assert(protocols.includes(parsed.protocol), `${name} has an unsupported protocol`);
  }
}

export async function preflightServices(env = process.env, timeoutMs = 5000) {
  requiredServiceUrls(env);
  const [{ default: pg }, { default: Redis }] = await Promise.all([
    import('pg'),
    import('ioredis'),
  ]);
  const results = await Promise.allSettled([
    (async () => {
      const client = new pg.Client({
        connectionString: env.TEST_DATABASE_URL,
        connectionTimeoutMillis: timeoutMs,
        query_timeout: timeoutMs,
      });
      try {
        await client.connect();
        const { rows } = await client.query("SELECT current_setting('server_version') AS version");
        return { postgres: rows[0].version };
      } finally {
        await client.end().catch(() => {});
      }
    })(),
    (async () => {
      const client = new Redis(env.TEST_REDIS_URL, {
        lazyConnect: true,
        connectTimeout: timeoutMs,
        commandTimeout: timeoutMs,
        maxRetriesPerRequest: 0,
        retryStrategy: null,
        enableOfflineQueue: false,
      });
      client.on('error', () => {});
      try {
        await client.connect();
        assert.equal(await client.ping(), 'PONG', 'Redis preflight did not return PONG');
        const info = await client.info('server');
        return { redis: info.match(/^redis_version:(.+)$/m)?.[1].trim() ?? 'unknown' };
      } finally {
        client.disconnect();
      }
    })(),
  ]);
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [
          `${index === 0 ? 'PostgreSQL' : 'Redis'} preflight failed (${result.reason.code ?? result.reason.message})`,
        ]
      : [],
  );
  assert.equal(failures.length, 0, failures.join('; '));
  return Object.assign({}, ...results.map((result) => result.value));
}

export function verifyJest(report) {
  assert.equal(report.success, true, 'Jest did not report success');
  assert.equal(report.wasInterrupted, false, 'Jest was interrupted');
  for (const key of [
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
    'numFailedTestSuites',
    'numPendingTestSuites',
    'numRuntimeErrorTestSuites',
  ]) {
    assert.equal(report[key], 0, `Jest ${key} must be zero`);
  }
  assert(Array.isArray(report.testResults), 'Jest testResults missing');
  const specs = new Map();
  let assertions = 0;
  for (const suite of report.testResults) {
    assert.equal(suite.status, 'passed', `Jest suite did not pass: ${suite.name}`);
    assert(
      Array.isArray(suite.assertionResults) && suite.assertionResults.length > 0,
      `Empty Jest suite: ${suite.name}`,
    );
    const normalized = suite.name.replaceAll('\\', '/');
    const marker = normalized.lastIndexOf('/test/');
    const name = marker < 0 ? normalized : normalized.slice(marker + 1);
    assert(!specs.has(name), `Duplicate Jest suite: ${name}`);
    for (const test of suite.assertionResults) {
      assert.equal(
        test.status,
        'passed',
        `Non-passing Jest assertion: ${name}: ${test.fullName ?? test.title}`,
      );
    }
    assertions += suite.assertionResults.length;
    specs.set(name, suite.assertionResults.length);
  }
  for (const [name, minimum] of Object.entries(REQUIRED_SPECS)) {
    assert(specs.has(name), `Required Jest spec missing: ${name}`);
    assert(
      specs.get(name) >= minimum,
      `Required Jest spec count reduced: ${name}: ${specs.get(name)} < ${minimum}`,
    );
  }
  assert.equal(
    report.numTotalTests,
    assertions,
    'Jest total assertion count disagrees with evidence',
  );
  assert.equal(
    report.numPassedTests,
    assertions,
    'Jest passed assertion count disagrees with evidence',
  );
  assert.equal(
    report.numTotalTestSuites,
    specs.size,
    'Jest total suite count disagrees with evidence',
  );
  assert.equal(
    report.numPassedTestSuites,
    specs.size,
    'Jest passed suite count disagrees with evidence',
  );
  return {
    suites: specs.size,
    passed: assertions,
    failed: 0,
    skipped: 0,
    todo: 0,
    specs: Object.fromEntries(specs),
  };
}

export function verifyConsumer(summary, artifact, cell) {
  assert.equal(summary.result, 'pass', 'Consumer result must be pass without skips');
  assert.equal(summary.mode, 'candidate', 'Consumer must validate the candidate');
  assert.equal(summary.sha256, artifact.sha256, 'Consumer tarball checksum mismatch');
  assert.equal(summary.commit, artifact.commit, 'Consumer commit mismatch');
  assert.equal(String(summary.nestMajor), String(cell.nest), 'Consumer Nest matrix mismatch');
  assert.equal(summary.peerProfile, cell.peerProfile, 'Consumer peer profile mismatch');
  assert.equal(
    Number(summary.node?.match(/^v?(\d+)/)?.[1]),
    Number(cell.node),
    'Consumer Node matrix mismatch',
  );
  assert.equal(summary.services?.explicitlySkipped, false, 'Consumer skipped services');
  assert.equal(summary.services?.redisUrlProvided, true, 'Consumer Redis URL missing');
  assert.equal(summary.services?.databaseUrlProvided, true, 'Consumer PostgreSQL URL missing');
  const versions = matrixVersions(String(cell.nest), cell.peerProfile);
  assert.deepEqual(summary.versions, versions, 'Consumer configured dependency versions mismatch');
  for (const variant of ['memory', 'redis', 'postgres']) {
    const required = [
      '@nestjs/common',
      '@nestjs/core',
      '@nestjs/testing',
      '@nestjs/platform-express',
      ...(variant === 'memory'
        ? ['@nestjs/platform-fastify']
        : variant === 'redis'
          ? ['ioredis']
          : ['pg', '@types/pg']),
    ];
    for (const name of required)
      assert.equal(
        summary.consumers?.[variant]?.installedVersions?.[name],
        versions[name],
        `Consumer installed dependency mismatch: ${variant}/${name}`,
      );
  }
  assert(Array.isArray(summary.checks), 'Consumer checks missing');
  const checks = new Map();
  for (const check of summary.checks) {
    assert(
      ['pass', 'expected-failure'].includes(check.status),
      `Consumer check did not pass: ${check.name}`,
    );
    assert(!checks.has(check.name), `Duplicate consumer check: ${check.name}`);
    checks.set(check.name, check.status);
  }
  const mandatory = [
    'tarball-inventory',
    'memory-readme-quickstart-match',
    'memory-express-http',
    'memory-fastify-http',
  ];
  for (const variant of ['memory', 'redis', 'postgres']) {
    mandatory.push(
      `${variant}-node-import`,
      `${variant}-examples-emit`,
      `${variant}-runtime`,
      `${variant}-storage-smoke`,
    );
    const phase = variant === 'postgres' ? 'with-pg-types' : 'initial';
    mandatory.push(
      ...['lock', 'ci', 'npm-ls', 'isolation'].map((check) => `${variant}-${phase}-${check}`),
    );
    mandatory.push(
      ...['node', 'node16', 'nodenext'].map(
        (resolution) =>
          `${variant}-${variant === 'postgres' ? 'with-pg-types' : 'strict'}-${resolution}`,
      ),
    );
  }
  for (const name of mandatory)
    assert.equal(checks.get(name), 'pass', `Required consumer check missing or failed: ${name}`);
  for (const resolution of ['node', 'node16', 'nodenext']) {
    assert.equal(
      checks.get(`postgres-without-pg-types-${resolution}`),
      'expected-failure',
      `Missing expected PostgreSQL declaration failure: ${resolution}`,
    );
  }
  return {
    passed: summary.checks.filter((check) => check.status === 'pass').length,
    expectedFailures: summary.checks.filter((check) => check.status === 'expected-failure').length,
    skipped: 0,
  };
}

function tar(args) {
  const result = spawnSync('tar', args, {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `Tarball inspection failed: ${result.error?.message ?? result.stderr}`,
  );
  return result.stdout;
}

export function verifyArtifact(
  manifestPath,
  expectedCommit,
  expectedVersion,
  { allowDirty = false } = {},
) {
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 1, 'Unsupported artifact manifest schema');
  assert.equal(manifest.result, 'pass', 'Artifact build did not pass');
  assert.match(
    manifest.source?.snapshotSha256 ?? '',
    /^[a-f\d]{64}$/,
    'Artifact source snapshot missing',
  );
  assert.equal(typeof manifest.source.clean, 'boolean', 'Artifact source cleanliness missing');
  assert(
    manifest.source.clean || allowDirty,
    'Dirty source artifact is local evidence only; explicit --allow-dirty required',
  );
  assert.match(manifest.commit ?? '', /^[a-f\d]{40,64}$/, 'Artifact commit is missing or invalid');
  assert.equal(manifest.commit, expectedCommit, 'Artifact commit mismatch');
  assert.match(manifest.sha256 ?? '', /^[a-f\d]{64}$/, 'Artifact checksum is missing or invalid');
  assert.equal(typeof manifest.tarball, 'string', 'Artifact tarball path missing');
  assert.equal(basename(manifest.tarball), manifest.tarball, 'Artifact tarball must be a basename');
  assert(
    !manifest.tarball.includes('\\') && manifest.tarball.endsWith('.tgz'),
    'Unsafe artifact tarball filename',
  );
  const tarball = resolve(dirname(manifestPath), manifest.tarball);
  assert(existsSync(tarball), `Artifact tarball missing: ${tarball}`);
  assert.equal(sha256(tarball), manifest.sha256, 'Artifact checksum mismatch');
  const files = tar(['-tzf', tarball]).trim().split('\n');
  assert.equal(new Set(files).size, files.length, 'Duplicate tarball entries');
  for (const file of files) {
    assert(
      file.startsWith('package/') && !file.split('/').includes('..') && !file.includes('\\'),
      `Unsafe tarball entry: ${file}`,
    );
    assert(
      !/^package\/(?:src|test|node_modules|\.git)\//.test(file),
      `Development file in tarball: ${file}`,
    );
    if (file.endsWith('.js'))
      assert(files.includes(file.replace(/\.js$/, '.d.ts')), `Missing declaration for ${file}`);
  }
  for (const required of REQUIRED_PACKAGE_FILES)
    assert(files.includes(required), `Required tarball file missing: ${required}`);
  const pkg = JSON.parse(tar(['-xOzf', tarball, 'package/package.json']));
  assert.equal(pkg.name, '@nestarc/idempotency', 'Unexpected package name');
  assert.equal(pkg.version, manifest.version, 'Tarball version disagrees with artifact manifest');
  if (expectedVersion)
    assert.equal(pkg.version, expectedVersion, 'Tarball version disagrees with release version');
  return { ...manifest, tarballPath: tarball, fileCount: files.length };
}

export function verifyEvidenceFile(directory, record) {
  assert(
    record && typeof record.path === 'string' && !isAbsolute(record.path),
    'Evidence file record missing or absolute',
  );
  const path = resolve(directory, record.path);
  const relation = relative(resolve(directory), path);
  assert(
    relation && !relation.startsWith('..') && !isAbsolute(relation),
    'Evidence path escapes its validation directory',
  );
  assert.equal(sha256(path), record.sha256, `Evidence checksum mismatch: ${record.path}`);
  return readJson(path);
}

export function verifySourceSnapshot(snapshotSha256, artifact) {
  assert.equal(
    snapshotSha256,
    artifact.source?.snapshotSha256,
    'Source snapshot differs from the artifact build',
  );
}

export function verifyS5(report) {
  assert.equal(report.fixture, 'failure-lifecycle.real.spec.ts', 'S5 evidence fixture missing');
  assert(
    Array.isArray(report.scenarios) && report.scenarios.length >= 10,
    'S5 real crash scenario evidence missing or reduced',
  );
  const expected = new Set(
    ['redis', 'postgres'].flatMap((backend) =>
      [
        'before-business-commit',
        'after-business-commit',
        'after-complete',
        'before-write-rejection',
        'applied-write-rejection',
      ].map((scenario) => `${backend}/${scenario}`),
    ),
  );
  for (const scenario of report.scenarios) {
    assert(
      expected.delete(`${scenario.backend}/${scenario.scenario}`),
      'Unexpected or duplicate S5 scenario',
    );
    if (scenario.scenario.includes('commit') || scenario.scenario === 'after-complete')
      assert.equal(scenario.exit?.signal, 'SIGKILL', 'S5 crash evidence must record SIGKILL');
  }
  assert.equal(expected.size, 0, 'Required S5 scenarios missing');
  return { scenarios: report.scenarios.length };
}

export function findValidationFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...findValidationFiles(path));
    else if (entry.name === 'validation.json') found.push(path);
  }
  return found.sort();
}

export function verifyMatrix(artifact, evidenceDirectory, { allowDirty = false } = {}) {
  assert(
    artifact.source?.clean === true || allowDirty,
    'Dirty source artifact cannot pass the publication matrix gate',
  );
  const files = findValidationFiles(evidenceDirectory);
  const expected = new Set(
    ['22', '24'].flatMap((node) =>
      ['10', '11'].flatMap((nest) =>
        ['representative', 'minimum'].map((profile) => `${node}/${nest}/${profile}`),
      ),
    ),
  );
  const cells = [];
  for (const path of files) {
    const report = readJson(path);
    assert.equal(report.result, 'pass', `Matrix cell did not pass: ${path}`);
    assert.equal(report.commit, artifact.commit, 'Matrix artifact commit mismatch');
    assert.equal(report.sha256, artifact.sha256, 'Matrix artifact checksum mismatch');
    assert.equal(
      report.sourceSnapshotSha256,
      artifact.source?.snapshotSha256,
      'Matrix source snapshot mismatch',
    );
    const key = `${report.cell?.node}/${report.cell?.nest}/${report.cell?.peerProfile}`;
    assert(expected.delete(key), `Unexpected or duplicate matrix cell: ${key}`);
    assert.deepEqual(
      report.installedVersions,
      matrixVersions(String(report.cell.nest), report.cell.peerProfile),
      'Source matrix installed dependency versions mismatch',
    );
    const directory = dirname(path);
    const jest = verifyJest(verifyEvidenceFile(directory, report.evidence?.jest));
    const consumer = verifyConsumer(
      verifyEvidenceFile(directory, report.evidence?.consumer),
      artifact,
      report.cell,
    );
    const s5 = verifyS5(verifyEvidenceFile(directory, report.evidence?.s5));
    cells.push({ ...report.cell, jest, consumer, s5 });
  }
  assert.equal(expected.size, 0, `Required matrix cells missing: ${[...expected].join(', ')}`);
  return { result: 'pass', commit: artifact.commit, sha256: artifact.sha256, cells };
}
