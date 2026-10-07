#!/usr/bin/env node
/** Actual-tarball consumer checks. No source imports or repository dependencies. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(repository, 'test/consumers');
const args = process.argv.slice(2);
let tarball;
let baseline = false;
let skipServices = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--tarball' || args[i] === '--baseline') {
    assert(!tarball, 'Choose only one of --tarball and --baseline');
    baseline = args[i] === '--baseline';
    assert(args[i + 1] && !args[i + 1].startsWith('--'), 'Tarball path required');
    tarball = resolve(args[++i]);
  } else if (args[i] === '--skip-services') {
    skipServices = true;
  } else if (args[i] === '--help') {
    console.log(
      'node scripts/consumer-package.mjs [--tarball file.tgz | --baseline file.tgz] [--skip-services]\n' +
        'Default: build and pack this repository. Real Redis/Postgres URLs are required unless explicitly skipped.\n' +
        'Artifacts and lockfiles are retained under /private/tmp/idempotency-consumers-*.',
    );
    process.exit(0);
  } else {
    throw new Error(`Unknown argument: ${args[i]}`);
  }
}

// /private/tmp (or /tmp on Linux) is outside the source checkout. Every ancestor
// is checked below, including /node_modules; Node global paths are also disabled.
const temporaryRoot = existsSync('/private/tmp') ? '/private/tmp' : '/tmp';
const output = realpathSync(mkdtempSync(join(temporaryRoot, 'idempotency-consumers-')));
const env = { ...process.env };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
env.NPM_CONFIG_CACHE ??= join(temporaryRoot, 'idempotency-consumer-npm-cache');
env.CONSUMER_SKIP_SERVICES = skipServices ? '1' : '0';
const summary = {
  startedAt: new Date().toISOString(),
  mode: baseline ? 'baseline' : 'candidate',
  repository,
  artifacts: output,
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  typescript: '5.7.3',
  moduleResolution: ['node', 'node16', 'nodenext'],
  services: {
    explicitlySkipped: skipServices,
    redisUrlProvided: Boolean(env.TEST_REDIS_URL),
    databaseUrlProvided: Boolean(env.TEST_DATABASE_URL),
  },
  checks: [],
};
let serial = 0;

function saveSummary() {
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
}

function record(name, status, detail = {}) {
  summary.checks.push({ name, status, ...detail });
  saveSummary();
  console.log(`${status.toUpperCase()} ${name}`);
}

function execute(name, command, commandArgs, cwd, options = {}) {
  const log = join(output, `${String(++serial).padStart(2, '0')}-${name}.log`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.stack}` : ''}`;
  writeFileSync(log, `$ ${command} ${commandArgs.join(' ')}\n${combined}`);
  if (options.expected) {
    assert.notEqual(result.status, 0, `${name}: expected failure; see ${log}`);
    for (const pattern of options.expected) {
      assert.match(combined, pattern, `${name}: missing expected diagnostic; see ${log}`);
    }
    record(name, 'expected-failure', { exitCode: result.status, log });
  } else {
    assert.equal(
      result.status,
      0,
      `${name}: failed (${result.status}); see ${log}\n${combined.slice(-3000)}`,
    );
    record(name, 'pass', { log });
  }
  return result.stdout;
}

function checkAncestors(directory) {
  let ancestor = dirname(directory);
  while (true) {
    assert(
      !existsSync(join(ancestor, 'node_modules')),
      `Isolation violation: ${ancestor}/node_modules exists`,
    );
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const relation = relative(repository, directory);
  assert(
    relation.startsWith('..') || isAbsolute(relation),
    'Consumer must live outside the checkout',
  );
}

function assertNoPackageSymlinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.bin') continue; // npm executable shims are normal.
    const path = join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Unexpected installed package symlink: ${path}`);
    if (entry.isDirectory()) assertNoPackageSymlinks(path);
  }
}

function assertTree(variant, directory, phase) {
  const tree = JSON.parse(
    execute(`${variant}-${phase}-npm-ls`, 'npm', ['ls', '--all', '--json'], directory),
  );
  const installed = new Set();
  function visit(node) {
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      if (dependency.version) installed.add(name);
      visit(dependency);
    }
  }
  visit(tree);
  for (const name of variant === 'memory'
    ? ['pg', 'ioredis', '@types/pg']
    : variant === 'redis'
      ? ['pg', '@types/pg']
      : ['ioredis']) {
    assert(!installed.has(name), `${variant}: unexpected installed ${name}`);
    assert(
      !existsSync(join(directory, 'node_modules', name)),
      `${variant}: unexpected ${name} directory`,
    );
  }
  if (variant === 'postgres' && phase === 'without-pg-types') {
    assert(!installed.has('@types/pg'), 'The initial Postgres fixture must omit @types/pg');
  }
  const packageDirectory = join(directory, 'node_modules/@nestarc/idempotency');
  assert(!lstatSync(packageDirectory).isSymbolicLink(), 'Tarball package must not be a link');
  assert.equal(realpathSync(packageDirectory), packageDirectory);
  assertNoPackageSymlinks(join(directory, 'node_modules'));
  checkAncestors(directory);
  record(`${variant}-${phase}-isolation`, 'pass', {
    dependencies: [...installed].sort(),
    nodePath: 'unset',
    globalSearchPaths: 'disabled',
    packageSymlinks: false,
    ancestorNodeModules: false,
  });
  writeFileSync(join(directory, `installed-${phase}.json`), JSON.stringify(tree, null, 2) + '\n');
}

function compile(variant, directory, options = {}) {
  for (const resolution of ['node', 'node16', 'nodenext']) {
    const compilerArgs = [
      '--no-global-search-paths',
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--moduleResolution',
      resolution,
      '--module',
      resolution === 'node' ? 'commonjs' : resolution,
    ];
    if (baseline) {
      compilerArgs.push(
        '--strict',
        '--skipLibCheck',
        'false',
        '--target',
        'ES2022',
        '--esModuleInterop',
        'true',
        'common/baseline.ts',
      );
    } else {
      compilerArgs.push('-p', 'tsconfig.json');
    }
    execute(
      `${variant}-${options.phase ?? 'strict'}-${resolution}`,
      process.execPath,
      compilerArgs,
      directory,
      options,
    );
  }
}

function verifyReadmeQuickstart(directory) {
  const readme = readFileSync(
    join(directory, 'node_modules/@nestarc/idempotency/README.md'),
    'utf8',
  ).replaceAll('\r\n', '\n');
  const quickstart = readme.match(/```ts\n(\/\/ app\.module\.ts\n[\s\S]*?)\n```/);
  assert(quickstart, 'Packaged README must contain the complete // app.module.ts quickstart');
  const fixture = readFileSync(join(directory, 'quickstart.ts'), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(
    fixture.trim(),
    quickstart[1].trim(),
    'README quickstart and executed fixture drifted',
  );
  record('memory-readme-quickstart-match', 'pass');
}

function install(variant, directory, phase) {
  execute(
    `${variant}-${phase}-lock`,
    'npm',
    ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    directory,
  );
  execute(
    `${variant}-${phase}-ci`,
    'npm',
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    directory,
  );
  assertTree(variant, directory, phase);
}

function inspectTarball() {
  const listing = execute('tarball-files', 'tar', ['-tzf', tarball], repository)
    .trim()
    .split('\n')
    .sort();
  writeFileSync(join(output, 'tarball-files.json'), JSON.stringify(listing, null, 2) + '\n');
  for (const file of [
    'package/package.json',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/sql/init.sql',
    'package/README.md',
    'package/LICENSE',
  ]) {
    assert(listing.includes(file), `Missing tarball file: ${file}`);
  }
  for (const file of listing) {
    assert(file.startsWith('package/'), `Unexpected tarball path: ${file}`);
    assert(!file.split('/').includes('..'), `Unsafe tarball path: ${file}`);
    assert(
      !/^package\/(?:src|test|node_modules|\.git)\//.test(file),
      `Development file shipped: ${file}`,
    );
    if (file.endsWith('.js'))
      assert(listing.includes(file.replace(/\.js$/, '.d.ts')), `Missing declaration for ${file}`);
  }
  if (!baseline) {
    for (const file of ['redis', 'postgres']) {
      assert(listing.includes(`package/dist/${file}.js`), `Missing ${file} runtime entry`);
      assert(listing.includes(`package/dist/${file}.d.ts`), `Missing ${file} declaration entry`);
    }
  }
  record('tarball-inventory', 'pass', { files: listing.length });
}

try {
  checkAncestors(output);
  console.log(`Consumer artifacts: ${output}`);
  summary.npm = execute('npm-version', 'npm', ['--version'], repository).trim();
  summary.commit = execute('git-head', 'git', ['rev-parse', 'HEAD'], repository).trim();
  summary.workingTree = execute('git-status', 'git', ['status', '--short'], repository).trim();
  if (!tarball) {
    execute('build', 'npm', ['run', 'build'], repository);
    const packed = JSON.parse(
      execute('pack', 'npm', ['pack', '--json', '--pack-destination', output], repository),
    );
    tarball = join(output, packed[0].filename);
  }
  tarball = realpathSync(tarball);
  summary.tarball = tarball;
  summary.sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  writeFileSync(join(output, 'tarball.sha256'), `${summary.sha256}  ${tarball}\n`);
  inspectTarball();

  for (const variant of ['memory', 'redis', 'postgres']) {
    try {
      const directory = join(output, variant);
      mkdirSync(directory);
      cpSync(join(fixtures, 'common'), join(directory, 'common'), { recursive: true });
      cpSync(join(fixtures, variant), directory, { recursive: true });
      const packagePath = join(directory, 'package.json');
      const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
      manifest.dependencies['@nestarc/idempotency'] = `file:${tarball}`;
      writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + '\n');
      install(variant, directory, variant === 'postgres' ? 'without-pg-types' : 'initial');
      if (!baseline && variant === 'memory') verifyReadmeQuickstart(directory);
      const installedManifest = JSON.parse(
        readFileSync(join(directory, 'node_modules/@nestarc/idempotency/package.json'), 'utf8'),
      );
      writeFileSync(
        join(directory, 'installed-package.json'),
        JSON.stringify(installedManifest, null, 2) + '\n',
      );
      const imports = baseline
        ? ['@nestarc/idempotency']
        : [
            '@nestarc/idempotency',
            ...(variant === 'memory' ? [] : [`@nestarc/idempotency/${variant}`]),
          ];
      execute(
        `${variant}-node-import`,
        process.execPath,
        [
          '--no-global-search-paths',
          '-e',
          imports.map((name) => `require(${JSON.stringify(name)})`).join(';'),
        ],
        directory,
        baseline && variant !== 'postgres' ? { expected: [/Cannot find module 'pg'/] } : {},
      );

      if (baseline) {
        const expected =
          variant === 'memory'
            ? [/TS2307[^\n]*'pg'/, /TS2307[^\n]*'ioredis'/]
            : variant === 'redis'
              ? [/TS2307[^\n]*'pg'/]
              : [/TS7016[^\n]*'pg'/, /TS2307[^\n]*'ioredis'/];
        compile(variant, directory, { expected, phase: 'baseline' });
      } else if (variant === 'postgres') {
        compile(variant, directory, { expected: [/TS7016[^\n]*'pg'/], phase: 'without-pg-types' });
      } else {
        compile(variant, directory);
      }
      if (variant === 'postgres') {
        cpSync(
          join(directory, 'package-lock.json'),
          join(directory, 'package-lock.without-pg-types.json'),
        );
        cpSync(packagePath, join(directory, 'package.without-pg-types.json'));
        manifest.devDependencies['@types/pg'] = '8.20.0';
        writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + '\n');
        install(variant, directory, 'with-pg-types');
        compile(
          variant,
          directory,
          baseline
            ? { expected: [/TS2307[^\n]*'ioredis'/], phase: 'with-pg-types' }
            : { phase: 'with-pg-types' },
        );
      }
      if (!baseline) {
        // Run the very TypeScript modules checked above, so documentation
        // examples cannot pass by compiling unused code beside a different JS fixture.
        execute(
          `${variant}-examples-emit`,
          process.execPath,
          [
            '--no-global-search-paths',
            'node_modules/typescript/bin/tsc',
            '-p',
            'tsconfig.json',
            '--noEmit',
            'false',
            '--outDir',
            'compiled',
          ],
          directory,
        );
        execute(
          `${variant}-runtime`,
          process.execPath,
          ['--no-global-search-paths', 'runtime.cjs'],
          directory,
        );
        if (skipServices && variant !== 'memory')
          record(`${variant}-real-service-smoke`, 'skip', { reason: 'Explicit --skip-services' });
        else record(`${variant}-storage-smoke`, 'pass');
      }
    } catch (error) {
      record(`${variant}-consumer`, 'fail', { error: error.stack });
      console.error(error.message);
    }
  }
} catch (error) {
  record('runner', 'fail', { error: error.stack });
  console.error(error.message);
} finally {
  summary.finishedAt = new Date().toISOString();
  summary.result = summary.checks.some((check) => check.status === 'fail')
    ? 'fail'
    : summary.checks.some((check) => check.status === 'skip')
      ? 'pass-with-skips'
      : 'pass';
  saveSummary();
  console.log(`${summary.result.toUpperCase()}: ${join(output, 'summary.json')}`);
  process.exitCode = summary.result === 'fail' ? 1 : 0;
}
