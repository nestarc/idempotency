import {
  captureReplayHeaders,
  replayStoredHeaders,
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

    it('returns undefined when disabled', () => {
      expect(
        captureReplayHeaders(
          {
            getHeaders: () => ({
              'content-type': 'application/json',
            }),
          },
          false,
        ),
      ).toBeUndefined();
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
      expect(setHeader).toHaveBeenCalledWith(
        'content-type',
        'application/json',
      );
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
  });
});
