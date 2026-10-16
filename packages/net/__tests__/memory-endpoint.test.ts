import { describe, expect, it } from 'vitest';
import type { PeerId } from '../src/endpoint/endpoint';
import type { NetEndpoint } from '../src/endpoint/endpoint';
import { createMemoryEndpointPair, createMemoryEndpointPairWithController } from '../src/endpoint/memory';
import { runEndpointBehaviorSuite } from './endpoint-behavior.contract';

// ---------------------------------------------------------------------------
// Shared endpoint behavior contract suite (plan-strategy D-3)
//
// Memory backend runs the same factory-driven contract suite that WebSocket
// will use. This proves the memory backend satisfies the shared contract
// with unchanged semantics.
// ---------------------------------------------------------------------------

runEndpointBehaviorSuite(async () => {
  const [epA, epB] = createMemoryEndpointPair();
  return {
    endpoints: [epA, epB],
    cleanup: async () => {
      // Memory endpoints don't need external cleanup; close what's open.
      try { epA.close(); } catch { /* ignore */ }
      try { epB.close(); } catch { /* ignore */ }
    },
  };
});

// ===========================================================================
// Fault injection tests (test-only control surface)
// These are memory-specific and remain in this file; they are NOT part of
// the shared contract suite.
// ===========================================================================

describe('Memory fault injection', () => {
  it.each(['disconnect', 'close', 'fault'] as const)('%s retires delayed bytes before the terminal event', (operation) => {
    const { endpoints: [sender, receiver], controller } = createMemoryEndpointPairWithController();
    const peer = getPeerId(sender, 'peer-connected');
    receiver.poll();
    controller.delayNextDelivery(100);
    sender.send(peer, new Uint8Array([1, 2, 3])).unwrap();
    if (operation === 'fault') controller.disconnectPeer(sender);
    else if (operation === 'close') sender.close().unwrap();
    else sender.disconnect(peer).unwrap();
    expect(receiver.poll()).toEqual([{kind: 'peer-disconnected', peerId: 1}]);
    expect(receiver.poll()).toEqual([]);
    expect(receiver.send(1 as PeerId, new Uint8Array([4])).ok).toBe(false);
    sender.close();
    receiver.close();
  });

  it('delay: message arrives after configured delay', () => {
    const { endpoints: [epA, epB], controller } = createMemoryEndpointPairWithController();
    const peerIdB = getPeerId(epA, 'peer-connected');

    controller.delayNextDelivery(100);
    const r = epA.send(peerIdB, new Uint8Array([1, 2, 3]));
    expect(r.ok).toBe(true);

    const immediate = epB.poll();
    const immediateMessages = immediate.filter((e) => e.kind === 'message');
    expect(immediateMessages).toHaveLength(0);
  });

  it('duplicate: message is delivered twice', () => {
    const { endpoints: [epA, epB], controller } = createMemoryEndpointPairWithController();
    const peerIdB = getPeerId(epA, 'peer-connected');

    controller.duplicateNextDelivery();
    const r = epA.send(peerIdB, new Uint8Array([1, 2, 3]));
    expect(r.ok).toBe(true);

    const events = epB.poll();
    const messages = events.filter((e) => e.kind === 'message');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(messages[1]!.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('malformed: message bytes are corrupted', () => {
    const { endpoints: [epA, epB], controller } = createMemoryEndpointPairWithController();
    const peerIdB = getPeerId(epA, 'peer-connected');

    controller.malformNextDelivery();
    const r = epA.send(peerIdB, new Uint8Array([1, 2, 3]));
    expect(r.ok).toBe(true);

    const events = epB.poll();
    const messages = events.filter((e) => e.kind === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.data).not.toEqual(new Uint8Array([1, 2, 3]));
  });

  it('disconnect: fault controller can force-disconnect a peer', () => {
    const { endpoints: [epA, epB], controller } = createMemoryEndpointPairWithController();
    const peerIdB = getPeerId(epA, 'peer-connected');

    controller.disconnectPeer(epA);

    const events = epB.poll();
    const disconnect = events.find((e) => e.kind === 'peer-disconnected');
    expect(disconnect).toBeDefined();
  });

  it('fault controls are not exposed on public NetEndpoint surface', () => {
    const [epA] = createMemoryEndpointPair();

    expect((epA as Record<string, unknown>).delayNextDelivery).toBeUndefined();
    expect((epA as Record<string, unknown>).duplicateNextDelivery).toBeUndefined();
    expect((epA as Record<string, unknown>).malformNextDelivery).toBeUndefined();
    expect((epA as Record<string, unknown>).disconnectPeer).toBeUndefined();
  });

  it('duplicate and disconnect are not interpreted as auto-recovery', () => {
    const { endpoints: [epA, epB], controller } = createMemoryEndpointPairWithController();
    const peerIdB = getPeerId(epA, 'peer-connected');

    controller.disconnectPeer(epA);
    epA.poll();

    const r = epA.send(peerIdB, new Uint8Array([1]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('connection-closed');
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPeerId(
  ep: NetEndpoint,
  eventKind: 'peer-connected' | 'peer-disconnected',
): PeerId {
  const events = ep.poll();
  const event = events.find((e) => e.kind === eventKind);
  if (!event) {
    throw new Error(`No ${eventKind} event found`);
  }
  return event.peerId;
}
