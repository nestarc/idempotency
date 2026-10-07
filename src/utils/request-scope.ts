export interface RequestScopeSource {
  originalUrl?: string;
  url?: string;
}

export function extractActualRequestPath(
  req: RequestScopeSource | undefined,
): string | undefined {
  const raw = req?.originalUrl ?? req?.url;
  if (!raw) {
    return undefined;
  }
  // Real routers can distinguish duplicate/trailing slashes. Do not merge
  // distinct resources merely because route metadata is usually normalized.
  const path = raw.split('?')[0];
  return path.startsWith('/') ? path : `/${path}`;
}

export function normalizeHttpPath(raw: string): string {
  const withoutQuery = raw.split('?')[0] ?? '';
  const withLeadingSlash = withoutQuery.startsWith('/')
    ? withoutQuery
    : `/${withoutQuery}`;
  const normalized = withLeadingSlash
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');
  return normalized === '' ? '/' : normalized;
}
