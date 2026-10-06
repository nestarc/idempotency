import { InternalServerErrorException, type ExecutionContext } from '@nestjs/common';
import {
  REDIRECT_METADATA,
  RENDER_METADATA,
  RESPONSE_PASSTHROUGH_METADATA,
  ROUTE_ARGS_METADATA,
  SSE_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';

/** Reject routes whose HTTP response is completed outside the return-value pipeline. */
export function assertReplayableResponseMode(context: ExecutionContext): void {
  const unsupported = (mode: string): never => {
    throw new InternalServerErrorException(
      `@Idempotent() does not support ${mode}; return a JSON response through Nest instead`,
    );
  };

  if (context.getType() !== 'http') {
    unsupported('non-HTTP handlers');
  }

  const handler = context.getHandler();
  if (Reflect.getMetadata(SSE_METADATA, handler)) unsupported('SSE');
  if (Reflect.getMetadata(RENDER_METADATA, handler) !== undefined) unsupported('@Render()');
  if (Reflect.getMetadata(REDIRECT_METADATA, handler) !== undefined) unsupported('@Redirect()');

  const controller = context.getClass();
  // Route argument metadata belongs to constructor + property name. The
  // function's name can differ from that property after wrapping or aliasing.
  const methods = new Set<string | symbol>();
  let prototype: object | null = controller.prototype as object;
  while (prototype && prototype !== Object.prototype) {
    for (const name of Reflect.ownKeys(prototype)) {
      if (Object.getOwnPropertyDescriptor(prototype, name)?.value === handler) {
        methods.add(name);
      }
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  if (!methods.size) methods.add(handler.name);

  for (const method of methods) {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) as
      | Record<string, unknown>
      | undefined;
    const manuallyHandled = Object.keys(args ?? {}).some((key) => {
      const type = key.split(':')[0];
      return type === String(RouteParamtypes.RESPONSE) || type === String(RouteParamtypes.NEXT);
    });
    const passthrough = Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, controller, method);
    if (manuallyHandled && !passthrough) unsupported('@Res() / @Next() without passthrough');
  }
}
