import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { connectDshRealm, type DshRealmError } from '../engine-host';
import { FEDERATION_PROTOCOL_VERSION, FEDERATION_ROUTE_PREFIX } from '../protocol';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('Engine to DSH binding ownership', () => {
  it('attach releases an idempotent lease without closing the external realm', async () => {
    let leases = 0;
    const endpoint = await serve((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === `${FEDERATION_ROUTE_PREFIX}/status`) {
        json(response, 200, status(leases));
        return;
      }
      if (url.pathname === `${FEDERATION_ROUTE_PREFIX}/lease` && request.method === 'POST') {
        leases += 1;
        json(response, 201, { leaseId: 'lease-1' });
        return;
      }
      if (url.pathname === `${FEDERATION_ROUTE_PREFIX}/lease` && request.method === 'DELETE') {
        leases -= 1;
        json(response, 200, { released: true });
        return;
      }
      json(response, 404, {});
    });

    const result = await connectDshRealm({ endpoint, handshakeTimeoutMs: 250 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    const realm = result.value;
    expect(realm.connection.binding).toBe('attach');
    expect(realm.connection.ownership).toBe('lease');
    expect(leases).toBe(1);
    await realm.dispose();
    await realm.dispose();
    expect(leases).toBe(0);
    expect((await fetch(`${endpoint}${FEDERATION_ROUTE_PREFIX}/status`)).ok).toBe(true);
  });

  it('fails an explicit incompatible endpoint without acquiring a lease or falling back', async () => {
    let leaseRequests = 0;
    const endpoint = await serve((request, response) => {
      if (request.url?.startsWith(`${FEDERATION_ROUTE_PREFIX}/lease`) === true) {
        leaseRequests += 1;
      }
      json(response, 200, { ...status(0), protocol: 99 });
    });

    const result = await connectDshRealm({ endpoint, handshakeTimeoutMs: 250 });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'dsh-target-incompatible' } satisfies Partial<DshRealmError>,
    });
    expect(leaseRequests).toBe(0);
  });

  it('rolls back before publication when lease acquisition fails', async () => {
    const endpoint = await serve((request, response) => {
      if (request.url === `${FEDERATION_ROUTE_PREFIX}/status`) {
        json(response, 200, status(0));
        return;
      }
      json(response, 503, {});
    });

    const result = await connectDshRealm({ endpoint, handshakeTimeoutMs: 250 });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'dsh-lease-failed' } satisfies Partial<DshRealmError>,
    });
  });

  it('returns a structured launch error for an invalid explicit executable', async () => {
    const result = await connectDshRealm({
      executable: '/definitely-missing/forgeax-dsh',
      handshakeTimeoutMs: 250,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'dsh-launch-failed' } satisfies Partial<DshRealmError>,
    });
  });
});

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

function status(leases: number): Record<string, unknown> {
  return {
    protocol: FEDERATION_PROTOCOL_VERSION,
    identity: 'fixture-dsh',
    ready: true,
    realm: 'dsh',
    capabilities: ['lease'],
    leases,
    engine: { binding: 'embedded', ready: true, frameId: 1, tick: 1, state: 0 },
  };
}

function json(response: import('node:http').ServerResponse, code: number, value: unknown): void {
  response.writeHead(code, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}
