import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import {
  REQUIRED_PACKAGE_FILES,
  REQUIRED_SPECS,
  preflightServices,
  requiredServiceUrls,
  sha256,
  verifyArtifact,
  verifyConsumer,
  verifyJest,
  verifyMatrix,
  verifyS5,
  verifySourceSnapshot,
} from '../../scripts/release-gates.mjs';
import { matrixVersions } from '../../scripts/release-matrix.mjs';

const output = mkdtempSync(join(tmpdir(), 'idempotency-gate-tests-'));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const commit = 'a'.repeat(40);
const artifact = {
  schemaVersion: 1,
  result: 'pass',
  commit,
  version: '1.0.0-rc.1',
  tarball: 'candidate.tgz',
  sha256: 'b'.repeat(64),
  source: { clean: true, snapshotSha256: 'c'.repeat(64) },
};
const cell = { node: '24', nest: '11', peerProfile: 'representative' };
after(() => rmSync(output, { recursive: true, force: true }));
const copy = (value) => structuredClone(value);
const save = (path, value) => writeFileSync(path, JSON.stringify(value));

function jestEvidence() {
  const testResults = Object.entries(REQUIRED_SPECS).map(([name, count]) => ({
    name: `${repository}/${name}`,
    status: 'passed',
    assertionResults: Array.from({ length: count }, (_, index) => ({
      fullName: `${name} assertion ${index}`,
      status: 'passed',
    })),
  }));
  const total = testResults.reduce((count, suite) => count + suite.assertionResults.length, 0);
  return {
    success: true,
    wasInterrupted: false,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numRuntimeErrorTestSuites: 0,
    numTotalTests: total,
    numPassedTests: total,
    numTotalTestSuites: testResults.length,
    numPassedTestSuites: testResults.length,
    testResults,
  };
}

function consumerEvidence(matrix = cell) {
  const checks = [
    'tarball-inventory',
    'memory-readme-quickstart-match',
    'memory-express-http',
    'memory-fastify-http',
  ].map((name) => ({ name, status: 'pass' }));
  for (const variant of ['memory', 'redis', 'postgres']) {
    const phase = variant === 'postgres' ? 'with-pg-types' : 'initial';
    checks.push(
      ...['node-import', 'examples-emit', 'runtime', 'storage-smoke'].map((name) => ({
        name: `${variant}-${name}`,
        status: 'pass',
      })),
    );
    checks.push(
      ...['lock', 'ci', 'npm-ls', 'isolation'].map((name) => ({
        name: `${variant}-${phase}-${name}`,
        status: 'pass',
      })),
    );
    checks.push(
      ...['node', 'node16', 'nodenext'].map((resolution) => ({
        name: `${variant}-${variant === 'postgres' ? 'with-pg-types' : 'strict'}-${resolution}`,
        status: 'pass',
      })),
    );
  }
  checks.push(
    ...['node', 'node16', 'nodenext'].map((resolution) => ({
      name: `postgres-without-pg-types-${resolution}`,
      status: 'expected-failure',
    })),
  );
  return {
    result: 'pass',
    mode: 'candidate',
    commit,
    sha256: artifact.sha256,
    node: `v${matrix.node}.0.0`,
    nestMajor: matrix.nest,
    peerProfile: matrix.peerProfile,
    versions: matrixVersions(matrix.nest, matrix.peerProfile),
    consumers: Object.fromEntries(
      ['memory', 'redis', 'postgres'].map((variant) => [
        variant,
        { installedVersions: matrixVersions(matrix.nest, matrix.peerProfile) },
      ]),
    ),
    services: { explicitlySkipped: false, redisUrlProvided: true, databaseUrlProvided: true },
    checks,
  };
}

function s5Evidence() {
  return {
    fixture: 'failure-lifecycle.real.spec.ts',
    scenarios: ['redis', 'postgres'].flatMap((backend) =>
      [
        'before-business-commit',
        'after-business-commit',
        'after-complete',
        'before-write-rejection',
        'applied-write-rejection',
      ].map((scenario) => ({ backend, scenario, exit: { code: null, signal: 'SIGKILL' } })),
    ),
  };
}

test('complete baseline is accepted: 41 suites, 937 assertions, consumers and ten real-crash scenarios', () => {
  assert.deepEqual(
    { suites: verifyJest(jestEvidence()).suites, passed: verifyJest(jestEvidence()).passed },
    { suites: 41, passed: 937 },
  );
  assert.equal(verifyConsumer(consumerEvidence(), artifact, cell).skipped, 0);
  assert.equal(verifyS5(s5Evidence()).scenarios, 10);
});

for (const absent of ['TEST_DATABASE_URL', 'TEST_REDIS_URL']) {
  test(`missing ${absent} fails before any tests can skip`, () => {
    const env = {
      TEST_DATABASE_URL: 'postgresql://localhost/test',
      TEST_REDIS_URL: 'redis://localhost',
    };
    delete env[absent];
    assert.throws(() => requiredServiceUrls(env), new RegExp(`${absent} is required`));
  });
}
test('wrong service URL protocol fails', () => {
  assert.throws(
    () =>
      requiredServiceUrls({
        TEST_DATABASE_URL: 'https://localhost',
        TEST_REDIS_URL: 'redis://localhost',
      }),
    /unsupported protocol/,
  );
});
test('unreachable real PostgreSQL and Redis services reject the connection preflight', async () => {
  await assert.rejects(
    preflightServices(
      {
        TEST_DATABASE_URL: 'postgresql://s8:s8@127.0.0.1:1/s8',
        TEST_REDIS_URL: 'redis://127.0.0.1:1',
      },
      200,
    ),
    /PostgreSQL preflight failed.*Redis preflight failed/,
  );
});
test('CLI returns failure and preserves evidence when a mandatory URL is absent', () => {
  const env = { ...process.env };
  delete env.TEST_DATABASE_URL;
  delete env.TEST_REDIS_URL;
  const directory = join(output, 'missing-url-cli');
  const result = spawnSync(
    process.execPath,
    [
      'scripts/release-validation.mjs',
      'validate',
      '--artifact',
      'not-created.json',
      '--output',
      directory,
      '--nest',
      '11',
      '--peer-profile',
      'representative',
    ],
    { cwd: repository, env, encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TEST_DATABASE_URL is required/);
  assert.equal(JSON.parse(readFileSync(join(directory, 'validation.json'), 'utf8')).result, 'fail');
});

for (const field of [
  'numPendingTests',
  'numTodoTests',
  'numFailedTests',
  'numPendingTestSuites',
  'numFailedTestSuites',
  'numRuntimeErrorTestSuites',
]) {
  test(`Jest ${field} is rejected even with success=true`, () => {
    const report = jestEvidence();
    report[field] = 1;
    assert.throws(() => verifyJest(report), new RegExp(field));
  });
}
test('a missing required spec cannot be replaced by a green partial Jest run', () => {
  const report = jestEvidence();
  report.testResults.pop();
  assert.throws(() => verifyJest(report), /Required Jest spec missing/);
});
test('a reduced required spec is rejected even when another spec offsets its count', () => {
  const report = jestEvidence();
  report.testResults[0].assertionResults.pop();
  report.testResults[1].assertionResults.push({ fullName: 'replacement', status: 'passed' });
  assert.throws(() => verifyJest(report), /count reduced/);
});
test('per-assertion skip cannot hide behind zero aggregate skip counters', () => {
  const report = jestEvidence();
  report.testResults[0].assertionResults[0].status = 'pending';
  assert.throws(() => verifyJest(report), /Non-passing Jest assertion/);
});
test('aggregate test counts must agree with detailed assertions', () => {
  const report = jestEvidence();
  report.numPassedTests += 1;
  assert.throws(() => verifyJest(report), /count disagrees/);
});
test('interrupted Jest run fails', () => {
  const report = jestEvidence();
  report.wasInterrupted = true;
  assert.throws(() => verifyJest(report), /interrupted/);
});

for (const result of ['fail', 'pass-with-skips', undefined]) {
  test(`consumer summary result ${result} is rejected`, () => {
    const report = consumerEvidence();
    report.result = result;
    assert.throws(() => verifyConsumer(report, artifact, cell), /must be pass/);
  });
}
for (const status of ['fail', 'skip']) {
  test(`consumer ${status} check is rejected even when result claims pass`, () => {
    const report = consumerEvidence();
    report.checks[0].status = status;
    assert.throws(() => verifyConsumer(report, artifact, cell), /did not pass/);
  });
}
test('missing consumer runtime check fails', () => {
  const report = consumerEvidence();
  report.checks = report.checks.filter((check) => check.name !== 'redis-runtime');
  assert.throws(() => verifyConsumer(report, artifact, cell), /Required consumer check missing/);
});
test('consumer summary from a different tarball fails', () => {
  const report = consumerEvidence();
  report.sha256 = '0'.repeat(64);
  assert.throws(() => verifyConsumer(report, artifact, cell), /checksum mismatch/);
});
test('consumer summary from the wrong matrix cell fails', () => {
  const report = consumerEvidence();
  report.nestMajor = '10';
  assert.throws(() => verifyConsumer(report, artifact, cell), /Nest matrix mismatch/);
});
test('missing or duplicate real-crash scenarios fail', () => {
  const report = s5Evidence();
  report.scenarios.pop();
  assert.throws(() => verifyS5(report), /missing or reduced/);
  report.scenarios.push(report.scenarios[0]);
  assert.throws(() => verifyS5(report), /duplicate/);
});

test('consumer actual installed dependency drift fails despite correct profile labels', () => {
  const report = consumerEvidence();
  report.consumers.redis.installedVersions.ioredis = '0.0.0';
  assert.throws(() => verifyConsumer(report, artifact, cell), /installed dependency mismatch/);
});
test('source changes after the build cannot reuse artifact validation', () => {
  assert.doesNotThrow(() => verifySourceSnapshot(artifact.source.snapshotSha256, artifact));
  assert.throws(() => verifySourceSnapshot('0'.repeat(64), artifact), /Source snapshot differs/);
});

test('dirty artifact is local evidence only and default artifact verification rejects it', () => {
  const candidate = packedFixture('dirty-source');
  candidate.manifest.source.clean = false;
  save(candidate.manifestPath, candidate.manifest);
  assert.throws(() => verifyArtifact(candidate.manifestPath, commit), /local evidence only/);
  assert.doesNotThrow(() =>
    verifyArtifact(candidate.manifestPath, commit, undefined, { allowDirty: true }),
  );
});
test('failed artifact build cannot be verified', () => {
  const candidate = packedFixture('failed-build');
  candidate.manifest.result = 'fail';
  save(candidate.manifestPath, candidate.manifest);
  assert.throws(() => verifyArtifact(candidate.manifestPath, commit), /build did not pass/);
});
test('dirty source artifact cannot enter the default publication matrix gate', () => {
  const dirty = copy(artifact);
  dirty.source.clean = false;
  assert.throws(
    () => verifyMatrix(dirty, matrixFixture('dirty-matrix')),
    /cannot pass the publication/,
  );
});

function packedFixture(name, missingFile) {
  const directory = join(output, name);
  mkdirSync(directory);
  const content = join(directory, 'content');
  for (const file of REQUIRED_PACKAGE_FILES) {
    if (file === missingFile) continue;
    const path = join(content, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      file.endsWith('package.json')
        ? JSON.stringify({ name: '@nestarc/idempotency', version: artifact.version })
        : '// fixture\n',
    );
  }
  const tarball = join(directory, artifact.tarball);
  const packed = spawnSync(
    'tar',
    [
      '-czf',
      tarball,
      '-C',
      content,
      ...REQUIRED_PACKAGE_FILES.filter((file) => file !== missingFile),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const manifestPath = join(directory, 'artifact.json');
  const manifest = { ...copy(artifact), sha256: sha256(tarball) };
  save(manifestPath, manifest);
  return { manifest, manifestPath, tarball, directory };
}

test('actual tar archive with matching version/checksum/commit is accepted', () => {
  const candidate = packedFixture('valid-artifact');
  assert.equal(
    verifyArtifact(candidate.manifestPath, commit, artifact.version).fileCount,
    REQUIRED_PACKAGE_FILES.length,
  );
});
test('missing artifact manifest fails', () =>
  assert.throws(() => verifyArtifact(join(output, 'missing.json'), commit), /file missing/));
test('missing tarball fails', () => {
  const candidate = packedFixture('missing-tarball');
  rmSync(candidate.tarball);
  assert.throws(() => verifyArtifact(candidate.manifestPath, commit), /tarball missing/);
});
test('tampered tarball fails checksum validation', () => {
  const candidate = packedFixture('tampered-tarball');
  writeFileSync(candidate.tarball, 'tampered');
  assert.throws(() => verifyArtifact(candidate.manifestPath, commit), /checksum mismatch/);
});
test('wrong commit fails even with valid tarball bytes', () => {
  const candidate = packedFixture('wrong-commit');
  assert.throws(() => verifyArtifact(candidate.manifestPath, 'd'.repeat(40)), /commit mismatch/);
});
test('wrong tag version fails even with valid tarball bytes', () => {
  const candidate = packedFixture('wrong-tag-version');
  assert.throws(() => verifyArtifact(candidate.manifestPath, commit, '1.0.0'), /release version/);
});
test('lying manifest version fails', () => {
  const candidate = packedFixture('wrong-manifest-version');
  candidate.manifest.version = '9.9.9';
  save(candidate.manifestPath, candidate.manifest);
  assert.throws(() => verifyArtifact(candidate.manifestPath, commit), /artifact manifest/);
});
test('missing shipped SQL fails despite a valid recalculated checksum', () => {
  const candidate = packedFixture('missing-sql', 'package/sql/init.sql');
  assert.throws(
    () => verifyArtifact(candidate.manifestPath, commit),
    /Required tarball file missing/,
  );
});
test('artifact manifest cannot reference a tarball outside its artifact directory', () => {
  const candidate = packedFixture('unsafe-path');
  candidate.manifest.tarball = '../candidate.tgz';
  save(candidate.manifestPath, candidate.manifest);
  assert.throws(() => verifyArtifact(candidate.manifestPath, commit), /must be a basename/);
});

function matrixFixture(name) {
  const directory = join(output, name);
  mkdirSync(directory);
  for (const node of ['22', '24'])
    for (const nest of ['10', '11'])
      for (const peerProfile of ['representative', 'minimum']) {
        const matrixCell = { node, nest, peerProfile };
        const child = join(directory, `${node}-${nest}-${peerProfile}`);
        mkdirSync(child);
        const evidence = {};
        for (const [key, data] of Object.entries({
          jest: jestEvidence(),
          consumer: consumerEvidence(matrixCell),
          s5: s5Evidence(),
        })) {
          save(join(child, `${key}.json`), data);
          evidence[key] = { path: `${key}.json`, sha256: sha256(join(child, `${key}.json`)) };
        }
        save(join(child, 'validation.json'), {
          result: 'pass',
          commit,
          sha256: artifact.sha256,
          sourceSnapshotSha256: artifact.source.snapshotSha256,
          cell: matrixCell,
          installedVersions: matrixVersions(nest, peerProfile),
          evidence,
        });
      }
  return directory;
}
test('eight complete and matching cells pass the publication-input gate', () =>
  assert.equal(verifyMatrix(artifact, matrixFixture('complete-matrix')).cells.length, 8));
test('missing matrix cell fails', () => {
  const directory = matrixFixture('missing-cell');
  rmSync(join(directory, '22-10-minimum'), { recursive: true });
  assert.throws(() => verifyMatrix(artifact, directory), /Required matrix cells missing/);
});
test('missing consumer summary fails aggregate publication gate', () => {
  const directory = matrixFixture('missing-consumer');
  rmSync(join(directory, '22-10-minimum/consumer.json'));
  assert.throws(() => verifyMatrix(artifact, directory), /ENOENT|missing/);
});
test('tampered consumer summary fails aggregate publication gate', () => {
  const directory = matrixFixture('tampered-consumer');
  save(join(directory, '22-10-minimum/consumer.json'), { result: 'pass' });
  assert.throws(() => verifyMatrix(artifact, directory), /Evidence checksum mismatch/);
});
test('rehashed skipped consumer summary still fails aggregate publication gate', () => {
  const directory = matrixFixture('skipped-consumer');
  const child = join(directory, '22-10-minimum');
  const report = JSON.parse(readFileSync(join(child, 'validation.json'), 'utf8'));
  const consumer = consumerEvidence(report.cell);
  consumer.result = 'pass-with-skips';
  save(join(child, 'consumer.json'), consumer);
  report.evidence.consumer.sha256 = sha256(join(child, 'consumer.json'));
  save(join(child, 'validation.json'), report);
  assert.throws(() => verifyMatrix(artifact, directory), /must be pass/);
});
