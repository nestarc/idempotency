import 'reflect-metadata';
import { Idempotent } from '../src/idempotency.decorator';
import { IDEMPOTENT_METADATA_KEY } from '../src/idempotency.constants';
import type { IdempotentMetadata } from '../src/interfaces/idempotency-options.interface';

describe('@Idempotent decorator', () => {
  it('attaches enabled metadata when called with no arguments', () => {
    class Controller {
      @Idempotent()
      handler() {
        return 'ok';
      }
    }

    const meta = Reflect.getMetadata(
      IDEMPOTENT_METADATA_KEY,
      Controller.prototype.handler,
    ) as IdempotentMetadata | undefined;

    expect(meta).toEqual({ enabled: true });
  });

  it('merges per-handler options into the metadata', () => {
    class Controller {
      @Idempotent({ ttl: 3600, required: false, fingerprint: false })
      handler() {
        return 'ok';
      }
    }

    const meta = Reflect.getMetadata(
      IDEMPOTENT_METADATA_KEY,
      Controller.prototype.handler,
    ) as IdempotentMetadata | undefined;

    expect(meta).toEqual({
      enabled: true,
      ttl: 3600,
      required: false,
      fingerprint: false,
    });
  });

  it('returns no metadata for handlers without the decorator', () => {
    class Controller {
      handler() {
        return 'ok';
      }
    }

    const meta = Reflect.getMetadata(
      IDEMPOTENT_METADATA_KEY,
      Controller.prototype.handler,
    );

    expect(meta).toBeUndefined();
  });

  it('does not allow user-supplied options to overwrite the enabled flag', () => {
    class Controller {
      // Cast through unknown to test the runtime guarantee even when a
      // determined caller bypasses the type system.
      @Idempotent({ enabled: false } as unknown as Record<string, never>)
      handler() {
        return 'ok';
      }
    }

    const meta = Reflect.getMetadata(
      IDEMPOTENT_METADATA_KEY,
      Controller.prototype.handler,
    ) as IdempotentMetadata;

    expect(meta.enabled).toBe(true);
  });
});
