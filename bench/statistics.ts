export interface Stats {
  count: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

/** Millisecond latency statistics using the nearest-rank percentile definition. */
export function computeStats(samples: readonly number[]): Stats {
  if (samples.length === 0) throw new Error('Latency samples must not be empty.');
  for (const sample of samples) {
    if (!Number.isFinite(sample) || sample < 0) {
      throw new Error('Latency samples must be finite, nonnegative numbers.');
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  // An incremental mean avoids an overflowing sum of finite, nonnegative samples.
  const avg = sorted.reduce((mean, sample, index) => mean + (sample - mean) / (index + 1), 0);
  const percentile = (fraction: number): number => sorted[Math.ceil(fraction * sorted.length) - 1];
  return {
    count: sorted.length,
    avg,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}
