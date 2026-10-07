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

    const meta = Reflect.getMetadata(IDEMPOTENT_METADATA_KEY, Controller.prototype.handler) as
      | IdempotentMetadata
      | undefined;

    expect(meta).toEqual({ enabled: true });
  });

  it('merges per-handler options into the metadata', () => {
    const keyResolver = () => 'command-123';
    const options = Object.freeze({
      ttl: 3600,
      processingTtl: 15,
      required: false,
      fingerprint: false,
      maxKeyLength: 128,
      keyResolver,
    });
    class Controller {
      @Idempotent(options)
      handler() {
        return 'ok';
      }
    }

    const meta = Reflect.getMetadata(IDEMPOTENT_METADATA_KEY, Controller.prototype.handler) as
      | IdempotentMetadata
      | undefined;

    expect(meta).toEqual({
      enabled: true,
      ttl: 3600,
      processingTtl: 15,
      required: false,
      fingerprint: false,
      maxKeyLength: 128,
      keyResolver,
    });
    expect(meta).not.toBe(options);
  });

  it('keeps route options independent between decorated handlers', () => {
    class Controller {
      @Idempotent({ ttl: 60 })
      first() {
        return 'first';
      }
      @Idempotent({ ttl: 600, required: false })
      second() {
        return 'second';
      }
    }
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA_KEY, Controller.prototype.first)).toEqual({
      enabled: true,
      ttl: 60,
    });
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA_KEY, Controller.prototype.second)).toEqual({
      enabled: true,
      ttl: 600,
      required: false,
    });
  });

  it('returns no metadata for handlers without the decorator', () => {
    class Controller {
      handler() {
        return 'ok';
      }
    }

    const meta = Reflect.getMetadata(IDEMPOTENT_METADATA_KEY, Controller.prototype.handler);

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
