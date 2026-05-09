import { stableJsonStringify } from '../../src/utils/stable-json';

describe('stableJsonStringify', () => {
  it('sorts object keys recursively while preserving array order', () => {
    const a = { z: 1, a: { d: 4, b: 2 }, list: [{ y: 2, x: 1 }] };
    const b = { list: [{ x: 1, y: 2 }], a: { b: 2, d: 4 }, z: 1 };

    expect(stableJsonStringify(a)).toBe(stableJsonStringify(b));
    expect(stableJsonStringify(a)).toBe(
      '{"a":{"b":2,"d":4},"list":[{"x":1,"y":2}],"z":1}',
    );
  });

  it('sorts array-index-like object keys lexicographically', () => {
    expect(stableJsonStringify({ '10': 'ten', '2': 'two', a: 'aye' })).toBe(
      '{"10":"ten","2":"two","a":"aye"}',
    );
  });

  it('matches JSON.stringify behavior for nullish and primitive values', () => {
    expect(stableJsonStringify(undefined)).toBe(undefined);
    expect(stableJsonStringify(null)).toBe('null');
    expect(stableJsonStringify('x')).toBe('"x"');
    expect(stableJsonStringify(3)).toBe('3');
    expect(stableJsonStringify(true)).toBe('true');
  });

  it('matches JSON.stringify behavior for boxed primitive values', () => {
    // eslint-disable-next-line no-new-wrappers
    expect(stableJsonStringify(new Number(7))).toBe('7');
    // eslint-disable-next-line no-new-wrappers
    expect(stableJsonStringify(new String('ab'))).toBe('"ab"');
    // eslint-disable-next-line no-new-wrappers
    expect(stableJsonStringify(new Boolean(false))).toBe('false');
  });

  it('serializes fake boxed primitive prototype objects as ordinary objects', () => {
    expect(stableJsonStringify(Object.create(Number.prototype))).toBe('{}');
    expect(stableJsonStringify(Object.create(String.prototype))).toBe('{}');
    expect(stableJsonStringify(Object.create(Boolean.prototype))).toBe('{}');
    expect(stableJsonStringify(Object.create(BigInt.prototype))).toBe('{}');
  });

  it('sorts enumerable properties on fake boxed primitive prototype objects', () => {
    const value = Object.create(Number.prototype);
    value.b = 2;
    value.a = 1;

    expect(stableJsonStringify(value)).toBe('{"a":1,"b":2}');
  });

  it('ignores shadowed valueOf methods on boxed string and boolean values', () => {
    // eslint-disable-next-line no-new-wrappers
    const stringValue = new String('ab');
    stringValue.valueOf = () => 'cd';
    expect(stableJsonStringify(stringValue)).toBe('"ab"');

    // eslint-disable-next-line no-new-wrappers
    const booleanValue = new Boolean(false);
    booleanValue.valueOf = () => true;
    expect(stableJsonStringify(booleanValue)).toBe('false');
  });

  it('does not treat Symbol.toStringTag spoofing as a boxed primitive', () => {
    expect(
      stableJsonStringify({
        [Symbol.toStringTag]: 'String',
        a: 1,
        valueOf: () => 'spoof',
      }),
    ).toBe('{"a":1}');
  });

  it('throws on boxed BigInt values like JSON.stringify', () => {
    expect(() => stableJsonStringify(Object(1n))).toThrow();
    expect(() => stableJsonStringify({ value: Object(1n) })).toThrow();
  });

  it('preserves JSON array treatment for undefined values', () => {
    expect(stableJsonStringify([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('preserves JSON array treatment when an own map property shadows Array.prototype.map', () => {
    const value = [1, 2];
    Object.defineProperty(value, 'map', {
      configurable: true,
      value: 'not callable',
    });

    expect(stableJsonStringify(value)).toBe('[1,2]');
  });

  it('omits undefined object properties like JSON.stringify', () => {
    expect(stableJsonStringify({ b: undefined, a: 1 })).toBe('{"a":1}');
  });

  it('omits function and symbol object properties like JSON.stringify', () => {
    expect(
      stableJsonStringify({
        b: () => 'b',
        c: Symbol('c'),
        a: 1,
      }),
    ).toBe('{"a":1}');
  });

  it('serializes function and symbol array elements as null like JSON.stringify', () => {
    expect(stableJsonStringify([1, () => 2, Symbol('three'), 4])).toBe(
      '[1,null,null,4]',
    );
  });

  it('passes the empty string key to root toJSON values', () => {
    const keys: string[] = [];
    const value = {
      toJSON(key: string) {
        keys.push(key);
        return { b: 2, a: 1 };
      },
    };

    expect(stableJsonStringify(value)).toBe('{"a":1,"b":2}');
    expect(keys).toEqual(['']);
  });

  it('passes JSON.stringify-compatible keys to nested toJSON values', () => {
    const keys: string[] = [];
    const value = {
      child: {
        toJSON(key: string) {
          keys.push(key);
          return { d: 4, c: 3 };
        },
      },
      list: [
        {
          toJSON(key: string) {
            keys.push(key);
            return { y: 2, x: 1 };
          },
        },
      ],
    };

    expect(stableJsonStringify(value)).toBe(
      '{"child":{"c":3,"d":4},"list":[{"x":1,"y":2}]}',
    );
    expect(keys).toEqual(['child', '0']);
  });

  it('uses toJSON on nested function object properties before omitting unsupported values', () => {
    const keys: string[] = [];
    const f = () => 'ignored';
    f.toJSON = (key: string) => {
      keys.push(key);
      return { b: 2, a: 1 };
    };
    const value = {
      f,
    };

    expect(stableJsonStringify(value)).toBe('{"f":{"a":1,"b":2}}');
    expect(keys).toEqual(['f']);
  });

  it('uses toJSON on function array elements with array index keys', () => {
    const keys: string[] = [];
    const f = () => 'ignored';
    f.toJSON = (key: string) => {
      keys.push(key);
      return { b: 2, a: 1 };
    };

    expect(stableJsonStringify([f])).toBe('[{"a":1,"b":2}]');
    expect(keys).toEqual(['0']);
  });

  it('does not treat a toJSON self-return as circular by itself', () => {
    let calls = 0;
    const value = {
      b: 2,
      a: 1,
      toJSON() {
        calls += 1;
        if (calls > 1) {
          return { z: 9 };
        }
        return this;
      },
    };

    expect(stableJsonStringify(value)).toBe('{"a":1,"b":2}');
    expect(calls).toBe(1);
  });

  it('reads a toJSON getter once and calls the returned function with the original receiver', () => {
    let gets = 0;
    const receivers: unknown[] = [];
    const value = {
      b: 2,
      a: 1,
      get toJSON() {
        gets += 1;
        if (gets > 1) {
          return function secondToJson() {
            return { z: 9 };
          };
        }

        return function firstToJson(this: unknown) {
          receivers.push(this);
          return { b: 2, a: 1 };
        };
      },
    };

    expect(stableJsonStringify(value)).toBe('{"a":1,"b":2}');
    expect(gets).toBe(1);
    expect(receivers).toEqual([value]);
  });

  it('snapshots array length before serializing elements', () => {
    const value = [0];
    Object.defineProperty(value, '0', {
      configurable: true,
      enumerable: true,
      get() {
        value.push(2);
        return 1;
      },
    });

    expect(stableJsonStringify(value)).toBe('[1]');
  });

  it('throws on circular structures', () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;

    expect(() => stableJsonStringify(value)).toThrow(/circular/i);
  });

  it('throws on BigInt values like JSON.stringify', () => {
    expect(() => stableJsonStringify({ value: BigInt(1) })).toThrow();
  });
});
