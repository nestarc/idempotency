import { types } from 'util';

const REPLAY_BODY_PREFIX = '@nestarc/idempotency:replay:v1:';

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

export type DecodedReplayBody = { replayable: true; value: unknown } | { replayable: false };

const unsupported = (): TypeError =>
  new TypeError('Idempotency replay supports only plain JSON values');

/**
 * Snapshot data properties without evaluating getters, toJSON hooks or proxies.
 * Only ancestors are tracked: sharing a child object is valid, cycles are not.
 */
const snapshotJson = (value: unknown, ancestors: Set<object>): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw unsupported();
    return value;
  }
  if (typeof value !== 'object' || types.isProxy(value)) throw unsupported();

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
  ) {
    throw unsupported();
  }
  for (let current = value; current !== null; current = Object.getPrototypeOf(current)) {
    if (Object.getOwnPropertyDescriptor(current, 'toJSON')) throw unsupported();
  }
  if (ancestors.has(value)) throw unsupported();

  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') throw unsupported();
    const descriptor = descriptors[key];
    if (!('value' in descriptor)) throw unsupported();
  }

  ancestors.add(value);
  try {
    if (isArray) {
      const length = descriptors.length.value as number;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) continue;
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
          throw unsupported();
        }
      }
      const snapshot: JsonValue[] = [];
      // Avoid inherited serialization hooks even if prototypes change later.
      Object.setPrototypeOf(snapshot, null);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) throw unsupported(); // Sparse arrays are not JSON data.
        snapshot[index] = snapshotJson(descriptor.value, ancestors);
      }
      return snapshot;
    }

    const snapshot = Object.create(null) as JsonObject;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor.enumerable) {
        snapshot[key] = snapshotJson(descriptor.value, ancestors);
      }
    }
    return snapshot;
  } finally {
    ancestors.delete(value);
  }
};

/**
 * Versioned opaque storage string. Its non-JSON prefix cannot be confused with
 * a legacy JSON.stringify response, including one that resembles our envelope.
 * Root undefined has an explicit marker; unsupported values throw TypeError.
 */
export const encodeReplayBody = (value: unknown): string => {
  const envelope = Object.create(null) as {
    kind: 'undefined' | 'json';
    value?: JsonValue;
  };
  envelope.kind = value === undefined ? 'undefined' : 'json';
  if (value !== undefined) envelope.value = snapshotJson(value, new Set());
  return REPLAY_BODY_PREFIX + JSON.stringify(envelope);
};

/**
 * Fail closed for legacy, missing, unsupported-version or corrupt records.
 * Decoding never upgrades an old record or evaluates response serialization hooks.
 */
export const decodeReplayBody = (serialized?: string): DecodedReplayBody => {
  if (typeof serialized !== 'string' || !serialized.startsWith(REPLAY_BODY_PREFIX)) {
    return { replayable: false };
  }
  try {
    const envelope: unknown = JSON.parse(serialized.slice(REPLAY_BODY_PREFIX.length));
    if (
      envelope === null ||
      typeof envelope !== 'object' ||
      Array.isArray(envelope) ||
      !Object.prototype.hasOwnProperty.call(envelope, 'kind')
    ) {
      return { replayable: false };
    }
    const fields = Object.keys(envelope);
    const record = envelope as { kind?: unknown; value?: unknown };
    if (record.kind === 'undefined' && fields.length === 1) {
      return { replayable: true, value: undefined };
    }
    if (
      record.kind === 'json' &&
      fields.length === 2 &&
      Object.prototype.hasOwnProperty.call(record, 'value')
    ) {
      snapshotJson(record.value, new Set());
      return { replayable: true, value: record.value };
    }
  } catch {
    // Malformed or unsafe stored content is not an instruction to replay it.
  }
  return { replayable: false };
};
