import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createTransportRouteHandler,
  type TransportRouteContext,
} from '../dev/transport-routes.js';

describe('startup readiness route boundary', () => {
  it('terminates a catalog request when startup readiness rejects', async () => {
    const failure = {
      code: 'produce-failed',
      expected: 'the producer to finish',
      hint: 'repair the producer and retry',
      detail: { stage: 'produce', subject: 'fixture' },
      cause: new Error('architecture.ts:27:8 invalid authored mesh'),
    } as const;
    const binding = createStandaloneRuntimeAssetBinding('startup-readiness-route');
    const context = {
      startupReady: Promise.reject(failure),
      state: {} as TransportRouteContext['state'],
      callbacks: {} as TransportRouteContext['callbacks'],
      devSession: {
        runtimeScope: () => binding,
        state: () => ({ status: 'failed' as const, error: failure }),
      } as TransportRouteContext['devSession'],
      scopedPackageUrl: (_binding, packageUrl) => packageUrl,
      scopedCatalogBody: () => JSON.stringify({ entries: [] }),
    } satisfies TransportRouteContext;
    const response = {
      statusCode: 200,
      body: '',
      setHeader() {},
      end(body: string) {
        this.body = body;
      },
    };

    await createTransportRouteHandler(context)(
      { url: binding.catalogUrl, method: 'GET' },
      response,
      () => {},
    );

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toMatchObject({
      error: 'produce-failed',
      detail: failure.detail,
      cause: { message: failure.cause.message },
    });
  });
});
