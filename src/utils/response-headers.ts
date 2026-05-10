import type { ReplayHeadersOption } from '../interfaces/idempotency-options.interface';

export type HeaderValue = string | number | readonly string[] | undefined;

export interface HeaderCaptureResponse {
  getHeaders?: () => Record<string, HeaderValue>;
}

export interface HeaderReplayResponse {
  setHeader?: (name: string, value: string) => unknown;
  header?: (name: string, value: string) => unknown;
}

const DEFAULT_ALLOWED_HEADERS = new Set([
  'content-type',
  'location',
  'etag',
  'cache-control',
]);

const DENIED_HEADERS = new Set([
  'set-cookie',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
]);

export function captureReplayHeaders(
  res: HeaderCaptureResponse,
  option: ReplayHeadersOption = true,
): Record<string, string> | undefined {
  if (option === false || !res.getHeaders) {
    return undefined;
  }

  const explicitAllowlist = Array.isArray(option)
    ? new Set(option.map((name) => name.toLowerCase()))
    : undefined;
  const captured: Record<string, string> = {};

  for (const [rawName, value] of Object.entries(res.getHeaders())) {
    const name = rawName.toLowerCase();

    if (isDeniedHeader(name) || !isAllowedHeader(name, explicitAllowlist)) {
      continue;
    }

    const stringValue = stringifyHeaderValue(value);
    if (stringValue !== undefined) {
      captured[name] = stringValue;
    }
  }

  return Object.keys(captured).length > 0 ? captured : undefined;
}

export function replayStoredHeaders(
  res: HeaderReplayResponse,
  headers?: Record<string, string>,
): void {
  if (!headers) {
    return;
  }

  const setHeader = res.setHeader ?? res.header;
  if (!setHeader) {
    return;
  }

  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!isDeniedHeader(name)) {
      setHeader.call(res, name, value);
    }
  }
}

export function stringifyHeaderValue(
  value: HeaderValue,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.join(', ');
  }

  return String(value);
}

function isAllowedHeader(
  name: string,
  explicitAllowlist?: Set<string>,
): boolean {
  if (explicitAllowlist) {
    return explicitAllowlist.has(name);
  }

  return DEFAULT_ALLOWED_HEADERS.has(name) || name.startsWith('x-');
}

function isDeniedHeader(name: string): boolean {
  return DENIED_HEADERS.has(name);
}
