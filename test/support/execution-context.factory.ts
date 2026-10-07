import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Observable, of } from 'rxjs';

export interface FakeRequest {
  method: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface FakeResponse {
  statusCode: number;
  status: jest.Mock<FakeResponse, [number]>;
  getHeaders: jest.Mock<Record<string, string>>;
  setHeader: jest.Mock<FakeResponse, [string, string]>;
}

/**
 * Builds a `FakeResponse` whose `status(n)` mutates `statusCode` and is itself
 * a jest.fn so test assertions can verify both the call and the resulting state.
 */
export const buildResponse = (
  initialStatus = 200,
  initialHeaders: Record<string, string> = {},
): FakeResponse => {
  const headers = Object.fromEntries(
    Object.entries(initialHeaders).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const res: Partial<FakeResponse> = { statusCode: initialStatus };
  res.status = jest.fn((code: number): FakeResponse => {
    (res as FakeResponse).statusCode = code;
    return res as FakeResponse;
  });
  res.getHeaders = jest.fn(() => ({ ...headers }));
  res.setHeader = jest.fn((name: string, value: string): FakeResponse => {
    headers[name.toLowerCase()] = value;
    return res as FakeResponse;
  });
  return res as FakeResponse;
};

/**
 * Builds a fake `ExecutionContext` whose `switchToHttp()` returns the given
 * request and response. The handler reference is supplied so tests can hang
 * decorator metadata off it via `Reflect.defineMetadata` or `SetMetadata`.
 */
export const buildExecutionContext = (params: {
  req: FakeRequest;
  res?: FakeResponse;
  handler?: (...args: any[]) => any;
  controller?: any;
}): { context: ExecutionContext; res: FakeResponse } => {
  const res = params.res ?? buildResponse();
  const handler = params.handler ?? (() => undefined);
  const controller = params.controller ?? class {};

  // Use Nest's real context host so custom resolvers see the same arguments
  // through getArgs/getArgByIndex and switchToHttp. The old handwritten host
  // returned an empty argument list even when a request was available.
  const context = new ExecutionContextHost([params.req, res, undefined], controller, handler);
  return { context, res };
};

/**
 * Builds a fake `CallHandler` whose `handle()` returns the given Observable.
 * The wrapper records whether `handle()` was called so tests can assert
 * pass-through vs short-circuit behavior.
 */
export const buildCallHandler = (
  source: Observable<unknown> = of(undefined),
): CallHandler & { handleSpy: jest.Mock } => {
  const handleSpy = jest.fn(() => source);
  return {
    handle: handleSpy,
    handleSpy,
  } as CallHandler & { handleSpy: jest.Mock };
};
