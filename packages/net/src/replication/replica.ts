import type { Component, EntityHandle, World } from '@forgeax/engine-ecs';
import { classifyEntityField } from '@forgeax/engine-ecs/externalization';
import { componentSchema } from '@forgeax/engine-ecs/internal';
import { err, ok, type Result } from '@forgeax/engine-types';
import { decodeReplicationPacket, isReplicationDataPacket } from './codec';
import { NetError } from './errors';
import type { ReplicationLimits, ReplicationProfile } from './profile';
import type { ReplicationDataPacket } from './protocol';

export class ReplicaCoordinator {
  readonly #world: World;
  readonly #profile: ReplicationProfile;
  readonly #entities = new Map<number, EntityHandle>();
  #lastTick = 0;
  #epoch = -1;
  #lastSequence = 0;
  #lastPacketOutcome: 'accepted' | 'duplicate' | 'ignored-old-epoch' = 'accepted';
  #stopped = false;
  constructor(world: World, profile: ReplicationProfile) {
    this.#world = world;
    this.#profile = profile;
  }
  entityFor(id: number): EntityHandle | undefined {
    return this.#entities.get(id);
  }
  readComponent(id: number, component: Component): Record<string, unknown> | undefined {
    const entity = this.#entities.get(id);
    if (entity === undefined) return undefined;
    const read = this.#world.get(entity, component);
    return read.ok ? (read.value as Record<string, unknown>) : undefined;
  }
  snapshot(): readonly { id: number; components: readonly string[] }[] {
    return [...this.#entities]
      .map(([id, entity]) => ({
        id,
        components: this.#profile.components
          .filter((component) => this.#world.get(entity, component).ok)
          .map((component) => component.name),
      }))
      .sort((a, b) => a.id - b.id);
  }
  /** Remove the last replica baseline when the authority connection closes. */
  clear(): void {
    for (const entity of this.#entities.values()) this.#world.despawn(entity).unwrap();
    this.#entities.clear();
    this.#epoch = -1;
    this.#lastSequence = 0;
    this.#lastTick = 0;
  }
  get stopped(): boolean {
    return this.#stopped;
  }
  get tick(): number {
    return this.#lastTick;
  }
  /** Report the last accepted, duplicate, or stale-epoch packet decision. */
  get lastPacketOutcome(): 'accepted' | 'duplicate' | 'ignored-old-epoch' {
    return this.#lastPacketOutcome;
  }
  #entityReferences(value: unknown): readonly unknown[] {
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      return Array.from(value as ArrayLike<unknown>);
    }
    return [];
  }
  validate(packet: ReplicationDataPacket): NetError | null {
    this.#lastPacketOutcome = 'accepted';
    if (this.#stopped)
      return new NetError({
        code: 'apply-invariant-failed',
        expected: 'an active replica coordinator',
        hint: 'create a new session after a fatal apply failure',
        detail: { reason: 'replication stopped' },
      });
    if (packet.fingerprint !== this.#profile.fingerprint)
      return new NetError({
        code: 'schema-invalid',
        expected: 'a batch for the negotiated replication profile',
        hint: 'complete handshake before applying replication bytes',
        detail: { component: '', reason: 'fingerprint mismatch' },
      });
    const newEpoch = packet.epoch > this.#epoch;
    if (this.#epoch < 0 && packet.kind !== 'baseline')
      return new NetError({
        code: 'session-illegal-transition',
        expected: 'a baseline before any delta in a session epoch',
        hint: 'accept a complete authoritative baseline before applying deltas',
        detail: { from: 'connecting', to: packet.kind },
      });
    if (packet.epoch > this.#epoch && (packet.kind !== 'baseline' || packet.sequence !== 1))
      return new NetError({
        code: 'session-illegal-transition',
        expected: 'a sequence-one baseline at the start of a new epoch',
        hint: 'request a fresh baseline before applying the next delta',
        detail: { from: 'resyncing', to: packet.kind },
      });
    if (packet.epoch < this.#epoch) return null;
    if (packet.kind === 'baseline' && !newEpoch && this.#lastSequence >= 1) {
      this.#lastPacketOutcome = 'duplicate';
      return null;
    }
    if (packet.kind === 'delta' && packet.sequence <= this.#lastSequence) {
      this.#lastPacketOutcome = 'duplicate';
      return null;
    }
    if (packet.kind === 'delta' && packet.sequence !== this.#lastSequence + 1)
      return new NetError({
        code: 'ordering-invalid-tick',
        expected: 'the next contiguous replication sequence',
        hint: 'request a fresh baseline when a sequence gap is detected',
        detail: { receivedTick: packet.sequence, lastTick: this.#lastSequence },
      });
    if (!newEpoch && packet.tick <= this.#lastTick)
      return new NetError({
        code: 'ordering-invalid-tick',
        expected: 'a strictly monotonic authority tick',
        hint: 'discard duplicate, stale, and out-of-order batches',
        detail: { receivedTick: packet.tick, lastTick: this.#lastTick },
      });
    const batchIds = new Set<number>();
    const knownIds = newEpoch ? new Set<number>() : new Set(this.#entities.keys());
    for (const record of packet.entities) {
      if (!Number.isSafeInteger(record.id) || record.id <= 0 || batchIds.has(record.id))
        return new NetError({
          code: 'identity-invalid',
          expected: 'unique non-zero NetEntityId values',
          hint: 'use session-issued identity values exactly once per batch',
          detail: { id: record.id, reason: 'zero, invalid, or duplicate identity' },
        });
      batchIds.add(record.id);
    }
    for (const record of packet.entities) {
      if (record.kind === 'despawn' && !knownIds.has(record.id))
        return new NetError({
          code: 'identity-invalid',
          expected: 'a known identity for despawn',
          hint: 'do not reuse or despawn unknown network identities',
          detail: { id: record.id, reason: 'unknown identity' },
        });
      for (const entry of record.components) {
        const component = this.#profile.components.find(
          (candidate) => candidate.name === entry.name,
        );
        if (component === undefined)
          return new NetError({
            code: 'schema-invalid',
            expected: 'a component selected by the negotiated profile',
            hint: 'send only components from the ordered replication profile',
            detail: { component: entry.name, reason: 'unselected component' },
          });
        if (entry.operation === 'remove') continue;
        for (const [field, value] of Object.entries(entry.data)) {
          if (!(field in componentSchema(component)))
            return new NetError({
              code: 'schema-invalid',
              expected: 'component fields declared by the negotiated ECS schema',
              hint: 'send only fields declared by the replicated component token',
              detail: { component: entry.name, reason: `unknown field ${field}` },
            });
          const kind = classifyEntityField(component, field);
          const refs = kind?.isArray ? this.#entityReferences(value) : kind ? [value] : [];
          for (const reference of refs)
            if (
              reference !== null &&
              (typeof reference !== 'number' ||
                reference === 0 ||
                (!knownIds.has(reference) && !batchIds.has(reference)))
            )
              return new NetError({
                code: 'remap-unresolved-reference',
                expected: 'every entity reference to resolve in the current or same batch',
                hint: 'include the referenced spawn in this batch; cross-batch pending references are unsupported',
                detail: { id: record.id, referencedId: Number(reference) },
              });
        }
      }
    }
    return null;
  }
  apply(packet: ReplicationDataPacket): Result<void, NetError> {
    const failure = this.validate(packet);
    if (failure) {
      return err(failure);
    }
    if (packet.epoch < this.#epoch) {
      this.#lastPacketOutcome = 'ignored-old-epoch';
      return ok(undefined);
    }
    if (this.#lastPacketOutcome === 'duplicate') return ok(undefined);
    const replacingEpoch = packet.epoch > this.#epoch;
    try {
      if (replacingEpoch) {
        for (const entity of this.#entities.values()) this.#world.despawn(entity).unwrap();
        this.#entities.clear();
      }
      for (const record of packet.entities)
        if (record.kind === 'upsert' && !this.#entities.has(record.id))
          this.#entities.set(record.id, this.#world.spawn().unwrap());
      for (const record of packet.entities)
        if (record.kind === 'upsert') {
          const entity = this.#entities.get(record.id);
          if (entity === undefined) throw new Error(`missing allocated entity ${record.id}`);
          for (const entry of record.components) {
            const component = this.#profile.components.find(
              (candidate) => candidate.name === entry.name,
            );
            if (component === undefined) throw new Error(`missing profile component ${entry.name}`);
            if (entry.operation === 'remove') {
              const removal = this.#world.removeComponent(entity, component);
              if (!removal.ok) throw removal.error;
              continue;
            }
            const data = Object.fromEntries(
              Object.entries(entry.data).map(([field, value]) => {
                const kind = classifyEntityField(component, field);
                if (kind === null) return [field, value];
                const mapped = kind.isArray
                  ? this.#entityReferences(value).map((id) => {
                      if (id === null) return null;
                      const reference = this.#entities.get(id as number);
                      if (reference === undefined)
                        throw new Error(`missing entity reference ${id}`);
                      return reference;
                    })
                  : value === null
                    ? null
                    : this.#entities.get(value as number);
                if (mapped === undefined) throw new Error(`missing entity reference ${value}`);
                return [field, mapped];
              }),
            );
            const typedData = data as never;
            const exists = this.#world.get(entity, component);
            const write = exists.ok
              ? this.#world.set(entity, component, typedData)
              : this.#world.addComponent(entity, { component, data: typedData });
            if (!write.ok) throw write.error;
          }
        }
      for (const record of packet.entities)
        if (record.kind === 'despawn') {
          const entity = this.#entities.get(record.id);
          if (entity === undefined) throw new Error(`missing despawn entity ${record.id}`);
          this.#world.despawn(entity).unwrap();
          this.#entities.delete(record.id);
        }
      this.#epoch = packet.epoch;
      this.#lastSequence = packet.sequence;
      this.#lastTick = packet.tick;
      this.#lastPacketOutcome = 'accepted';
      return ok(undefined);
    } catch (cause) {
      this.#stopped = true;
      return err(
        new NetError({
          code: 'apply-invariant-failed',
          expected: 'ECS apply invariants to accept a validated batch',
          hint: 'stop this replication session and inspect the ECS error',
          detail: { reason: cause instanceof Error ? cause.message : String(cause) },
        }),
      );
    }
  }
}
export function createReplicaCoordinator(
  world: World,
  profile: ReplicationProfile,
): ReplicaCoordinator {
  return new ReplicaCoordinator(world, profile);
}
export function applyReplicationPacket(
  replica: ReplicaCoordinator,
  packet: ReplicationDataPacket,
): Result<void, NetError> {
  return replica.apply(packet);
}

export function decodeAndApplyReplicationPacket(
  replica: ReplicaCoordinator,
  bytes: Uint8Array,
  limits: ReplicationLimits,
): Result<void, NetError> {
  const decoded = decodeReplicationPacket(bytes, limits);
  if (!decoded.ok) {
    return err(decoded.error);
  }
  if (!isReplicationDataPacket(decoded.value)) {
    return err(
      new NetError({
        code: 'decode-invalid-payload',
        expected: 'a baseline or delta replication packet',
        hint: 'apply only data packets through the replica coordinator',
        detail: { reason: 'control packet cannot be applied as ECS data' },
      }),
    );
  }
  return replica.apply(decoded.value);
}
