import {
  createStandaloneRuntimeAssetBinding,
  type RuntimeAssetBinding,
} from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DispatcherRequest } from '../dev/dispatcher.js';
import {
  createTransportRouteHandler,
  type TransportRouteContext,
} from '../dev/transport-routes.js';

const guid = '01900000-0000-7000-8000-aaaaaaaaaaaa';
const artifactUrl = `/__forgeax-ddc/${guid}/body.bin`;
const packUrl = `/__forgeax-ddc/${guid}.pack.json`;

function fixture() {
  let binding: RuntimeAssetBinding = {
    ...createStandaloneRuntimeAssetBinding('freshness'),
    status: 'ready',
    authority: 'authoritative',
  };
  let status = 'serving';
  let reads = 0;
  let afterRead: ((reads: number) => void) | undefined;
  const entry = { guid, packageUrl: packUrl, sourcePath: 'fixture.pack.json' };
  const bytes = new Uint8Array([1, 2, 3]);
  const freshness = vi.fn(async () => {});
  const ensureBody = vi.fn(async () => '{"accepted":true}');
  const materialize = vi.fn(async () => [entry]);
  const context = {
    startupReady: Promise.resolve(),
    state: {
      catalogProjection: { entries: [entry], declarations: new Map() },
      importedGuids: new Set(),
      metaPackBodies: new Map([[packUrl, '{"accepted":true}']]),
      devArtifactBodies: new Map([[artifactUrl, { bytes, mimeType: 'application/octet-stream' }]]),
    },
    callbacks: {
      ensureMetaPackBody: ensureBody,
      materializeAsset: materialize,
      rebuildAsset: materialize,
    },
    devSession: {
      runtimeScope() {
        const observed = binding;
        afterRead?.(++reads);
        return observed;
      },
      state: () => ({ status }),
    },
    freshnessBarrier: freshness,
    scopedPackageUrl: (_scope: RuntimeAssetBinding, url: string) => url,
    scopedCatalogBody: () => '{"entries":[]}',
  } as unknown as TransportRouteContext;
  const handler = createTransportRouteHandler(context);
  const request = async (
    suffix: string,
    method = 'GET',
    headers?: DispatcherRequest['headers'],
  ) => {
    let body: string | Uint8Array = '';
    const responseHeaders = new Map<string, string>([['Server-Timing', 'upstream;dur=1']]);
    const response = {
      statusCode: 200,
      setHeader(name: string, value: string) {
        responseHeaders.set(name, value);
      },
      getHeader(name: string) {
        return responseHeaders.get(name);
      },
      end(value: string | Uint8Array) {
        body = value;
      },
    };
    const next = vi.fn();
    await handler({ url: `/__pack/scopes/freshness/1${suffix}`, method, headers }, response, next);
    return { status: response.statusCode, body, next, headers: responseHeaders };
  };
  return {
    context,
    freshness,
    ensureBody,
    materialize,
    request,
    bytes,
    get binding() {
      return binding;
    },
    set binding(value: RuntimeAssetBinding) {
      binding = value;
    },
    set status(value: string) {
      status = value;
    },
    afterRead(callback: (reads: number) => void) {
      afterRead = callback;
    },
  };
}

describe('request-owned transport freshness', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps existing Server-Timing metrics and records the single source fence', async () => {
    vi.stubEnv('FORGEAX_WORKSPACE_TIMING', '1');
    const response = await fixture().request(`/asset${artifactUrl}`);
    expect(response.status).toBe(200);
    const timing = response.headers.get('Server-Timing') ?? '';
    expect(timing).toContain('upstream;dur=1');
    expect([...timing.matchAll(/forgeax-freshness;dur=/g)]).toHaveLength(1);
  });
  it.each([
    ['/catalog.json', 'GET'],
    [`/asset${artifactUrl}`, 'GET'],
    [`/asset${artifactUrl}`, 'HEAD'],
    [`/asset${packUrl}`, 'GET'],
    [`/asset/__pack/lookup/${guid}`, 'GET'],
    [`/import/${guid}`, 'POST'],
  ])('takes one fresh source fence for %s (%s)', async (suffix, method) => {
    const f = fixture();
    const response = await f.request(suffix, method);
    expect(response.status).toBe(200);
    expect(response.next).not.toHaveBeenCalled();
    expect(f.freshness).toHaveBeenCalledTimes(1);
  });

  it('keeps a fresh fence for every separate request, including concurrent readers', async () => {
    const f = fixture();
    const responses = await Promise.all(
      Array.from({ length: 32 }, () => f.request(`/asset${artifactUrl}`)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(f.freshness).toHaveBeenCalledTimes(32);
  });

  it('serves the bytes accepted by the fresh fence', async () => {
    const f = fixture();
    const current = new Uint8Array([4, 5, 6]);
    f.freshness.mockImplementation(async () => {
      f.context.state.devArtifactBodies.set(artifactUrl, {
        bytes: current,
        mimeType: 'application/octet-stream',
      });
    });
    expect((await f.request(`/asset${artifactUrl}`)).body).toEqual(current);
  });

  it.each([
    { generation: 2 },
    { scopeId: 'replacement-with-the-same-generation' },
  ])('rejects a binding replaced during the source fence: %j', async (replacement) => {
    const f = fixture();
    f.freshness.mockImplementation(async () => {
      f.binding = { ...f.binding, ...replacement };
    });
    const response = await f.request(`/asset${artifactUrl}`);
    expect(response.status).toBe(410);
    expect(JSON.parse(String(response.body)).error).toBe('runtime-scope-generation-expired');
  });

  it('rejects a rebind queued between the fresh scope resolution and resource dispatch', async () => {
    const f = fixture();
    f.afterRead((reads) => {
      if (reads === 2)
        queueMicrotask(() => {
          f.binding = { ...f.binding, generation: 2 };
        });
    });
    const response = await f.request(`/asset${artifactUrl}`);
    expect(response.status).toBe(410);
    expect(f.ensureBody).not.toHaveBeenCalled();
  });

  it('keeps watcher failure closed without invoking a producer', async () => {
    const f = fixture();
    f.freshness.mockRejectedValue(new Error('watcher failed'));
    const response = await f.request(`/asset${packUrl}`);
    expect(response.status).toBe(503);
    expect(JSON.parse(String(response.body)).error).toBe('watch-failed');
    expect(f.ensureBody).not.toHaveBeenCalled();
  });

  it('does not serve a session closed while its source fence was pending', async () => {
    const f = fixture();
    f.freshness.mockImplementation(async () => {
      f.status = 'closed';
    });
    expect((await f.request(`/asset${artifactUrl}`)).status).toBe(410);
  });

  it.each([
    'transitioning',
    'unavailable',
  ] as const)('keeps %s scopes unavailable', async (status) => {
    const f = fixture();
    f.freshness.mockImplementation(async () => {
      f.binding = { ...f.binding, status };
    });
    expect((await f.request(`/asset${artifactUrl}`)).status).toBe(503);
  });

  it('retains accepted bytes in degraded scopes and fences new production', async () => {
    const f = fixture();
    f.binding = { ...f.binding, status: 'degraded', authority: 'degraded' };
    expect((await f.request(`/asset${artifactUrl}`)).body).toEqual(f.bytes);
    expect((await f.request(`/import/${guid}`, 'POST')).status).toBe(409);
    expect(f.materialize).not.toHaveBeenCalled();
    expect(
      (await f.request(`/import/${guid}`, 'POST', { 'x-forgeax-import-mode': 'rebuild' })).status,
    ).toBe(200);
  });
});
