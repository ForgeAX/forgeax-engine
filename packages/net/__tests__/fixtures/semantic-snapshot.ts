import { type EntityHandle, type World } from '@forgeax/engine-ecs';
import { projectComponentData } from '@forgeax/engine-ecs/externalization';
import type { AuthorityCoordinator } from '../../src/replication/authority';
import type { ReplicaCoordinator } from '../../src/replication/replica';
import type { ReplicationProfile } from '../../src/replication/profile';

export interface SemanticEntitySnapshot {
  readonly id: number;
  readonly components: readonly {
    readonly name: string;
    readonly data: Record<string, unknown>;
  }[];
}

function normalize(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) return Array.from(value as ArrayLike<unknown>, normalize);
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  return value;
}

function snapshot(
  world: World,
  profile: ReplicationProfile,
  identityFor: (entity: EntityHandle) => number | undefined,
): readonly SemanticEntitySnapshot[] {
  const entities: SemanticEntitySnapshot[] = [];
  const query = world.query(profile.entities).unwrap();
  for (const row of query) {
      const entity = row.entity;
      const id = identityFor(entity);
      if (id === undefined) continue;
      const components = profile.components.flatMap((component) => {
        const read = world.get(entity, component);
        if (!read.ok) return [];
        return [
          {
            name: component.name,
            data: normalize(
              projectComponentData(
                component,
                read.value as Record<string, unknown>,
                (reference) => identityFor(reference as EntityHandle) ?? 0,
              ),
            ) as Record<string, unknown>,
          },
        ];
      });
      entities.push({ id, components });
  }
  return entities.sort((left, right) => left.id - right.id);
}

export function authoritySemanticSnapshot(
  world: World,
  profile: ReplicationProfile,
  authority: AuthorityCoordinator,
): readonly SemanticEntitySnapshot[] {
  return snapshot(world, profile, (entity) => authority.idFor(entity) || undefined);
}

export function replicaSemanticSnapshot(
  world: World,
  profile: ReplicationProfile,
  replica: ReplicaCoordinator,
): readonly SemanticEntitySnapshot[] {
  const identities = new Map<EntityHandle, number>();
  for (const { id } of replica.snapshot()) {
    const entity = replica.entityFor(id);
    if (entity !== undefined) identities.set(entity, id);
  }
  return snapshot(world, profile, (entity) => identities.get(entity));
}
