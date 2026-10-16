import { Readable } from 'node:stream';
import { apply } from '@forgeax/engine/dsh';
import {
  FEDERATION_PROTOCOL_VERSION,
  FEDERATION_ROUTE_PREFIX,
  isEnginePreviewRequest,
  isEnginePreviewStatus,
  isFederationStatus,
} from '@forgeax/engine/dsh/protocol';
import { defineFeature } from '../../lab/feature';

type Handler = (request: unknown, response: unknown) => void | Promise<void>;

interface Reply {
  status: number;
  body: unknown;
}

export default defineFeature({
  title: 'DSH federation bridge (host half)',
  catalog: 'DSH federation bridge',
  kind: 'headless',
  summary:
    'The DSH-native host plugin registers versioned POD routes (status, lease, activity, community, engine control) on the DSH web server and keeps an embedded Engine World ticking; disposing its Fiber unregisters every route. Driven here with a fake DSH context in Node.',
  expect:
    'All checks pass: status is a valid FederationStatus, leases count up and down, missing capabilities answer 404 codes, control toggles embedded state, guards reject off-protocol POD, and disposal removes all routes.',
  async run(checks) {
    const routes = new Map<string, Handler>();
    const disposers: (() => void | Promise<void>)[] = [];
    const services = new Map<string, unknown>();
    const ctx = {
      webServer: {
        register(route: { path: string; handler: Handler }) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
      logger: { warn() {} },
      effect(callback: () => void | (() => void | Promise<void>)) {
        const dispose = callback();
        if (typeof dispose === 'function') disposers.push(dispose);
      },
      get: (name: string) => services.get(name),
    };
    await apply(ctx as never, { identity: 'fl-dsh' });
    const call = async (
      path: string,
      method = 'GET',
      body?: unknown,
      query = '',
    ): Promise<Reply> => {
      const handler = routes.get(`${FEDERATION_ROUTE_PREFIX}${path}`);
      if (handler === undefined) return { status: -1, body: null };
      const request = Object.assign(
        Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
        {
          method,
          url: `${FEDERATION_ROUTE_PREFIX}${path}${query}`,
        },
      );
      const reply: Reply = { status: 0, body: null };
      await handler(request, {
        writeHead(status: number) {
          reply.status = status;
        },
        end(text: string) {
          reply.body = JSON.parse(text);
        },
      });
      return reply;
    };
    checks.equal(
      'route set',
      [...routes.keys()].map((p) => p.slice(FEDERATION_ROUTE_PREFIX.length)).sort(),
      ['/activity', '/community', '/engine/control', '/lease', '/status'],
    );
    const status = await call('/status');
    checks.ok(
      'status is a FederationStatus',
      status.status === 200 && isFederationStatus(status.body),
      JSON.stringify(status.body),
    );
    const s = status.body as { identity: string; protocol: number; engine: { binding: string } };
    checks.equal('identity from config', s.identity, 'fl-dsh');
    checks.equal('protocol version', s.protocol, FEDERATION_PROTOCOL_VERSION);
    checks.equal('no engineEndpoint -> embedded engine', s.engine.binding, 'embedded');
    const lease = await call('/lease', 'POST');
    const leaseId = (lease.body as { leaseId?: string }).leaseId ?? '';
    checks.ok('POST /lease -> 201 leaseId', lease.status === 201 && leaseId.length > 0);
    checks.equal('lease counted', ((await call('/status')).body as { leases: number }).leases, 1);
    await call('/lease', 'DELETE', undefined, `?leaseId=${leaseId}`);
    checks.equal('lease released', ((await call('/status')).body as { leases: number }).leases, 0);
    checks.equal('GET /lease -> 405', (await call('/lease', 'GET')).status, 405);
    const activity = await call('/activity', 'POST', { input: 'hi', sessionId: 's' });
    checks.equal(
      'activity without capability -> 404 code',
      (activity.body as { code?: string }).code,
      'federation-intelligence-capability-missing',
    );
    services.set('forgeaxIntelligenceCapability', {
      run: (input: string) => ({ output: `echo:${input}` }),
    });
    checks.equal(
      'activity with capability',
      (await call('/activity', 'POST', { input: 'hi', sessionId: 's' })).body,
      { output: 'echo:hi' },
    );
    checks.equal(
      'invalid activity -> 400',
      (await call('/activity', 'POST', { input: 1 })).status,
      400,
    );
    checks.equal('community missing -> 404', (await call('/community')).status, 404);
    const before = ((await call('/status')).body as { engine: { state: number } }).engine.state;
    const toggled = await call('/engine/control', 'POST');
    checks.equal(
      'control toggles embedded state',
      (toggled.body as { state: number }).state,
      before === 0 ? 1 : 0,
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    checks.ok(
      'embedded World ticks',
      ((await call('/status')).body as { engine: { tick: number } }).engine.tick > 0,
    );
    checks.ok(
      'preview poll guard',
      isEnginePreviewRequest({ protocol: 1, kind: 'forgeax-engine-poll' }),
    );
    checks.ok(
      'guard rejects other protocol',
      !isEnginePreviewRequest({ protocol: 2, kind: 'forgeax-engine-poll' }),
    );
    checks.ok(
      'guard rejects unknown control',
      !isEnginePreviewRequest({ protocol: 1, kind: 'forgeax-engine-control', action: 'reload' }),
    );
    checks.ok(
      'status guard rejects missing tick',
      !isEnginePreviewStatus({
        protocol: 1,
        kind: 'forgeax-engine-status',
        binding: 'external',
        ready: true,
        frameId: 1,
        state: 0,
      }),
    );
    checks.ok(
      'federation guard rejects negative leases',
      !isFederationStatus({ ...(status.body as object), leases: -1 }),
    );
    for (const dispose of disposers.reverse()) await dispose();
    checks.equal('disposal unregisters every route', routes.size, 0);
  },
});
