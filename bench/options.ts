export type BenchmarkAdapter = 'express' | 'fastify' | 'both';

export interface BenchmarkOptions {
  iterations: number;
  warmup: number;
  requestTimeoutMs: number;
  redisUrl?: string;
  postgresUrl?: string;
  requireServices: boolean;
  adapter: BenchmarkAdapter;
  output?: string;
  help: boolean;
}

export const BENCHMARK_HELP = `Usage: npm run bench -- [options]

  --iterations N          Measured requests per scenario (1–1000000; default 200)
  --warmup N              Warmup requests per scenario (0–1000000; default 20)
  --request-timeout-ms N  Overall deadline per HTTP request (1–300000; default 5000)
  --adapter NAME          express, fastify, or both (default express)
  --redis-url URL         Redis service URL (fallback: TEST_REDIS_URL)
  --postgres-url URL      PostgreSQL service URL (fallback: TEST_DATABASE_URL)
  --require-services      Require both Redis and PostgreSQL URLs
  --output PATH           Write a new JSON report; never overwrite an existing file
  --help                  Show this help

Use separate arguments, for example --iterations 200. Service URLs may contain
credentials; environment variables are preferred to shell command arguments.
`;

function integerOption(name: string, value: string, minimum: number, maximum: number): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`--${name} must be a canonical decimal integer.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`--${name} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function serviceUrl(
  value: string | undefined,
  name: string,
  protocols: readonly string[],
): string | undefined {
  if (!value) return undefined;
  try {
    // URL() silently strips whitespace. Reject it so the configured endpoint is
    // always the one the caller supplied, and never echo credentials on failure.
    if (value.includes(' ') || hasControlCharacters(value)) throw new Error();
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || !url.hostname) throw new Error();
  } catch {
    throw new Error(`${name} must be a valid ${protocols.join(' or ')} service URL.`);
  }
  return value;
}

export function parseOptions(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): BenchmarkOptions {
  const options: BenchmarkOptions = {
    iterations: 200,
    warmup: 20,
    requestTimeoutMs: 5000,
    adapter: 'express',
    requireServices: false,
    help: false,
  };
  const seen = new Set<string>();
  const valueOptions = new Set([
    '--iterations',
    '--warmup',
    '--request-timeout-ms',
    '--adapter',
    '--redis-url',
    '--postgres-url',
    '--output',
  ]);

  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!valueOptions.has(name) && name !== '--help' && name !== '--require-services') {
      throw new Error('Unknown benchmark option. Run with --help for supported options.');
    }
    if (seen.has(name)) throw new Error(`${name} must only be specified once.`);
    seen.add(name);
    if (name === '--help') {
      options.help = true;
      continue;
    }
    if (name === '--require-services') {
      options.requireServices = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('--') || value.trim() !== value) {
      throw new Error(`${name} requires a value.`);
    }
    switch (name) {
      case '--iterations':
        options.iterations = integerOption('iterations', value, 1, 1_000_000);
        break;
      case '--warmup':
        options.warmup = integerOption('warmup', value, 0, 1_000_000);
        break;
      case '--request-timeout-ms':
        options.requestTimeoutMs = integerOption('request-timeout-ms', value, 1, 300_000);
        break;
      case '--adapter':
        if (value !== 'express' && value !== 'fastify' && value !== 'both') {
          throw new Error('--adapter must be express, fastify, or both.');
        }
        options.adapter = value;
        break;
      case '--redis-url':
        options.redisUrl = value;
        break;
      case '--postgres-url':
        options.postgresUrl = value;
        break;
      case '--output':
        if (hasControlCharacters(value)) {
          throw new Error('--output must be a file path without control characters.');
        }
        options.output = value;
        break;
    }
  }

  // Help remains available even when the ambient service configuration is bad.
  if (options.help) return options;
  options.redisUrl = serviceUrl(
    options.redisUrl ?? env.TEST_REDIS_URL,
    '--redis-url / TEST_REDIS_URL',
    ['redis:', 'rediss:'],
  );
  options.postgresUrl = serviceUrl(
    options.postgresUrl ?? env.TEST_DATABASE_URL,
    '--postgres-url / TEST_DATABASE_URL',
    ['postgres:', 'postgresql:'],
  );
  if (options.requireServices && (!options.redisUrl || !options.postgresUrl)) {
    throw new Error('--require-services requires both Redis and PostgreSQL service URLs.');
  }
  return options;
}
