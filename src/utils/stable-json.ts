export function stableJsonStringify(value: unknown): string | undefined {
  return stringifyStableJsonValue(value, '', new WeakSet());
}

function stringifyStableJsonValue(
  value: unknown,
  key: string,
  seen: WeakSet<object>,
  skipToJson = false,
): string | undefined {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'object' || typeof value === 'function') {
    const withToJson = value as { toJSON?: (key: string) => unknown };
    const toJson = withToJson.toJSON;
    if (!skipToJson && typeof toJson === 'function') {
      return stringifyStableJsonValue(toJson.call(value, key), key, seen, true);
    }
  }

  if (typeof value !== 'object') {
    return skipToJson && typeof value === 'function'
      ? undefined
      : JSON.stringify(value);
  }

  const boxedPrimitiveValue = getBoxedPrimitiveValue(value);
  if (boxedPrimitiveValue !== undefined) {
    return JSON.stringify(boxedPrimitiveValue);
  }

  if (seen.has(value)) {
    throw new TypeError('Converting circular structure to JSON');
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      const length = value.length;
      for (let index = 0; index < length; index += 1) {
        items.push(
          stringifyStableJsonValue(value[index], String(index), seen) ?? 'null',
        );
      }
      return `[${items.join(',')}]`;
    }

    const entries: string[] = [];
    for (const objectKey of Object.keys(value).sort()) {
      const serializedValue = stringifyStableJsonValue(
        (value as Record<string, unknown>)[objectKey],
        objectKey,
        seen,
      );
      if (serializedValue !== undefined) {
        entries.push(`${JSON.stringify(objectKey)}:${serializedValue}`);
      }
    }
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function getBoxedPrimitiveValue(
  value: object,
): number | string | boolean | bigint | undefined {
  const prototype = Object.getPrototypeOf(value);
  try {
    if (prototype === Number.prototype) {
      return Number.prototype.valueOf.call(value);
    }
    if (prototype === String.prototype) {
      return String.prototype.valueOf.call(value);
    }
    if (prototype === Boolean.prototype) {
      return Boolean.prototype.valueOf.call(value);
    }
    if (prototype === BigInt.prototype) {
      return BigInt.prototype.valueOf.call(value);
    }
  } catch {
    return undefined;
  }
  return undefined;
}
