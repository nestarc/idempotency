/**
 * Regression: legacy JSON cached before response-shape validation may contain
 * class fields omitted by Nest serialization. A JSON-shaped version marker can
 * itself be a legacy response, so only a non-JSON prefix identifies safe records.
 * Unsupported values must be rejected without running application getters/hooks.
 */
import { StreamableFile } from '@nestjs/common';

import { decodeReplayBody, encodeReplayBody } from '../../src/utils/replay-body';

const PREFIX = '@nestarc/idempotency:replay:v1:';

describe('REGRESSION: versioned replay body format', () => {
  it.each(
    [null, true, false, 0, -3.5, '', 'text', [], {}, [1, { nested: 'ok' }]].map((value) => [value]),
  )('round-trips a plain JSON response: %p', (value) => {
    expect(decodeReplayBody(encodeReplayBody(value))).toEqual({
      replayable: true,
      value,
    });
  });

  it('preserves root undefined with a nonempty versioned marker', () => {
    const encoded = encodeReplayBody(undefined);
    expect(encoded).toBe(`${PREFIX}{"kind":"undefined"}`);
    expect(decodeReplayBody(encoded)).toEqual({ replayable: true, value: undefined });
    expect(decodeReplayBody()).toEqual({ replayable: false });
  });

  it('rejects legacy values even when their shape resembles a new envelope', () => {
    for (const value of [
      null,
      'safe',
      {},
      { kind: 'undefined' },
      { kind: 'json', value: { secret: 'old' } },
    ]) {
      expect(decodeReplayBody(JSON.stringify(value))).toEqual({ replayable: false });
    }
    expect(decodeReplayBody(JSON.stringify(PREFIX + '{"kind":"undefined"}'))).toEqual({
      replayable: false,
    });
  });

  it('round-trips marker-shaped application JSON without unwrapping it', () => {
    const value = { kind: 'json', value: { kind: 'undefined' } };
    expect(decodeReplayBody(encodeReplayBody(value))).toEqual({ replayable: true, value });
  });

  it('round-trips marker-shaped application strings without decoding them twice', () => {
    const value = `${PREFIX}{"kind":"undefined"}`;
    expect(decodeReplayBody(encodeReplayBody(value))).toEqual({ replayable: true, value });
  });

  it.each([
    '',
    PREFIX,
    `${PREFIX}{`,
    `${PREFIX}null`,
    `${PREFIX}[]`,
    `${PREFIX}"text"`,
    `${PREFIX}{}`,
    `${PREFIX}{"kind":"json"}`,
    `${PREFIX}{"kind":"other","value":null}`,
    `${PREFIX}{"kind":"undefined","value":null}`,
    `${PREFIX}{"kind":"undefined","extra":1}`,
    `${PREFIX}{"kind":"json","value":1,"extra":2}`,
    `${PREFIX}{"kind":"json","value":1e999}`,
    '@nestarc/idempotency:replay:v2:{"kind":"json","value":1}',
  ])('fails closed for missing, corrupt or unsupported records: %s', (encoded) => {
    expect(decodeReplayBody(encoded)).toEqual({ replayable: false });
  });

  it('supports null-prototype data and repeated references without prototype mutation', () => {
    const child = Object.assign(Object.create(null) as Record<string, unknown>, { id: 1 });
    const value = Object.create(null) as Record<string, unknown>;
    value.__proto__ = { ordinary: 'data' };
    value.left = child;
    value.right = child;
    const result = decodeReplayBody(encodeReplayBody(value));
    expect(result.replayable).toBe(true);
    if (!result.replayable) throw new Error('Expected a supported response');
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result.value, '__proto__')).toBe(true);
    expect(result.value).toEqual(
      JSON.parse('{"__proto__":{"ordinary":"data"},"left":{"id":1},"right":{"id":1}}'),
    );
  });

  it('takes an immutable snapshot and ignores nonenumerable data properties', () => {
    const value = { child: { id: 1 } };
    Object.defineProperty(value, 'hidden', { value: 'not-json', enumerable: false });
    const encoded = encodeReplayBody(value);
    value.child.id = 2;
    expect(decodeReplayBody(encoded)).toEqual({ replayable: true, value: { child: { id: 1 } } });
  });

  it.each(
    [
      NaN,
      Infinity,
      -Infinity,
      BigInt(1),
      Symbol('response'),
      () => 'response',
      new Date(),
      Buffer.from('file'),
      new StreamableFile(Buffer.from('file')),
      { value: undefined },
      [undefined],
      { nested: { value: NaN } },
      Object.create({ inherited: 'custom' }),
    ].map((value) => [value]),
  )('rejects unsupported values instead of silently changing their meaning: %p', (value) => {
    expect(() => encodeReplayBody(value)).toThrow(TypeError);
  });

  it('rejects class instances, array subclasses, sparse arrays and extra array properties', () => {
    class Response {
      id = 1;
    }
    class Responses extends Array<unknown> {}
    const extra = [1];
    Object.assign(extra, { secret: 'extra-property' });
    for (const value of [new Response(), new Responses(1), new Array(1), extra]) {
      expect(() => encodeReplayBody(value)).toThrow(TypeError);
    }
  });

  it('rejects cycles and symbol-keyed properties', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => encodeReplayBody(cycle)).toThrow(TypeError);
    expect(() => encodeReplayBody({ [Symbol('hidden')]: 'value' })).toThrow(TypeError);
  });

  it.each([true, false])(
    'rejects accessors without executing them (enumerable: %s)',
    (enumerable) => {
      const getter = jest.fn(() => 'secret');
      const value = Object.defineProperty({}, 'secret', { get: getter, enumerable });
      expect(() => encodeReplayBody(value)).toThrow(TypeError);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])('rejects toJSON without executing it (enumerable: %s)', (enumerable) => {
    const hook = jest.fn(() => ({ transformed: true }));
    const value = Object.defineProperty({}, 'toJSON', { value: hook, enumerable });
    expect(() => encodeReplayBody(value)).toThrow(TypeError);
    expect(hook).not.toHaveBeenCalled();
  });

  it('rejects proxies without executing their property traps', () => {
    const trap = jest.fn();
    const proxy = new Proxy({}, { getPrototypeOf: trap, ownKeys: trap, get: trap });
    expect(() => encodeReplayBody(proxy)).toThrow(TypeError);
    expect(trap).not.toHaveBeenCalled();
  });
});
