#!/usr/bin/env node
/** Selected defect probes, not a general mutation-coverage engine. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HELP = `Usage: node test/mutation/run.mjs --output /absolute/new-directory [--timeout-ms N]

Requires TEST_DATABASE_URL and TEST_REDIS_URL for dedicated PostgreSQL and Redis
test services. Each Jest process has a hard deadline of at most 60000 ms.
The output directory must not exist and must be outside the repository.
Source snapshots, Jest JSON, logs, and summary.json are retained for inspection.
An unchanged baseline must pass with zero skips before any defect is injected.
Only recognized Jest assertion failures kill a mutant; errors and survivors fail
the command. See test/mutation/README.md for the deliberately limited scope.
`;

export const MUTANTS = [
  {
    id: 'memory-stale-owner',
    description: 'Accept a nonempty stale token when completing a processing Memory record.',
    project: 'unit',
    suite: 'test/storage/memory.storage.spec.ts',
    edits: [
      {
        file: 'src/storage/memory.storage.ts',
        before: "if (entry.record.token !== token || entry.record.status !== 'PROCESSING') {",
        after: "if (!token || entry.record.status !== 'PROCESSING') {",
      },
    ],
  },
  {
    id: 'postgres-stale-owner',
    description:
      'Ignore owner equality in real PostgreSQL completion while retaining the UUID bind.',
    project: 'unit',
    suite: 'test/storage/postgres.storage.spec.ts',
    edits: [
      {
        file: 'src/storage/postgres.storage.ts',
        before: "WHERE key = $1 AND token = $2 AND status = 'PROCESSING'",
        after: "WHERE key = $1 AND $2::uuid IS NOT NULL AND status = 'PROCESSING'",
      },
    ],
  },
  {
    id: 'redis-stale-snapshot',
    description:
      'Remove the real Redis Lua completion guard against a changed processing snapshot.',
    project: 'unit',
    suite: 'test/storage/redis.storage.real.spec.ts',
    edits: [
      {
        file: 'src/storage/redis.storage.ts',
        before: "        if payload ~= ARGV[4] then return 'stale' end\n",
        after: '',
      },
    ],
  },
  {
    id: 'fingerprint-mismatch-bypass',
    description: 'Bypass rejection when an existing key has a different request fingerprint.',
    project: 'unit',
    suite: 'test/idempotency.interceptor.spec.ts',
    edits: [
      {
        file: 'src/idempotency.interceptor.ts',
        before: 'existing.fingerprint !== fingerprint',
        after: 'existing.fingerprint !== fingerprint && false',
      },
    ],
  },
  {
    id: 'handler-ttl-ignored',
    description: 'Ignore handler TTL metadata and retain the module default instead.',
    project: 'e2e',
    suite: 'test/e2e/idempotency.e2e-spec.ts',
    edits: [
      {
        file: 'src/idempotency.interceptor.ts',
        before: 'metadata.ttl ?? this.moduleOptions.ttl ?? DEFAULT_TTL_SECONDS',
        after: 'this.moduleOptions.ttl ?? DEFAULT_TTL_SECONDS',
      },
    ],
  },
  {
    id: 'intermediate-response-capture',
    description:
      'Remove final-emission buffering so intermediate handler emissions can be captured.',
    project: 'unit',
    suite: 'test/regression/response-completion.spec.ts',
    edits: [
      { file: 'src/idempotency.interceptor.ts', before: '  takeLast,\n', after: '' },
      { file: 'src/idempotency.interceptor.ts', before: '          takeLast(1),\n', after: '' },
    ],
  },
  {
    id: 'persisted-replay-version-drift',
    description: 'Change encoder and decoder together from persisted replay v1 to v2.',
    project: 'unit',
    suite: 'test/regression/replay-body-format.spec.ts',
    edits: [
      {
        file: 'src/utils/replay-body.ts',
        before: "const REPLAY_BODY_PREFIX = '@nestarc/idempotency:replay:v1:';",
        after: "const REPLAY_BODY_PREFIX = '@nestarc/idempotency:replay:v2:';",
      },
    ],
  },
];

function parseArguments(argv) {
  const options = { timeoutMs: 60000, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!['--output', '--timeout-ms', '--help'].includes(name) || seen.has(name)) {
      throw new Error('Unknown or duplicate option. Use --help.');
    }
    seen.add(name);
    if (name === '--help') {
      options.help = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    if (name === '--output') options.output = path.resolve(value);
    else {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 60000) {
        throw new Error('--timeout-ms must be an integer from 1 to 60000.');
      }
      options.timeoutMs = Number(value);
    }
  }
  if (!options.help && !options.output) throw new Error('--output is required.');
  return options;
}

function serviceEnvironment() {
  const values = [];
  for (const [name, protocols] of [
    ['TEST_DATABASE_URL', ['postgres:', 'postgresql:']],
    ['TEST_REDIS_URL', ['redis:', 'rediss:']],
  ]) {
    const value = process.env[name];
    try {
      if (!value || /\s/.test(value)) throw new Error();
      const url = new URL(value);
      if (!protocols.includes(url.protocol) || !url.hostname) throw new Error();
      values.push({ value, url });
    } catch {
      throw new Error(`${name} must identify a configured test service.`);
    }
  }
  return values;
}

function redactor(services) {
  const secrets = services
    .flatMap(({ value, url }) => {
      let decoded = url.password;
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        /* Keep encoded secret. */
      }
      return [value, url.toString(), url.password, decoded].filter(Boolean);
    })
    .sort((a, b) => b.length - a.length);
  return (value) => {
    let text = String(value);
    for (const secret of secrets) text = text.split(secret).join('[redacted]');
    return text.replace(/(?:postgres(?:ql)?|rediss?):\/\/[^\s"'<>]+/gi, '[service URL]');
  };
}

function sanitize(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, redact));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitize(item, redact)]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function inside(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function sourceHashes(root) {
  const hashes = {};
  async function visit(directory) {
    for (const item of (await readdir(directory)).sort()) {
      const filename = path.join(directory, item);
      const stat = await lstat(filename);
      if (stat.isSymbolicLink())
        throw new Error('Source snapshot does not accept source symlinks.');
      if (stat.isDirectory()) await visit(filename);
      else if (stat.isFile())
        hashes[path.relative(root, filename)] = sha256(await readFile(filename));
    }
  }
  await visit(path.join(root, 'src'));
  return hashes;
}

async function snapshotInputs(snapshot) {
  const manifest = {};
  const excluded = new Set(['node_modules', '.git', 'dist', 'coverage', '.cache']);
  async function copy(relative) {
    const from = path.join(ROOT, relative);
    const to = path.join(snapshot, relative);
    const stat = await lstat(from);
    if (stat.isSymbolicLink()) throw new Error(`Snapshot input contains a symlink: ${relative}`);
    if (stat.isDirectory()) {
      await mkdir(to, { recursive: true });
      for (const child of (await readdir(from)).sort()) {
        if (!excluded.has(child)) await copy(path.join(relative, child));
      }
    } else if (stat.isFile()) {
      await copyFile(from, to, constants.COPYFILE_EXCL);
      manifest[relative] = sha256(await readFile(to));
    }
  }
  for (const required of [
    'src',
    'test',
    'bench',
    'scripts',
    'sql',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'jest.config.ts',
    'README.md',
  ])
    await copy(required);
  for (const optional of ['docs', 'LICENSE', '.eslintrc.cjs', '.prettierrc', '.prettierignore']) {
    try {
      await access(path.join(ROOT, optional));
    } catch {
      continue;
    }
    await copy(optional);
  }
  await symlink(
    await realpath(path.join(ROOT, 'node_modules')),
    path.join(snapshot, 'node_modules'),
    'dir',
  );
  return manifest;
}

function replaceExactlyOnce(text, edit) {
  if (text.split(edit.before).length !== 2) {
    throw new Error(`Mutation anchor drift: ${edit.file} must contain its anchor exactly once.`);
  }
  return text.replace(edit.before, edit.after);
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function recognizedAssertion(failure) {
  const messages = failure.failureMessages ?? [];
  if (messages.length === 0) return false;
  if (
    messages.some((message) =>
      /Exceeded timeout|timed out|TimeoutError|Test suite failed to run|TS\d{4}:|Cannot find module|SyntaxError:|ReferenceError:|TypeError:/.test(
        stripAnsi(message),
      ),
    )
  ) {
    return false;
  }
  const details = failure.failureDetails ?? [];
  // Jest serializes matcherResult for ordinary matchers. A rejected-expectation
  // receiving a fulfilled promise is also a Jest assertion, but has no result.
  if (
    details.length === messages.length &&
    details.every((item) => item?.matcherResult && typeof item.matcherResult === 'object')
  )
    return true;
  return messages.every((message) => {
    const plain = stripAnsi(message).trim();
    return (
      /^(?:Error: )?expect\(/.test(plain) &&
      plain.includes('Received promise resolved instead of rejected')
    );
  });
}

/** Conservative classification: a runtime/test timeout is never a mutation kill. */
export function classifyJest(result, execution, expectedSuites, snapshot, baseline = false) {
  const error = (reason, failures = []) => ({ status: 'error', reason, failures });
  if (execution.timedOut) return error('Jest process exceeded its hard deadline.');
  if (execution.interrupted) return error('Mutation run was interrupted.');
  if (execution.error || execution.signal || execution.truncated)
    return error('Jest process or output capture failed.');
  if (!result || !Array.isArray(result.testResults))
    return error('Jest did not produce a valid JSON result.');
  if (result.wasInterrupted || result.numRuntimeErrorTestSuites > 0)
    return error('Jest reported an import, compilation, or suite runtime error.');
  const actualSuites = result.testResults
    .map((suite) => path.relative(snapshot, suite.name))
    .sort();
  if (JSON.stringify(actualSuites) !== JSON.stringify([...expectedSuites].sort()))
    return error('Jest did not execute exactly the requested suites.');
  if (
    result.numPendingTests !== 0 ||
    result.numTodoTests !== 0 ||
    result.numPendingTestSuites !== 0
  )
    return error('Skipped or todo tests invalidate this probe.');
  const assertions = result.testResults.flatMap((suite) => suite.assertionResults ?? []);
  if (
    assertions.length === 0 ||
    assertions.some((item) => !['passed', 'failed'].includes(item.status))
  )
    return error('Jest returned missing, skipped, or unknown assertion results.');
  const failed = assertions.filter((item) => item.status === 'failed');
  const failures = failed.map((item) => ({
    fullName: item.fullName,
    messages: (item.failureMessages ?? []).map(stripAnsi),
    assertion: recognizedAssertion(item),
  }));
  if (baseline) {
    return execution.code === 0 &&
      result.success === true &&
      result.numFailedTests === 0 &&
      result.numFailedTestSuites === 0 &&
      failed.length === 0
      ? { status: 'pass', tests: assertions.length, failures: [] }
      : error('Unmodified baseline must pass before injecting any mutant.', failures);
  }
  if (execution.code === 0 && result.success === true && failed.length === 0) {
    return { status: 'survived', tests: assertions.length, failures: [] };
  }
  if (
    execution.code !== 1 ||
    result.success !== false ||
    failed.length === 0 ||
    result.numFailedTests !== failed.length ||
    failures.some((item) => !item.assertion)
  ) {
    return error('Failure is not exclusively recognized Jest matcher assertions.', failures);
  }
  return { status: 'killed', tests: assertions.length, failures };
}

async function runJest({ snapshot, output, name, suites, projects, timeoutMs, state, redact }) {
  const jsonFile = path.join(output, `${name}.jest.json`);
  const logFile = path.join(output, `${name}.log`);
  // Keep Jest's original result private until it has been sanitized for output.
  const rawFile = path.join(snapshot, `${name}.raw-jest.json`);
  const args = [
    path.join(snapshot, 'node_modules/jest/bin/jest.js'),
    '--config',
    path.join(snapshot, 'jest.config.ts'),
    '--runInBand',
    '--no-cache',
    '--json',
    '--outputFile',
    rawFile,
    '--selectProjects',
    ...projects,
    '--runTestsByPath',
    ...suites.map((suite) => path.join(snapshot, suite)),
  ];
  const startedAt = Date.now();
  const execution = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: snapshot,
      env: {
        ...process.env,
        S5_REQUIRE_REAL_STORAGE: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        CI: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let log = '';
    let timedOut = false;
    let truncated = false;
    let spawnError;
    const terminate = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Process may already have exited. */
      }
    };
    state.terminate = terminate;
    if (state.interrupted) terminate();
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        if (log.length + chunk.length > 4 * 1024 * 1024) {
          truncated = true;
          terminate();
        } else log += chunk;
      });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.once('error', (error) => {
      spawnError = error.message;
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      state.terminate = undefined;
      resolve({
        code,
        signal,
        timedOut,
        interrupted: state.interrupted,
        truncated,
        error: spawnError,
        log,
      });
    });
  });
  let result;
  try {
    result = JSON.parse(await readFile(rawFile, 'utf8'));
  } catch {
    /* Classifier reports missing result. */
  }
  // Remove credentials even when a driver puts a service URL in an error.
  await writeFile(logFile, redact(execution.log), { mode: 0o600, flag: 'wx' });
  await writeFile(
    jsonFile,
    JSON.stringify(sanitize(result ?? { error: 'No valid Jest JSON produced.' }, redact), null, 2) +
      '\n',
    { mode: 0o600, flag: 'wx' },
  );
  if (result)
    await writeFile(rawFile, JSON.stringify(sanitize(result, redact)) + '\n', { mode: 0o600 });
  else await writeFile(rawFile, '{"error":"No valid Jest JSON produced."}\n', { mode: 0o600 });
  return {
    result,
    execution,
    artifacts: { json: path.basename(jsonFile), log: path.basename(logFile) },
    process: {
      exitCode: execution.code,
      signal: execution.signal,
      timedOut: execution.timedOut,
      interrupted: execution.interrupted,
    },
    durationMs: Date.now() - startedAt,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(HELP);
    return;
  }
  const services = serviceEnvironment();
  const redact = redactor(services);
  const root = await realpath(ROOT);
  const outputParent = await realpath(path.dirname(options.output));
  const output = path.join(outputParent, path.basename(options.output));
  if (inside(root, output)) throw new Error('--output must be outside the repository.');
  await mkdir(output, { mode: 0o700 }); // Never reuse or overwrite earlier evidence.
  const summary = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    status: 'error',
    scope: 'Seven selected defects; no whole-package mutation coverage claim.',
    node: process.version,
    timeoutMs: options.timeoutMs,
    baseline: { status: 'not-run' },
    mutants: MUTANTS.map(({ id, description, suite, project, edits }) => ({
      id,
      description,
      suite,
      project,
      patches: edits.map(({ file, before, after }) => ({ file, before, after })),
      status: 'not-run',
    })),
  };
  const state = { interrupted: false, terminate: undefined };
  const interrupt = () => {
    state.interrupted = true;
    state.terminate?.();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let originalHashes;
  const save = async () =>
    writeFile(
      path.join(output, 'summary.json'),
      JSON.stringify(sanitize(summary, redact), null, 2) + '\n',
      { mode: 0o600 },
    );
  try {
    originalHashes = await sourceHashes(root);
    const snapshot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'idempotency-mutation-')));
    summary.snapshot = snapshot;
    const manifest = await snapshotInputs(snapshot);
    summary.snapshotDigest = sha256(JSON.stringify(manifest));
    await writeFile(
      path.join(output, 'snapshot-files.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    if (JSON.stringify(originalHashes) !== JSON.stringify(await sourceHashes(snapshot))) {
      throw new Error('Source changed while creating the isolated snapshot.');
    }
    for (const mutant of MUTANTS) {
      for (const edit of mutant.edits)
        replaceExactlyOnce(await readFile(path.join(snapshot, edit.file), 'utf8'), edit);
    }
    const suites = [...new Set(MUTANTS.map((mutant) => mutant.suite))];
    console.log(`Baseline: ${suites.length} selected suites, zero skips required.`);
    const baseline = await runJest({
      snapshot,
      output,
      name: 'baseline',
      suites,
      projects: ['unit', 'e2e'],
      timeoutMs: options.timeoutMs,
      state,
      redact,
    });
    summary.baseline = {
      ...classifyJest(baseline.result, baseline.execution, suites, snapshot, true),
      ...baseline.artifacts,
      process: baseline.process,
      durationMs: baseline.durationMs,
    };
    await save();
    if (summary.baseline.status !== 'pass')
      throw new Error('Baseline failed; no mutants were injected.');
    for (const [index, mutant] of MUTANTS.entries()) {
      if (state.interrupted) throw new Error('Mutation run was interrupted.');
      const originals = new Map();
      try {
        for (const edit of mutant.edits) {
          const filename = path.join(snapshot, edit.file);
          const current = await readFile(filename, 'utf8');
          if (!originals.has(filename)) originals.set(filename, current);
          await writeFile(filename, replaceExactlyOnce(current, edit));
        }
        const run = await runJest({
          snapshot,
          output,
          name: mutant.id,
          suites: [mutant.suite],
          projects: [mutant.project],
          timeoutMs: options.timeoutMs,
          state,
          redact,
        });
        Object.assign(
          summary.mutants[index],
          classifyJest(run.result, run.execution, [mutant.suite], snapshot),
          run.artifacts,
          { process: run.process, durationMs: run.durationMs },
        );
      } catch (error) {
        Object.assign(summary.mutants[index], { status: 'error', reason: redact(error.message) });
      } finally {
        for (const [filename, source] of originals) await writeFile(filename, source);
      }
      console.log(`${mutant.id}: ${summary.mutants[index].status}`);
      await save();
    }
    summary.status = summary.mutants.every((mutant) => mutant.status === 'killed')
      ? 'pass'
      : 'fail';
  } catch (error) {
    summary.error = redact(error instanceof Error ? error.message : 'Unknown runner failure.');
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (originalHashes) {
      try {
        summary.originalSourceUnchanged =
          JSON.stringify(originalHashes) === JSON.stringify(await sourceHashes(root));
      } catch {
        summary.originalSourceUnchanged = false;
      }
      if (!summary.originalSourceUnchanged) {
        summary.status = 'error';
        summary.error = 'Original source changed during the run; the evidence is not accepted.';
      }
    }
    summary.finishedAt = new Date().toISOString();
    summary.counts = Object.fromEntries(
      ['killed', 'survived', 'error', 'not-run'].map((status) => [
        status,
        summary.mutants.filter((mutant) => mutant.status === status).length,
      ]),
    );
    await save();
    console.log(`Mutation result: ${summary.status}. Evidence: ${output}`);
    if (summary.status !== 'pass') process.exitCode = 1;
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    console.error(
      'Mutation setup failed. Check --help, both service URLs, and a fresh output path with an existing parent.',
    );
    process.exitCode = 1;
  });
}
