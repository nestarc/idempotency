/** Distinguishes a missing optional peer from a broken peer's own dependency. */
export function isMissingPeer(error: unknown, peer: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'MODULE_NOT_FOUND' &&
    error.message.startsWith(`Cannot find module '${peer}'`)
  );
}
