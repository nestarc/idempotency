#!/usr/bin/env node
/** S8 validates one immutable npm tarball. This command never publishes. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matrixVersions, NODE_MAJORS } from './release-matrix.mjs';
import {
  preflightServices,
  readJson,
  requiredServiceUrls,
  sha256,
  verifyArtifact,
  verifyConsumer,
  verifyJest,
  verifyMatrix,
  verifyS5,
  verifySourceSnapshot,
} from './release-gates.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Usage: node scripts/release-validation.mjs COMMAND [OPTIONS]
  build --output DIR [--allow-dirty]
  validate --artifact DIR/artifact.json --output DIR --nest 10|11 --peer-profile representative|minimum [--allow-dirty]
  verify-artifact --artifact DIR/artifact.json [--expected-commit SHA] [--expected-version VERSION] [--allow-dirty]
  verify-matrix --artifact DIR/artifact.json --evidence DIR [--expected-commit SHA] [--allow-dirty]
Build runs clean, lint, types, gate tests, build and npm pack --ignore-scripts once.
Validation requires real test-only TEST_DATABASE_URL and TEST_REDIS_URL services.
Output directories must be empty. Consumers execute outside the source checkout.
--allow-dirty is for local evidence only; it records the base commit and source snapshot.
No command publishes, tags, pushes, or dispatches a release workflow.`;

function json(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
function raw(command, args) {
  const result = spawnSync(command, args, {
    cwd: repository,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
function currentCommit() {
  return raw('git', ['rev-parse', 'HEAD']).trim();
}

function sourceSnapshot() {
  const files = [
    ...new Set(
      raw('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  const entries = files.map((path) => {
    const absolute = join(repository, path);
    if (!existsSync(absolute)) return { path, deleted: true };
    const stat = lstatSync(absolute);
    const contents = stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute);
    return {
      path,
      mode: stat.mode & 0o777,
      sha256: createHash('sha256').update(contents).digest('hex'),
    };
  });
  const workingTree = raw('git', ['status', '--porcelain=v1', '--untracked-files=all']).trim();
  return {
    clean: !workingTree,
    workingTree,
    snapshotSha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    files: entries,
  };
}

function newOutput(path) {
  assert(path, '--output is required');
  const output = resolve(path);
  if (existsSync(output))
    assert.equal(
      readdirSync(output).length,
      0,
      'Output directory must be empty; stale evidence cannot be reused',
    );
  mkdirSync(output, { recursive: true });
  return output;
}

function executor(output, env = process.env) {
  let number = 0;
  return (name, command, args, timeout = 900_000) => {
    const log = join(output, `${String(++number).padStart(2, '0')}-${name}.log`);
    console.log(`S8 ${name}: ${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, {
      cwd: repository,
      env,
      encoding: 'utf8',
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    });
    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? '\n' + result.error.stack : ''}`;
    writeFileSync(log, `$ ${command} ${args.join(' ')}\n${combined}`);
    assert.equal(
      result.status,
      0,
      `${name} failed (${result.status}); see ${log}\n${combined.slice(-3000)}`,
    );
    return result.stdout;
  };
}

function build(options) {
  const output = newOutput(options.output);
  const execute = executor(output);
  const source = sourceSnapshot();
  assert(
    source.clean || options['allow-dirty'],
    'Release build requires a clean checkout; --allow-dirty records local evidence only',
  );
  const manifest = {
    schemaVersion: 1,
    result: 'running',
    createdAt: new Date().toISOString(),
    commit: currentCommit(),
    node: process.version,
    npm: raw('npm', ['--version']).trim(),
    source: {
      clean: source.clean,
      snapshotSha256: source.snapshotSha256,
      workingTree: source.workingTree,
    },
    version: readJson(join(repository, 'package.json')).version,
  };
  json(join(output, 'source-state.json'), source);
  writeFileSync(join(output, 'source.patch'), raw('git', ['diff', '--binary', 'HEAD']));
  try {
    execute('clean', 'npm', ['run', 'clean']);
    execute('lint', 'npm', ['run', 'lint']);
    execute('types', process.execPath, [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--incremental',
      'false',
      '-p',
      'tsconfig.json',
    ]);
    const gateTests = readdirSync(join(repository, 'test/release'))
      .filter((name) => name.endsWith('.test.mjs'))
      .sort()
      .map((name) => `test/release/${name}`);
    assert(gateTests.length > 0, 'Release gate negative tests missing');
    execute('release-gate-tests', process.execPath, ['--test', ...gateTests]);
    execute('build', 'npm', ['run', 'build']);
    const packed = JSON.parse(
      execute('pack', 'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output]),
    );
    assert.equal(packed.length, 1, 'Expected exactly one packed artifact');
    manifest.tarball = basename(packed[0].filename);
    manifest.sha256 = sha256(join(output, manifest.tarball));
    manifest.source.packageLockSha256 = sha256(join(repository, 'package-lock.json'));
    assert.equal(
      sourceSnapshot().snapshotSha256,
      source.snapshotSha256,
      'Source changed while building the artifact',
    );
    manifest.result = 'pass';
    json(join(output, 'artifact.json'), manifest);
    const inspected = verifyArtifact(
      join(output, 'artifact.json'),
      manifest.commit,
      manifest.version,
      { allowDirty: Boolean(options['allow-dirty']) },
    );
    manifest.fileCount = inspected.fileCount;
    json(join(output, 'artifact.json'), manifest);
    writeFileSync(join(output, 'tarball.sha256'), `${manifest.sha256}  ${manifest.tarball}\n`);
    console.log(`PASS: ${join(output, 'artifact.json')}`);
  } catch (error) {
    manifest.result = 'fail';
    manifest.error = error.message;
    json(join(output, 'build-failure.json'), manifest);
    throw error;
  }
}

async function validate(options) {
  const output = newOutput(options.output);
  const cell = {
    node: process.versions.node.split('.')[0],
    nest: options.nest,
    peerProfile: options['peer-profile'],
  };
  const report = {
    schemaVersion: 1,
    result: 'running',
    startedAt: new Date().toISOString(),
    cell,
    node: process.version,
    npm: raw('npm', ['--version']).trim(),
    evidence: {},
  };
  const record = (name, path) => {
    report.evidence[name] = { path: relative(output, path), sha256: sha256(path) };
  };
  const env = {
    ...process.env,
    S5_REQUIRE_REAL_STORAGE: '1',
    S7_REQUIRE_REAL_STORAGE: '1',
    S5_EVIDENCE_PATH: join(output, 's5-real-storage.json'),
  };
  const execute = executor(output, env);
  try {
    requiredServiceUrls(env);
    assert(
      NODE_MAJORS.includes(cell.node),
      `Unsupported release validation Node ${cell.node}; expected 22 or 24`,
    );
    assert(options.nest && options['peer-profile'], '--nest and --peer-profile are required');
    const versions = matrixVersions(cell.nest, cell.peerProfile);
    report.installedVersions = {};
    for (const [name, version] of Object.entries(versions)) {
      const actual = readJson(join(repository, 'node_modules', name, 'package.json')).version;
      assert.equal(
        actual,
        version,
        `Source matrix dependency mismatch: ${name}; run release-matrix.mjs install first`,
      );
      report.installedVersions[name] = actual;
    }
    assert(options.artifact, '--artifact is required');
    const artifact = verifyArtifact(
      resolve(options.artifact),
      options['expected-commit'] ?? currentCommit(),
      options['expected-version'],
      { allowDirty: Boolean(options['allow-dirty']) },
    );
    report.commit = artifact.commit;
    report.sha256 = artifact.sha256;
    report.sourceSnapshotSha256 = sourceSnapshot().snapshotSha256;
    verifySourceSnapshot(report.sourceSnapshotSha256, artifact);
    report.services = await preflightServices(env);
    json(join(output, 'services.json'), report.services);
    execute('lint', 'npm', ['run', 'lint']);
    execute('types', process.execPath, [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--incremental',
      'false',
      '-p',
      'tsconfig.json',
    ]);
    const jestPath = join(output, 'jest.json');
    const jestArgs = ['run', 'test:all', '--', '--runInBand', '--json', `--outputFile=${jestPath}`];
    if (cell.node === '24' && cell.nest === '11' && cell.peerProfile === 'representative') {
      jestArgs.push('--coverage', `--coverageDirectory=${join(output, 'coverage')}`);
    }
    execute('full-jest', 'npm', jestArgs);
    report.jest = verifyJest(readJson(jestPath));
    record('jest', jestPath);
    report.s5 = verifyS5(readJson(env.S5_EVIDENCE_PATH));
    record('s5', env.S5_EVIDENCE_PATH);
    const consumerRoot = mkdtempSync(join(tmpdir(), 'idempotency-s8-'));
    const consumerOutput = join(consumerRoot, 'consumer');
    try {
      execute(
        'consumers',
        process.execPath,
        [
          'scripts/consumer-package.mjs',
          '--tarball',
          artifact.tarballPath,
          '--nest',
          cell.nest,
          '--peer-profile',
          cell.peerProfile,
          '--output',
          consumerOutput,
        ],
        1_800_000,
      );
    } finally {
      // Installed trees can be reconstructed from retained lockfiles; preserve all
      // other logs, emitted examples, inventories, and summaries in CI artifacts.
      if (existsSync(consumerOutput))
        cpSync(consumerOutput, join(output, 'consumer'), {
          recursive: true,
          filter: (path) => basename(path) !== 'node_modules',
        });
    }
    const consumerPath = join(output, 'consumer/summary.json');
    report.consumer = verifyConsumer(readJson(consumerPath), artifact, cell);
    record('consumer', consumerPath);
    // Assert bytes again after consumers; a changed input can never receive PASS.
    verifyArtifact(resolve(options.artifact), artifact.commit, artifact.version, {
      allowDirty: Boolean(options['allow-dirty']),
    });
    verifySourceSnapshot(sourceSnapshot().snapshotSha256, artifact);
    report.result = 'pass';
    console.log(`PASS: ${join(output, 'validation.json')}`);
  } catch (error) {
    report.result = 'fail';
    report.error = error.message;
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    json(join(output, 'validation.json'), report);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === '--help') {
    console.log(usage);
    return;
  }
  const allowed = {
    build: ['output', 'allow-dirty'],
    validate: [
      'artifact',
      'output',
      'nest',
      'peer-profile',
      'expected-commit',
      'expected-version',
      'allow-dirty',
    ],
    'verify-artifact': ['artifact', 'expected-commit', 'expected-version', 'allow-dirty'],
    'verify-matrix': ['artifact', 'evidence', 'expected-commit', 'allow-dirty'],
  };
  assert(allowed[command], `Unknown release command: ${command}\n${usage}`);
  const options = {};
  while (args.length) {
    const flag = args.shift();
    assert(
      flag.startsWith('--') && allowed[command].includes(flag.slice(2)),
      `Unknown option: ${flag}`,
    );
    const key = flag.slice(2);
    assert(!Object.hasOwn(options, key), `Duplicate option: ${flag}`);
    if (key === 'allow-dirty') options[key] = true;
    else {
      assert(args[0] && !args[0].startsWith('--'), `${flag} value required`);
      options[key] = args.shift();
    }
  }
  if (command === 'build') return build(options);
  if (command === 'validate') return validate(options);
  assert(options.artifact, '--artifact is required');
  const artifact = verifyArtifact(
    resolve(options.artifact),
    options['expected-commit'] ?? currentCommit(),
    options['expected-version'],
    { allowDirty: Boolean(options['allow-dirty']) },
  );
  if (command === 'verify-artifact')
    console.log(
      JSON.stringify(
        {
          result: 'pass',
          commit: artifact.commit,
          version: artifact.version,
          sha256: artifact.sha256,
          tarball: artifact.tarball,
          fileCount: artifact.fileCount,
        },
        null,
        2,
      ),
    );
  else {
    assert(options.evidence, '--evidence is required');
    const matrix = verifyMatrix(artifact, resolve(options.evidence), {
      allowDirty: Boolean(options['allow-dirty']),
    });
    json(join(resolve(options.evidence), 'matrix-summary.json'), matrix);
    console.log(`PASS: ${matrix.cells.length} matrix cells, ${artifact.sha256}`);
  }
}

main().catch((error) => {
  console.error(`RELEASE GATE FAILED: ${error.message}`);
  process.exitCode = 1;
});
