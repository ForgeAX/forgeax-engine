import { defineComponent } from '@forgeax/engine/ecs';
import type { EndpointEvent, NetEndpoint, PeerId, ReplicationProfile } from '@forgeax/engine/net';
import {
  decodeReplicationPacket,
  defineReplication,
  ENDPOINT_ERROR_HINTS,
  ENDPOINT_EXPECTED,
  EndpointError,
} from '@forgeax/engine/net';
import { err, ok } from '@forgeax/engine/types';

export const AUTHORITY_PEER = 1 as PeerId;

export const NetHealth = defineComponent('FeatureLabNetHealth', { hp: 'f32', alive: 'bool' });

export function healthProfile(name = 'feature-lab-health'): ReplicationProfile | string {
  const result = defineReplication({
    name,
    entities: { with: [NetHealth] },
    components: [NetHealth],
  });
  return result.ok ? result.value : `${result.error.code}: ${result.error.hint}`;
}

function failure(): EndpointError {
  return new EndpointError({
    code: 'connection-failed',
    expected: ENDPOINT_EXPECTED['connection-failed'],
    hint: ENDPOINT_ERROR_HINTS['connection-failed'],
    detail: { address: 'feature-lab-hub', cause: 'peer is not attached' },
  });
}

export interface SentMessage {
  readonly peerId: PeerId;
  readonly data: Uint8Array;
}

/** One authority endpoint fanned out to many replica endpoints, so a reconnecting replica arrives as a new peer. */
export interface MemoryHub {
  readonly authority: NetEndpoint;
  readonly sent: SentMessage[];
  addPeer(peerId: number): NetEndpoint;
  /** Transport-side drop: both sides observe peer-disconnected, as when a socket dies. */
  dropPeer(peerId: number): void;
}

export function createMemoryHub(): MemoryHub {
  const authorityEvents: EndpointEvent[] = [];
  const inboxes = new Map<PeerId, EndpointEvent[]>();
  const sent: SentMessage[] = [];
  const authority: NetEndpoint = {
    poll: () => authorityEvents.splice(0),
    send: (peerId, data) => {
      const inbox = inboxes.get(peerId);
      if (inbox === undefined) return err(failure());
      sent.push({ peerId, data });
      inbox.push({ kind: 'message', peerId: AUTHORITY_PEER, data });
      return ok(undefined);
    },
    disconnect: (peerId) => {
      const inbox = inboxes.get(peerId);
      if (!inbox) return err(failure());
      inboxes.delete(peerId);
      inbox.push({ kind: 'peer-disconnected', peerId: AUTHORITY_PEER });
      authorityEvents.push({ kind: 'peer-disconnected', peerId });
      return ok(undefined);
    },
    close: () => {
      for (const peerId of inboxes.keys()) authority.disconnect(peerId);
      return ok(undefined);
    },
  };
  return {
    authority,
    sent,
    addPeer(value) {
      const peerId = value as PeerId;
      const inbox: EndpointEvent[] = [{ kind: 'peer-connected', peerId: AUTHORITY_PEER }];
      inboxes.set(peerId, inbox);
      authorityEvents.push({ kind: 'peer-connected', peerId });
      return {
        poll: () => inbox.splice(0),
        send: (target, data) => {
          if (!inboxes.has(peerId) || target !== AUTHORITY_PEER) return err(failure());
          authorityEvents.push({ kind: 'message', peerId, data });
          return ok(undefined);
        },
        disconnect: (target) =>
          target === AUTHORITY_PEER ? authority.disconnect(peerId) : err(failure()),
        close: () => {
          if (inboxes.delete(peerId)) authorityEvents.push({ kind: 'peer-disconnected', peerId });
          return ok(undefined);
        },
      };
    },
    dropPeer(value) {
      const peerId = value as PeerId;
      authority.disconnect(peerId);
    },
  };
}

export function packetsSince(
  hub: MemoryHub,
  start: number,
  profile: ReplicationProfile,
): readonly {
  readonly peerId: number;
  readonly kind: string;
  readonly epoch: number;
  readonly sequence: number;
}[] {
  return hub.sent.slice(start).map(({ peerId, data }) => {
    const decoded = decodeReplicationPacket(data, profile.limits);
    if (!decoded.ok)
      return { peerId, kind: `undecodable:${decoded.error.code}`, epoch: -1, sequence: -1 };
    const packet = decoded.value;
    return {
      peerId,
      kind: packet.kind,
      epoch: packet.epoch,
      sequence: 'sequence' in packet ? packet.sequence : -1,
    };
  });
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}
