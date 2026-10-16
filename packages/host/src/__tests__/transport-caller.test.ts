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
