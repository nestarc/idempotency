import {
  extractActualRequestPath,
  normalizeHttpPath,
} from '../../src/utils/request-scope';

describe('request scope utilities', () => {
  describe('extractActualRequestPath', () => {
    it('prefers Express originalUrl and removes the query string', () => {
      expect(
        extractActualRequestPath({
          originalUrl: '/orders/123/capture?verbose=true',
          url: '/orders/:id/capture',
        }),
      ).toBe('/orders/123/capture');
    });

    it('uses Fastify-style url when originalUrl is absent', () => {
      expect(
        extractActualRequestPath({
          url: '/orders/456/capture?verbose=true',
        }),
      ).toBe('/orders/456/capture');
    });

    it('returns undefined when no request path is available', () => {
      expect(extractActualRequestPath(undefined)).toBeUndefined();
      expect(extractActualRequestPath({})).toBeUndefined();
    });
  });

  describe('normalizeHttpPath', () => {
    it('normalizes duplicate and trailing slashes', () => {
      expect(normalizeHttpPath('orders//123/capture/')).toBe(
        '/orders/123/capture',
      );
    });

    it('normalizes a query-only root path to slash', () => {
      expect(normalizeHttpPath('/?a=1')).toBe('/');
    });

    it('preserves an already normalized root path', () => {
      expect(normalizeHttpPath('/')).toBe('/');
    });

    it('normalizes duplicate slashes before a query string', () => {
      expect(normalizeHttpPath('//orders///123?verbose=true')).toBe(
        '/orders/123',
      );
    });
  });
});
