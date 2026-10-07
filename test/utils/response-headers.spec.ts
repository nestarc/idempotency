import {
  captureReplayHeaders,
  replayStoredHeaders,
  type HeaderReplayResponse,
} from '../../src/utils/response-headers';

describe('response header replay utilities', () => {
  describe('captureReplayHeaders', () => {
    it('captures the default allowlist and x- headers from getHeaders', () => {
      const headers = captureReplayHeaders(
        {
          getHeaders: () => ({
            'content-type': 'application/json',
            location: '/orders/123',
            etag: '"abc123"',
            'cache-control': 'private, max-age=60',
            'x-request-id': 'req-123',
            authorization: 'Bearer secret',
          }),
        },
        true,
      );

      expect(headers).toEqual({
        'content-type': 'application/json',
        location: '/orders/123',
        etag: '"abc123"',
        'cache-control': 'private, max-age=60',
        'x-request-id': 'req-123',
      });
    });

    it('never captures denied headers even when explicitly allowed', () => {
      const headers = captureReplayHeaders(
        {
          getHeaders: () => ({
            'set-cookie': 'sid=abc',
            connection: 'keep-alive',
            location: '/orders/123',
          }),
        },
        ['set-cookie', 'connection', 'location'],
      );

      expect(headers).toEqual({
        location: '/orders/123',
      });
    });

    it('never captures current-request status headers even with an explicit allowlist', () => {
      expect(
        captureReplayHeaders(
          {
            getHeaders: () => ({
              'IDEMPOTENCY-STATUS': 'created',
              'Idempotency-Replayed': 'false',
              location: '/orders/123',
            }),
          },
          ['idempotency-status', 'IDEMPOTENCY-REPLAYED', 'location'],
        ),
      ).toEqual({ location: '/orders/123' });
    });

    it('returns undefined when disabled', () => {
      const getHeaders = jest.fn(() => ({ 'content-type': 'application/json' }));
      expect(captureReplayHeaders({ getHeaders }, false)).toBeUndefined();
      expect(getHeaders).not.toHaveBeenCalled();
    });

    it('returns undefined when no headers match', () => {
      expect(
        captureReplayHeaders({
          getHeaders: () => ({
            authorization: 'Bearer secret',
          }),
        }),
      ).toBeUndefined();
    });

    it('returns undefined when getHeaders is unavailable', () => {
      expect(captureReplayHeaders({})).toBeUndefined();
    });

    it('normalizes captured names and matches explicit allowlists case-insensitively', () => {
      const headers = captureReplayHeaders(
        {
          getHeaders: () => ({
            'Content-Type': 'application/json',
            LOCATION: '/orders/123',
            Authorization: 'Bearer secret',
          }),
        },
        ['CONTENT-TYPE', 'location'],
      );

      expect(headers).toEqual({
        'content-type': 'application/json',
        location: '/orders/123',
      });
    });

    it('stringifies numeric and array header values', () => {
      const headers = captureReplayHeaders({
        getHeaders: () => ({
          etag: 123,
          'x-flags': ['alpha', 'beta'],
          'x-empty': undefined,
        }),
      });

      expect(headers).toEqual({
        etag: '123',
        'x-flags': 'alpha, beta',
      });
    });
  });

  describe('replayStoredHeaders', () => {
    it.each(['setHeader', 'header'] as const)(
      'preserves the %s response receiver when applying headers',
      (method) => {
        const response: HeaderReplayResponse & { headers: Record<string, string> } = {
          headers: {} as Record<string, string>,
          [method](this: { headers: Record<string, string> }, name: string, value: string) {
            this.headers[name] = value;
          },
        };
        replayStoredHeaders(response, { Location: '/payments/pay-1', 'X-Result': 'created' });
        expect(response.headers).toEqual({ location: '/payments/pay-1', 'x-result': 'created' });
      },
    );

    it('uses setHeader when available', () => {
      const setHeader = jest.fn();
      const header = jest.fn();

      replayStoredHeaders(
        {
          setHeader,
          header,
        },
        {
          'content-type': 'application/json',
          location: '/orders/123',
        },
      );

      expect(setHeader).toHaveBeenCalledTimes(2);
      expect(setHeader).toHaveBeenCalledWith('content-type', 'application/json');
      expect(setHeader).toHaveBeenCalledWith('location', '/orders/123');
      expect(header).not.toHaveBeenCalled();
    });

    it('uses Fastify-style header when setHeader is absent', () => {
      const header = jest.fn();

      replayStoredHeaders(
        {
          header,
        },
        {
          'content-type': 'application/json',
        },
      );

      expect(header).toHaveBeenCalledTimes(1);
      expect(header).toHaveBeenCalledWith('content-type', 'application/json');
    });

    it('does not replay denied stored headers', () => {
      const setHeader = jest.fn();

      replayStoredHeaders(
        {
          setHeader,
        },
        {
          'set-cookie': 'sid=abc',
          connection: 'keep-alive',
          location: '/orders/123',
        },
      );

      expect(setHeader).toHaveBeenCalledTimes(1);
      expect(setHeader).toHaveBeenCalledWith('location', '/orders/123');
    });

    it('never replays stored status headers even with an explicit allowlist', () => {
      const setHeader = jest.fn();

      replayStoredHeaders(
        { setHeader },
        {
          'Idempotency-Status': 'created',
          'IDEMPOTENCY-REPLAYED': 'false',
          location: '/orders/123',
        },
        ['IDEMPOTENCY-STATUS', 'idempotency-replayed', 'location'],
      );

      expect(setHeader.mock.calls).toEqual([['location', '/orders/123']]);
    });

    it('does not replay stored headers when disabled', () => {
      const setHeader = jest.fn();

      replayStoredHeaders(
        {
          setHeader,
        },
        {
          location: '/orders/123',
        },
        false,
      );

      expect(setHeader).not.toHaveBeenCalled();
    });

    it('matches explicit replay allowlists case-insensitively', () => {
      const setHeader = jest.fn();

      replayStoredHeaders(
        {
          setHeader,
        },
        {
          Location: '/orders/123',
          'x-request-id': 'req-123',
          etag: '"abc123"',
          'set-cookie': 'sid=abc',
        },
        ['LOCATION'],
      );

      expect(setHeader).toHaveBeenCalledTimes(1);
      expect(setHeader).toHaveBeenCalledWith('location', '/orders/123');
    });
  });

  it.each([
    'set-cookie',
    'connection',
    'transfer-encoding',
    'keep-alive',
    'upgrade',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'idempotency-status',
    'idempotency-replayed',
  ])('never captures or replays explicitly allowed %s', (name) => {
    const stored = { [name.toUpperCase()]: 'must-not-replay', location: '/orders/123' };
    expect(captureReplayHeaders({ getHeaders: () => stored }, [name, 'location'])).toEqual({
      location: '/orders/123',
    });
    const setHeader = jest.fn();
    replayStoredHeaders({ setHeader }, stored, [name, 'location']);
    expect(setHeader.mock.calls).toEqual([['location', '/orders/123']]);
  });
});
