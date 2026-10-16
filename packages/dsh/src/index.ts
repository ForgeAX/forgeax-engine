import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createWorldContext, Update, World } from '@forgeax/engine-ecs';
import type { Context } from '@forgeax/engine-plugin';

import {
  FEDERATION_PROTOCOL_VERSION,
  FEDERATION_ROUTE_PREFIX,
  type FederationActivityResult,
  type FederationCommunityCapability,
  type FederationStatus,
} from './protocol';

interface WebRoute {
  readonly kind: 'exact' | 'prefix';
  readonly path: string;
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
}

interface WebServerService {
  register(route: WebRoute): () => void;
}

interface DshHostContext {
  readonly webServer: WebServerService;
  readonly logger: { warn(error: unknown): void };
  effect(callback: () => void | (() => void | Promise<void>), label?: string): void;
  get(name: string): unknown;
}

interface CommunityProbeService {
  inspect(): FederationCommunityCapability | Promise<FederationCommunityCapability>;
}

interface IntelligenceCapabilityService {
  run(
    input: string,
    sessionId: string,
  ): FederationActivityResult | Promise<FederationActivityResult>;
}

export interface Config {
  readonly engineEndpoint?: string;
  readonly identity?: string;
}

export const inject = ['webServer'];

/** DSH-native Host half. DSH's Loader mounts this ordinary plugin from the package patch. */
export async function apply(ctx: DshHostContext, config: Config = {}): Promise<void> {
  const identity = config.identity ?? `dsh-${randomUUID()}`;
  const leases = new Set<string>();
  let tick = 0;
  let state = 0;
  let embeddedContext: Context | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const disposers: Array<() => void> = [];
  let disposed = false;

  ctx.effect(
    () => async () => {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.reverse()) dispose();
      leases.clear();
      if (timer !== undefined) clearInterval(timer);
      await embeddedContext?.fiber.dispose();
    },
    'forgeax-federation: routes and embedded engine',
  );

  if (config.engineEndpoint === undefined) {
    const world = new World();
    embeddedContext = await createWorldContext(world);
    world
      .addSystem(Update, {
        name: 'forgeax-federation-headless-tick',
        queries: [],
        fn: () => {
          tick += 1;
        },
      })
      .unwrap();
    timer = setInterval(() => {
      const result = world.update(1 / 30);
      if (!result.ok) ctx.logger.warn(result.error);
    }, 1000 / 30);
  }

  const status = (): FederationStatus => ({
    protocol: FEDERATION_PROTOCOL_VERSION,
    identity,
    ready: true,
    realm: 'dsh',
    capabilities: ['lease', 'community-probe', 'engine-projection'],
    leases: leases.size,
    engine:
      config.engineEndpoint === undefined
        ? { binding: 'embedded', ready: true, frameId: tick, tick, state }
        : { binding: 'external', endpoint: config.engineEndpoint, ready: true },
  });

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${FEDERATION_ROUTE_PREFIX}/status`,
      handler(_request, response) {
        writeJson(response, 200, status());
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${FEDERATION_ROUTE_PREFIX}/activity`,
      async handler(request, response) {
        if (request.method !== 'POST') {
          writeJson(response, 405, { code: 'federation-method-not-allowed' });
          return;
        }
        const candidate = ctx.get('forgeaxIntelligenceCapability') as
          | IntelligenceCapabilityService
          | undefined;
        if (candidate === undefined || typeof candidate.run !== 'function') {
          writeJson(response, 404, { code: 'federation-intelligence-capability-missing' });
          return;
        }
        const body = await readJsonBody(request);
        if (
          typeof body !== 'object' ||
          body === null ||
          typeof Reflect.get(body, 'input') !== 'string' ||
          typeof Reflect.get(body, 'sessionId') !== 'string'
        ) {
          writeJson(response, 400, { code: 'federation-activity-invalid' });
          return;
        }
        writeJson(
          response,
          200,
          await candidate.run(Reflect.get(body, 'input'), Reflect.get(body, 'sessionId')),
        );
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${FEDERATION_ROUTE_PREFIX}/lease`,
      handler(request, response) {
        if (request.method === 'POST') {
          const leaseId = randomUUID();
          leases.add(leaseId);
          writeJson(response, 201, { leaseId });
          return;
        }
        if (request.method === 'DELETE') {
          const leaseId = new URL(request.url ?? '/', 'http://localhost').searchParams.get(
            'leaseId',
          );
          if (leaseId !== null) leases.delete(leaseId);
          writeJson(response, 200, { released: leaseId !== null });
          return;
        }
        writeJson(response, 405, { code: 'federation-method-not-allowed' });
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${FEDERATION_ROUTE_PREFIX}/community`,
      async handler(_request, response) {
        const candidate = ctx.get('forgeaxFederationCapability') as
          | CommunityProbeService
          | undefined;
        if (candidate === undefined || typeof candidate.inspect !== 'function') {
          writeJson(response, 404, { code: 'federation-community-capability-missing' });
          return;
        }
        writeJson(response, 200, await candidate.inspect());
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${FEDERATION_ROUTE_PREFIX}/engine/control`,
      handler(request, response) {
        if (request.method !== 'POST' || config.engineEndpoint !== undefined) {
          writeJson(response, 409, { code: 'federation-engine-control-unavailable' });
          return;
        }
        state = state === 0 ? 1 : 0;
        writeJson(response, 200, status().engine);
      },
    }),
  );
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 65_536) throw new Error('federation request exceeds 65536 bytes');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(value));
}
