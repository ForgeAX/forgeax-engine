import { describe, expect, it } from 'vitest';
import { createHostTransport } from '../transport.js';

describe('Host transport caller ownership', () => {
  it('attaches distinct server identities to requests and scopes published events', async () => {
    const server = createHostTransport();
    const seen: string[] = [];
    server.register('caller.probe', ({ caller }) => {
      seen.push(caller.connectionId);
      return caller;
    });
    const first = server.connect({ kind: 'frontend', sourceId: 'client-a' });
    const second = server.connect({ kind: 'frontend', sourceId: 'client-b' });
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    first.subscribe('probe', (value: string) => firstEvents.push(value));
    second.subscribe('probe', (value: string) => secondEvents.push(value));

    const firstCaller = await first.request<undefined, typeof first.caller>(
      'caller.probe',
      undefined,
    );
    const secondCaller = await second.request<undefined, typeof second.caller>(
      'caller.probe',
      undefined,
    );
    expect(firstCaller.connectionId).toBe(first.caller.connectionId);
    expect(secondCaller.connectionId).toBe(second.caller.connectionId);
    expect(firstCaller.connectionId).not.toBe(secondCaller.connectionId);
    expect(seen).toEqual([first.caller.connectionId, second.caller.connectionId]);

    server.publish('probe', 'first-only', { connectionId: first.caller.connectionId });
    expect(firstEvents).toEqual(['first-only']);
    expect(secondEvents).toEqual([]);
    server.publish('probe', 'broadcast');
    expect(firstEvents).toEqual(['first-only', 'broadcast']);
    expect(secondEvents).toEqual(['broadcast']);
    first.close();
    second.close();
    server.close();
  });
});

it('revokes connection membership before abort listeners can reenter transport', async () => {
  const server = createHostTransport();
  const client = server.connect();
  const observed: unknown[] = [];
  let disconnects = 0;
  client.onDisconnect(() => {
    disconnects += 1;
  });
  server.register(
    'pending',
    ({ signal }) =>
      new Promise(() => {
        signal.addEventListener(
          'abort',
          () => {
            observed.push([
              client.connected,
              server.connectedClients,
              server.isConnected(client.caller),
            ]);
            client.close();
          },
          { once: true },
        );
      }),
  );
  const pending = client.request('pending', undefined);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'host-assembly-request-aborted' });
  client.close();
  await rejected;
  expect(observed).toEqual([[false, 0, false]]);
  expect(disconnects).toBe(1);
  server.close();
});

it('keeps stale service disposers from retiring later generations', async () => {
  const server = createHostTransport();
  const client = server.connect();
  const first = server.register('versioned', () => 'first');
  const firstGeneration = server.snapshot('versioned')?.generation;
  if (firstGeneration === undefined) throw new Error('missing service generation');
  const second = server.register('versioned', () => 'second');
  first();
  expect(await client.request('versioned', undefined)).toBe('second');
  server.invalidate('versioned');
  const third = server.register('versioned', () => 'third');
  second();
  expect(await client.request('versioned', undefined)).toBe('third');
  await expect(
    client.request('versioned', undefined, { generation: firstGeneration }),
  ).rejects.toMatchObject({
    code: 'host-assembly-stale-request',
  });
  third();
  expect(server.snapshot('versioned')).toBeUndefined();
  server.close();
});

it('keeps stale disposers from deleting a registration after abort reentry', async () => {
  const server = createHostTransport();
  const client = server.connect();
  let stale: (() => void) | undefined;
  server.register(
    'reentrant',
    ({ signal }) =>
      new Promise(() => {
        signal.addEventListener(
          'abort',
          () => {
            server.register('reentrant', () => 'first replacement');
            stale = server.register('reentrant', () => 'second replacement');
          },
          { once: true },
        );
      }),
  );
  const pending = client.request('reentrant', undefined);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'host-assembly-request-aborted' });
  server.invalidate('reentrant');
  await rejected;
  server.register('reentrant', () => 'current');
  stale?.();
  expect(await client.request('reentrant', undefined)).toBe('current');
  server.close();
});
