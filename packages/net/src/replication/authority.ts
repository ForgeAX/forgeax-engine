import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { classifyEntityField, projectComponentData } from '@forgeax/engine-ecs/externalization';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { SessionId } from '../session/recovery';
import { encodeReplicationPacket } from './codec';
import { REPLICATION_PROTOCOL_VERSION } from './constants';
import type { NetError } from './errors';
import {
  DEFAULT_REPLICATION_LIMITS,
  type ReplicationLimits,
  type ReplicationProfile,
} from './profile';
import type {
  ReplicationComponentRecord,
  ReplicationDataPacket,
  ReplicationEntityRecord,
} from './protocol';

export type PublishedPacket = ReplicationDataPacket & {
  readonly bytes: Uint8Array;
};
interface KnownEntity {
  readonly id: number;
  readonly components: Map<string, string>;
}
/** Synchronous, pure receiver policy; it can only narrow the Profile query. */
export type ReplicationVisibility = (entity: EntityHandle, sessionId: SessionId) => boolean;
interface Publication {
  readonly known: Map<EntityHandle, KnownEntity>;
  readonly nextId: number;
  readonly tick: number;
  readonly epoch: number;
  readonly sequence: number;
}
function stable(value: unknown): string {
  return JSON.stringify(value);
}

export class AuthorityCoordinator {
  readonly #world: World;
  readonly #profile: ReplicationProfile;
  readonly #publications = new Map<SessionId, Publication>();
  readonly #sessionId: SessionId;
  constructor(world: World, profile: ReplicationProfile, sessionId: SessionId = 1 as SessionId) {
    this.#world = world;
    this.#profile = profile;
    this.#sessionId = sessionId;
  }
  get limits(): ReplicationLimits {
    return this.#profile.limits;
  }
  idFor(entity: EntityHandle, sessionId: SessionId = this.#sessionId): number {
    return this.#publications.get(sessionId)?.known.get(entity)?.id ?? 0;
  }
  rebindSession(from: SessionId, to: SessionId): void {
    const prior = this.#publications.get(from);
    this.#publications.delete(from);
    if (prior !== undefined) this.#publications.set(to, prior);
  }
  resumeSession(sessionId: SessionId, epoch: number): void {
    const prior = this.#publications.get(sessionId);
    this.#publications.set(sessionId, {
      known: new Map(),
      nextId: prior?.nextId ?? 1,
      tick: 0,
      epoch: Math.max(epoch, prior === undefined ? 0 : prior.epoch + 1),
      sequence: 0,
    });
  }
  forgetSession(sessionId: SessionId): void {
    this.#publications.delete(sessionId);
  }
  publish(
    sessionId: SessionId = this.#sessionId,
    visibility?: ReplicationVisibility,
  ): Result<PublishedPacket, NetError> {
    return this.#publish(false, sessionId, visibility);
  }
  publishFull(
    sessionId: SessionId = this.#sessionId,
    visibility?: ReplicationVisibility,
  ): Result<PublishedPacket, NetError> {
    return this.#publish(true, sessionId, visibility);
  }
  nextPublicationEpoch(forceFull = false, sessionId: SessionId = this.#sessionId): number {
    const prior = this.#publications.get(sessionId);
    return (prior?.epoch ?? 0) + (forceFull && prior !== undefined ? 1 : 0);
  }
  #publish(
    forceFull: boolean,
    sessionId: SessionId,
    visibility: ReplicationVisibility | undefined,
  ): Result<PublishedPacket, NetError> {
    const publication = this.#publications.get(sessionId) ?? {
      known: new Map<EntityHandle, KnownEntity>(),
      nextId: 1,
      tick: 0,
      epoch: 0,
      sequence: 0,
    };
    let candidateNextId = publication.nextId;
    const candidateKnown = new Map<EntityHandle, KnownEntity>();
    const query = this.#world.query(this.#profile.entities).unwrap();
    // Establish every candidate identity before projecting references, including
    // references to later storage groups. Nothing is adopted before encoding.
    for (const row of query) {
      if (visibility !== undefined && !visibility(row.entity, sessionId)) continue;
      candidateKnown.set(row.entity, {
        id: publication.known.get(row.entity)?.id ?? candidateNextId++,
        components: new Map(),
      });
    }

    const full = forceFull || publication.tick === 0;
    let nextEpoch = publication.epoch;
    let nextSequence = publication.sequence;
    if (forceFull && publication.tick > 0) {
      nextEpoch += 1;
      nextSequence = 0;
    }
    if (full && nextSequence === 0) nextSequence = 1;
    else nextSequence += 1;
    const entities: ReplicationEntityRecord[] = [];
    for (const row of query) {
      const candidate = candidateKnown.get(row.entity);
      if (candidate === undefined) continue;
      const prior = publication.known.get(row.entity);
      const components: ReplicationComponentRecord[] = [];
      for (const component of this.#profile.components) {
        const raw = this.#world.get(row.entity, component);
        if (!raw.ok) continue;
        const data = projectComponentData(
          component,
          raw.value as Record<string, unknown>,
          (reference) => candidateKnown.get(reference as EntityHandle)?.id ?? 0,
        );
        if (visibility !== undefined) {
          // Receiver-local null/array removal prevents hidden or out-of-profile
          // identities from crossing the wire or creating unresolved references.
          for (const [field, value] of Object.entries(data)) {
            const kind = classifyEntityField(component, field);
            if (kind?.isArray && Array.isArray(value)) data[field] = value.filter((id) => id !== 0);
            else if (kind !== null && value === 0) data[field] = null;
          }
        }
        const signature = stable(data);
        candidate.components.set(component.name, signature);
        if (full || prior?.components.get(component.name) !== signature)
          components.push({ name: component.name, data });
      }
      if (!full && prior !== undefined)
        for (const name of prior.components.keys())
          if (!candidate.components.has(name))
            components.push({ name, operation: 'remove', data: {} });
      if (full || prior === undefined || components.length > 0)
        entities.push({ id: candidate.id, kind: 'upsert', components });
    }
    // A fresh baseline includes only live identities; deltas retire identities
    // from the previously adopted publication.
    if (!full)
      for (const [entity, prior] of publication.known)
        if (!candidateKnown.has(entity))
          entities.push({ id: prior.id, kind: 'despawn', components: [] });

    const common = {
      version: REPLICATION_PROTOCOL_VERSION,
      sessionId,
      epoch: nextEpoch,
      fingerprint: this.#profile.fingerprint,
      tick: publication.tick + 1,
      entities,
    } as const;

    const packet: ReplicationDataPacket = full
      ? { ...common, kind: 'baseline', sequence: nextSequence as 1 }
      : { ...common, kind: 'delta', sequence: nextSequence };
    const encoded = encodeReplicationPacket(
      packet,
      this.#profile.limits ?? DEFAULT_REPLICATION_LIMITS,
    );
    if (!encoded.ok) return err(encoded.error);

    this.#publications.set(sessionId, {
      known: candidateKnown,
      nextId: candidateNextId,
      tick: packet.tick,
      epoch: nextEpoch,
      sequence: nextSequence,
    });
    return ok({ ...packet, bytes: encoded.value });
  }
}
export function createAuthorityCoordinator(
  world: World,
  profile: ReplicationProfile,
): AuthorityCoordinator {
  return new AuthorityCoordinator(world, profile);
}
