import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EndpointEvent, PeerId } from '../src/endpoint/endpoint';
import type { EndpointError } from '../src/endpoint/errors';
import type { Result } from '@forgeax/engine-types';

// ---------------------------------------------------------------------------
// Shared endpoint behavior contract suite (plan-strategy D-3)
//
// This module exports a single parameterized test suite function. The suite
// accepts an async factory returning two NetEndpoint instances and a cleanup
// function, and runs shared behavior assertions that any backend must satisfy.
//
// The suite is backend-agnostic: it does NOT import or reference
// createMemoryEndpointPair or any memory-specific types.
// ---------------------------------------------------------------------------

/** Factory that creates two connected endpoints and a cleanup function. */
export interface EndpointHarness {
  poll(): EndpointEvent[] | Promise<EndpointEvent[]>;
  send(
    peerId: PeerId,
    data: Uint8Array,
  ): Result<void, EndpointError> | Promise<Result<void, EndpointError>>;
  close(): Result<void, EndpointError> | Promise<Result<void, EndpointError>>;
}

export interface EndpointPairHarness {
  endpoints: [EndpointHarness, EndpointHarness];
  cleanup: () => Promise<void>;
}

export type EndpointPairFactory = () => Promise<EndpointPairHarness>;

/**
 * Run the shared endpoint behavior contract suite against a pair of endpoints.
 *
 * The suite covers: peer lifecycle (connect/disconnect events), complete
 * Uint8Array message boundary preservation, same-peer reliable ordered
 * delivery, wrong-peer send returning peer-not-found, close semantics
 * (already-closed on double-close, send-after-close), disconnect event
 * emission, and send-to-disconnected returning connection-closed.
 */
export function runEndpointBehaviorSuite(
  factory: EndpointPairFactory,
): void {
  describe('Endpoint behavior contract', () => {
    let epA: EndpointHarness;
    let epB: EndpointHarness;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const result = await factory();
      epA = result.endpoints[0];
      epB = result.endpoints[1];
      cleanup = result.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    it('creates a pair of endpoints', () => {
      expect(epA).toBeDefined();
      expect(epB).toBeDefined();
    });

    it('emits peer-connected event after pair creation', async () => {
      const eventsA = await epA.poll();
      const eventsB = await epB.poll();

      const connectA = eventsA.find((e) => e.kind === 'peer-connected');
      const connectB = eventsB.find((e) => e.kind === 'peer-connected');

      expect(connectA).toBeDefined();
      expect(connectB).toBeDefined();
      expect(connectA!.peerId).toBeDefined();
      expect(connectB!.peerId).toBeDefined();
    });

    it('delivers messages in order (reliable ordered)', async () => {
      const peerIdB = await getPeerId(epA, 'peer-connected');

      const msg1 = new Uint8Array([1, 2, 3]);
      const msg2 = new Uint8Array([4, 5, 6]);
      const msg3 = new Uint8Array([7, 8, 9]);

      const r1 = await epA.send(peerIdB, msg1);
      const r2 = await epA.send(peerIdB, msg2);
      const r3 = await epA.send(peerIdB, msg3);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(true);

      const messages = await waitForEvents(epB, 'message', 3);
      expect(messages).toHaveLength(3);
      expect(messages[0]!.data).toEqual(msg1);
      expect(messages[1]!.data).toEqual(msg2);
      expect(messages[2]!.data).toEqual(msg3);
    });

    it('preserves message boundaries (complete Uint8Array)', async () => {
      const peerIdB = await getPeerId(epA, 'peer-connected');

      const msg = new Uint8Array([1, 2, 3, 4, 5]);
      const r = await epA.send(peerIdB, msg);
      expect(r.ok).toBe(true);

      const messages = await waitForEvents(epB, 'message', 1);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.data).toEqual(msg);
      expect(messages[0]!.data.length).toBe(5);
    });

    it('sends to wrong peerId returns peer-not-found error', async () => {
      const fakePeerId = 999 as PeerId;

      const r = await epA.send(fakePeerId, new Uint8Array([1]));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('peer-not-found');
      }
    });

    it('close prevents further operations', async () => {
      const peerIdB = await getPeerId(epA, 'peer-connected');

      const r1 = await epA.close();
      expect(r1.ok).toBe(true);

      const r2 = await epA.send(peerIdB, new Uint8Array([1]));
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.error.code).toBe('already-closed');
      }

      const r3 = await epA.close();
      expect(r3.ok).toBe(false);
      if (!r3.ok) {
        expect(r3.error.code).toBe('already-closed');
      }
    });

    it('emits peer-disconnected event on close', async () => {
      await epA.close();

      const disconnects = await waitForEvents(epB, 'peer-disconnected', 1);
      expect(disconnects).toHaveLength(1);
    });

    it('send to disconnected peer returns connection-closed', async () => {
      const peerIdB = await getPeerId(epA, 'peer-connected');

      await epB.close();
      await waitForEvents(epA, 'peer-disconnected', 1);

      const r = await epA.send(peerIdB, new Uint8Array([1]));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('connection-closed');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForEvents(
  endpoint: EndpointHarness,
  kind: EndpointEvent['kind'],
  count: number,
): Promise<EndpointEvent[]> {
  const events: EndpointEvent[] = [];
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    events.push(...(await endpoint.poll()));
    const matching = events.filter((event) => event.kind === kind);
    if (matching.length >= count) return matching;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count} ${kind} event(s)`);
}

async function getPeerId(
  ep: EndpointHarness,
  eventKind: 'peer-connected' | 'peer-disconnected',
): Promise<PeerId> {
  const events = await ep.poll();
  const event = events.find((e) => e.kind === eventKind);
  if (!event) {
    throw new Error(`No ${eventKind} event found`);
  }
  return event.peerId;
}
