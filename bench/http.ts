import http from 'node:http';
import { performance } from 'node:perf_hooks';

export interface BenchmarkAddress {
  host: '127.0.0.1';
  port: number;
}

export interface BenchmarkResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
  durationMs: number;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

/** POST JSON over an explicit shared agent, timing through the complete body. */
export async function postJSON(
  address: BenchmarkAddress,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  agent: http.Agent,
  timeoutMs: number,
): Promise<BenchmarkResponse> {
  if (
    address.host !== '127.0.0.1' ||
    !Number.isSafeInteger(address.port) ||
    address.port < 1 ||
    address.port > 65535
  ) {
    throw new Error('Benchmark HTTP address must be a bound loopback TCP port.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error('Benchmark HTTP deadline must be a positive timer-safe integer.');
  }
  const payload = JSON.stringify(body);
  if (payload === undefined) throw new Error('Benchmark request body must be JSON-serializable.');

  return new Promise((resolve, reject) => {
    const start = performance.now();
    let settled = false;
    let response: http.IncomingMessage | undefined;
    let request: http.ClientRequest | undefined;

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // Destroy only this request's socket. The shared agent belongs to the
      // runner and remains available to unrelated requests until final cleanup.
      response?.destroy();
      request?.destroy();
      reject(new Error(message));
    };

    const deadline = setTimeout(
      () => fail('Benchmark HTTP request exceeded its overall deadline.'),
      timeoutMs,
    );
    try {
      request = http.request(
        {
          method: 'POST',
          host: address.host,
          port: address.port,
          path,
          agent,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          response = res;
          if (settled) {
            res.destroy();
            return;
          }
          if (res.statusCode === undefined) {
            fail('Benchmark HTTP response had no status code.');
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES) {
              fail('Benchmark HTTP response exceeded the 1 MiB limit.');
              return;
            }
            chunks.push(chunk);
          });
          res.on('aborted', () => fail('Benchmark HTTP response was aborted.'));
          res.on('error', () => fail('Benchmark HTTP response failed.'));
          res.on('close', () => {
            if (!res.complete) fail('Benchmark HTTP response closed before completion.');
          });
          res.on('end', () => {
            if (settled) return;
            const durationMs = performance.now() - start;
            if (durationMs > timeoutMs) {
              fail('Benchmark HTTP request exceeded its overall deadline.');
              return;
            }
            if (!res.complete) {
              fail('Benchmark HTTP response ended before completion.');
              return;
            }
            settled = true;
            clearTimeout(deadline);
            resolve({
              status: res.statusCode!,
              body: Buffer.concat(chunks, bytes).toString('utf8'),
              headers: res.headers,
              durationMs,
            });
          });
        },
      );
      request.on('error', () => fail('Benchmark HTTP request failed.'));
      request.end(payload);
    } catch {
      fail('Benchmark HTTP request could not be created.');
    }
  });
}
