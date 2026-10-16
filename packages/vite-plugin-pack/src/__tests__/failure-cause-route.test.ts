import { describe, expect, it } from 'vitest';
import {
  createTransportRouteHandler,
  type TransportRouteContext,
} from '../dev/transport-routes.js';

async function responseFor(cause: unknown) {
  const handler = createTransportRouteHandler({
    startupReady: Promise.resolve(),
    devSession: {
      runtimeScope: () => ({ scopeId: 'game', generation: 1 }),
      state: () => ({
        status: 'failed',
        error: {
          code: 'produce-failed',
          expected: 'valid product',
          hint: 'repair source',
          detail: { stage: 'produce' },
          cause,
        },
      }),
    },
  } as unknown as TransportRouteContext);
  let body = '';
  const response = {
    statusCode: 200,
    setHeader() {},
    end(value: string | Uint8Array) {
      body = String(value);
    },
  };
  await handler({ url: '/__pack/scopes/game/1/catalog.json' }, response, () => {
    throw new Error('route not handled');
  });
  return { status: response.statusCode, body: JSON.parse(body) };
}

describe('catalog failure cause', () => {
  it('preserves catalog diagnostic arrays and bounds cyclic and oversized arrays', async () => {
    const diagnostic = {
      code: 'catalog-scan-failed',
      path: 'assets/broken.pack.json',
      message: 'invalid source',
      actual: 'malformed JSON',
      credentials: 'must not copy',
    };
    const cycle: unknown[] = [diagnostic];
    cycle.push(cycle);
    const result = await responseFor(cycle);
    expect(result.status).toBe(500);
    expect(result.body.cause).toEqual([
      {
        code: diagnostic.code,
        path: diagnostic.path,
        message: diagnostic.message,
        actual: diagnostic.actual,
      },
    ]);
    const large = await responseFor(
      Array.from({ length: 1000 }, () => ({ message: 'x'.repeat(3000) })),
    );
    expect(large.body.cause.length).toBeLessThanOrEqual(40);
    expect(large.body.cause[0].message).toHaveLength(2000);
  });

  it('preserves a nested Error message through the real JSON response', async () => {
    const result = await responseFor(
      Object.assign(new Error('scene source failed'), {
        code: 'scriptable-pack-build-failed',
        detail: { unusedDeclaredGuids: ['asset-guid'] },
        cause: new Error('missing shader compiler'),
      }),
    );
    expect(result.status).toBe(500);
    expect(result.body.cause).toMatchObject({
      code: 'scriptable-pack-build-failed',
      message: 'scene source failed',
      detail: { unusedDeclaredGuids: ['asset-guid'] },
      cause: { message: 'missing shader compiler' },
    });
    expect(JSON.stringify(result.body)).not.toContain('stack');
  });

  it('bounds cyclic causes and omits arbitrary provider objects', async () => {
    const cause: Record<string, unknown> = { message: 'failure', credentials: 'must not copy' };
    cause.cause = cause;
    const result = await responseFor(cause);
    expect(result.body.cause.message).toBe('failure');
    expect(JSON.stringify(result.body)).not.toContain('must not copy');
    expect(JSON.stringify(result.body).length).toBeLessThan(2000);
  });
});
