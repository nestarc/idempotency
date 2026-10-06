/**
 * S1 regression: caching raw Nest handler values could reveal excluded class
 * fields, serialize StreamableFile internals, and leave manual-response retries
 * open. The HTTP contract caches final serialized JSON, preserves the processing
 * lease for unsafe runtime values, and rejects unsupported response modes before
 * executing the handler. Real sockets also exercise Nest's SSE error-and-close
 * path, which Fastify's injection socket cannot faithfully reproduce.
 */
import 'reflect-metadata';
import {
  ClassSerializerInterceptor,
  Controller,
  HttpCode,
  Next,
  Post,
  Redirect,
  Render,
  Res,
  SerializeOptions,
  Sse,
  StreamableFile,
  UseInterceptors,
  type INestApplication,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Exclude, Transform } from 'class-transformer';
import { EMPTY, of } from 'rxjs';
import request from 'supertest';

import { Idempotent } from '../../src/idempotency.decorator';
import { IdempotencyInterceptor } from '../../src/idempotency.interceptor';
import { IdempotencyModule } from '../../src/idempotency.module';
import { MemoryStorage } from '../../src/storage/memory.storage';

class Receipt {
  id = 'receipt-1';

  @Transform(({ value }: { value: string }) => `${value}!`, {
    toPlainOnly: true,
  })
  label = 'receipt';

  @Exclude()
  secret = 'must-not-appear-in-http';
}

interface Reply {
  setHeader?: (name: string, value: string) => unknown;
  header?: (name: string, value: string) => unknown;
  send: (body: unknown) => unknown;
}

describe.each(['Express', 'Fastify'] as const)('response replay over real HTTP (%s)', (adapter) => {
  let app: INestApplication;
  let storage: MemoryStorage;
  let calls: string[] = [];

  function setReceiptHeaders(reply: Reply) {
    const setHeader = reply.setHeader ?? reply.header;
    setHeader!.call(reply, 'Location', '/receipts/receipt-1');
    setHeader!.call(reply, 'X-Receipt-Version', '1');
  }

  @Controller('responses')
  @UseInterceptors(IdempotencyInterceptor, ClassSerializerInterceptor)
  class ResponsesController {
    @Post('serialized')
    @HttpCode(202)
    @Idempotent()
    async serialized(@Res({ passthrough: true }) reply: Reply) {
      calls.push('serialized');
      setReceiptHeaders(reply);
      return new Receipt();
    }

    @Post('typed')
    @HttpCode(202)
    @Idempotent()
    @SerializeOptions({ type: Receipt })
    typed(@Res({ passthrough: true }) reply: Reply) {
      calls.push('typed');
      setReceiptHeaders(reply);
      return {
        id: 'receipt-1',
        label: 'receipt',
        secret: 'must-not-appear-in-http',
      };
    }

    @Post('file')
    @Idempotent()
    file() {
      calls.push('file');
      return new StreamableFile(Buffer.from('hello'));
    }

    @Post('multiple')
    @Idempotent()
    multiple() {
      calls.push('multiple');
      return of({ phase: 'intermediate' }, { phase: 'final' });
    }

    @Post('empty')
    @HttpCode(204)
    @Idempotent()
    empty() {
      calls.push('empty');
      return EMPTY;
    }
  }

  @Controller('global-order')
  class GloballySerializedController {
    @Post()
    @Idempotent()
    @UseInterceptors(IdempotencyInterceptor)
    create() {
      calls.push('global-order');
      return new Receipt();
    }
  }

  @Controller('wrong-order')
  @UseInterceptors(ClassSerializerInterceptor, IdempotencyInterceptor)
  class WrongOrderController {
    @Post('instance')
    @Idempotent()
    instance() {
      calls.push('instance');
      return new Receipt();
    }

    @Post('nested')
    @Idempotent()
    nested() {
      calls.push('nested');
      return { receipt: new Receipt() };
    }
  }

  @Controller('unsupported')
  @UseInterceptors(IdempotencyInterceptor)
  class UnsupportedController {
    @Post('sent-passthrough')
    @HttpCode(200)
    @Idempotent()
    sentPassthrough(@Res({ passthrough: true }) reply: Reply) {
      calls.push('sent-passthrough');
      reply.send({ sent: true });
    }

    @Post('manual')
    @Idempotent()
    manual(@Res() reply: Reply) {
      calls.push('manual');
      reply.send({ unexpected: true });
    }

    @Post('next')
    @Idempotent()
    next(@Next() next: () => void) {
      calls.push('next');
      next();
    }

    @Post('render')
    @Idempotent()
    @Render('unused-template')
    render() {
      calls.push('render');
      return { unexpected: true };
    }

    @Post('redirect')
    @Idempotent()
    @Redirect('/unexpected-target', 302)
    redirect() {
      calls.push('redirect');
    }

    @Sse('events')
    @Idempotent()
    events() {
      calls.push('events');
      return of({ data: 'unexpected-handler-event' });
    }
  }

  beforeAll(async () => {
    storage = new MemoryStorage();
    const moduleRef = await Test.createTestingModule({
      imports: [IdempotencyModule.forRoot({ storage, processingTtl: 60 })],
      controllers: [ResponsesController, WrongOrderController, UnsupportedController],
    }).compile();

    app =
      adapter === 'Fastify'
        ? moduleRef.createNestApplication(new FastifyAdapter(), {
            logger: false,
          })
        : moduleRef.createNestApplication({ logger: false });
    await app.init();
    if (adapter === 'Fastify') {
      await app.getHttpAdapter().getInstance().ready();
    }
  });

  beforeEach(async () => {
    calls = [];
    await storage.onModuleDestroy();
  });

  afterAll(async () => {
    await app?.close();
  });

  function post(path: string) {
    return request(app.getHttpServer())
      .post(path)
      .set('Idempotency-Key', 'same-operation')
      .send({ amount: 100 })
      .timeout({ response: 1500, deadline: 2500 });
  }

  it.each(['serialized', 'typed'])(
    'replays %s after serialization without exposing or transforming fields again',
    async (route) => {
      const first = await post(`/responses/${route}`);
      const replay = await post(`/responses/${route}`);

      for (const response of [first, replay]) {
        expect(response.status).toBe(202);
        expect(response.body).toEqual({
          id: 'receipt-1',
          label: 'receipt!',
        });
        expect(response.headers.location).toBe('/receipts/receipt-1');
        expect(response.headers['x-receipt-version']).toBe('1');
      }
      expect(replay.headers['idempotency-status']).toBe('replayed');
      expect(calls).toEqual([route]);
    },
  );

  it.each(['instance', 'nested'])(
    'does not replay %s values captured before an outer serializer',
    async (route) => {
      const first = await post(`/wrong-order/${route}`);
      const retry = await post(`/wrong-order/${route}`);

      expect(first.status).toBe(201);
      expect(JSON.stringify(first.body)).not.toContain('secret');
      expect(JSON.stringify(first.body)).not.toContain('must-not-appear-in-http');
      expect(first.headers['idempotency-status']).toBe('bypassed');
      expect(retry.status).toBe(409);
      expect(JSON.stringify(retry.body)).not.toContain('must-not-appear-in-http');
      expect(calls).toEqual([route]);
    },
  );

  it('protects method idempotency under a global outer ClassSerializerInterceptor', async () => {
    const globalStorage = new MemoryStorage();
    const moduleRef = await Test.createTestingModule({
      imports: [IdempotencyModule.forRoot({ storage: globalStorage, processingTtl: 60 })],
      controllers: [GloballySerializedController],
      providers: [{ provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor }],
    }).compile();
    const globalApp =
      adapter === 'Fastify'
        ? moduleRef.createNestApplication(new FastifyAdapter(), {
            logger: false,
          })
        : moduleRef.createNestApplication({ logger: false });

    try {
      await globalApp.init();
      if (adapter === 'Fastify') {
        await globalApp.getHttpAdapter().getInstance().ready();
      }
      const send = () =>
        request(globalApp.getHttpServer())
          .post('/global-order')
          .set('Idempotency-Key', 'same-operation')
          .send({ amount: 100 })
          .timeout({ response: 1500, deadline: 2500 });
      const first = await send();
      const retry = await send();

      expect(first.status).toBe(201);
      expect(first.body).toEqual({ id: 'receipt-1', label: 'receipt!' });
      expect(first.headers['idempotency-status']).toBe('bypassed');
      expect(retry.status).toBe(409);
      expect(JSON.stringify(retry.body)).not.toContain('must-not-appear-in-http');
      expect(calls).toEqual(['global-order']);
    } finally {
      await globalApp.close();
    }
  });

  it('sends and replays only the final value of an ordinary HTTP Observable', async () => {
    const first = await post('/responses/multiple');
    const replay = await post('/responses/multiple');

    expect(first.status).toBe(201);
    expect(first.body).toEqual({ phase: 'final' });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotency-status']).toBe('replayed');
    expect(calls).toEqual(['multiple']);
  });

  it('completes and replays an empty HTTP Observable with its 204 status', async () => {
    const first = await post('/responses/empty');
    const replay = await post('/responses/empty');

    expect(first.status).toBe(204);
    expect(first.text).toBe('');
    expect(replay.status).toBe(204);
    expect(replay.text).toBe('');
    expect(replay.headers['idempotency-status']).toBe('replayed');
    expect(calls).toEqual(['empty']);
  });

  it('sends StreamableFile once and retains the processing lease on retry', async () => {
    const first = await post('/responses/file');
    const retry = await post('/responses/file');

    expect(first.status).toBe(201);
    expect(first.headers['content-type']).toBe('application/octet-stream');
    expect(first.body).toEqual(Buffer.from('hello'));
    expect(first.headers['idempotency-status']).toBe('bypassed');
    expect(retry.status).toBe(409);
    expect(calls).toEqual(['file']);
  });

  it('retains the lease when passthrough code has already sent its response', async () => {
    const first = await post('/unsupported/sent-passthrough');
    const retry = await post('/unsupported/sent-passthrough');

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ sent: true });
    expect(retry.status).toBe(409);
    expect(calls).toEqual(['sent-passthrough']);
  });

  it.each(['manual', 'next', 'render', 'redirect'])(
    'rejects %s configuration before handler or storage access on every attempt',
    async (route) => {
      const get = jest.spyOn(storage, 'get');
      const create = jest.spyOn(storage, 'create');

      const first = await post(`/unsupported/${route}`);
      const retry = await post(`/unsupported/${route}`);

      expect(first.status).toBe(500);
      expect(retry.status).toBe(500);
      expect(calls).toEqual([]);
      expect(get).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('closes unsupported SSE with an error event before handler or storage access', async () => {
    const get = jest.spyOn(storage, 'get');
    const create = jest.spyOn(storage, 'create');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request(app.getHttpServer())
        .get('/unsupported/events')
        .set('Idempotency-Key', 'same-operation')
        .timeout({ response: 1500, deadline: 2500 });

      // Nest opens the SSE stream before subscribing to interceptors.
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.text).toContain('event: error');
      expect(response.text).not.toContain('unexpected-handler-event');
    }
    expect(calls).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
