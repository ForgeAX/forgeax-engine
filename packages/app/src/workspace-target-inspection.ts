import { Disabled, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { ChildOf, Name } from '@forgeax/engine-scene';
import { projectComponentIntrospection } from './internal/component-introspection';
import { EngineWorkspaceError } from './workspace';

function projectValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return String(value);
  if (depth >= 4) return { unavailable: 'depth-limit' };
  if (Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView))) {
    const array = value as ArrayLike<unknown>;
    const items = Array.from({ length: Math.min(array.length, 128) }, (_, i) =>
      projectValue(array[i], depth + 1),
    );
    return array.length > 128 ? { items, truncated: true, length: array.length } : items;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    const fields = Object.fromEntries(
      entries.slice(0, 128).map(([key, entry]) => [key, projectValue(entry, depth + 1)]),
    );
    return entries.length > 128 ? { fields, truncated: true, length: entries.length } : fields;
  }
  return { unavailable: 'opaque-value' };
}

export function observationEntity(world: World, entityId: string, targetId: string): EntityHandle {
  const prefix = `${targetId}:${world.identity}:`;
  if (typeof entityId !== 'string' || !entityId.startsWith(prefix)) {
    throw new EngineWorkspaceError(
      'engine-workspace-reference-world-mismatch',
      'The entity reference belongs to another World',
      'Refresh the target entity reference.',
    );
  }
  const entity = Number(entityId.slice(prefix.length));
  if (
    !Number.isSafeInteger(entity) ||
    entity < 0 ||
    String(entity) !== entityId.slice(prefix.length)
  ) {
    throw new EngineWorkspaceError(
      'engine-workspace-reference-invalid',
      'The entity reference is invalid',
      'Use a reference returned by the Engine target tools.',
    );
  }
  if (!world.componentsOf(entity as EntityHandle).ok)
    throw new EngineWorkspaceError(
      'engine-workspace-reference-stale',
      'The entity reference is stale',
      'Refresh the entity tree before inspecting again.',
    );
  return entity as EntityHandle;
}

export function createObservationInspection(world: World, targetId: string) {
  const identity = (entity: EntityHandle) => {
    const name = world.get(entity, Name);
    return {
      entity,
      entityId: `${targetId}:${world.identity}:${entity}`,
      name: name.ok ? name.value.value : null,
    };
  };
  return {
    tree({
      offset = 0,
      limit = 500,
      revision,
    }: {
      offset?: number;
      limit?: number;
      revision?: number;
    } = {}) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000
      ) {
        throw new EngineWorkspaceError(
          'engine-workspace-page-invalid',
          'Offset must be nonnegative and limit between 1 and 1000',
        );
      }
      const currentRevision = world.getStructureEpoch();
      if ((offset > 0 || revision !== undefined) && revision !== currentRevision)
        throw new EngineWorkspaceError(
          'engine-workspace-tree-changed',
          'The entity tree changed between pages',
          'Restart from the first page and carry its revision.',
        );
      const nodes: (ReturnType<typeof identity> & {
        parentId: string | null;
        componentNames: string[];
      })[] = [];
      let index = 0;
      let nextOffset: number | null = null;
      // The normal query excludes Disabled. Inspect its explicit complement too.
      pages: for (const query of [
        world.query({}).unwrap(),
        world.query({ with: [Disabled] }).unwrap(),
      ])
        for (const row of query) {
          if (index++ < offset) continue;
          if (nodes.length === limit) {
            nextOffset = offset + limit;
            break pages;
          }
          const entity = row.entity as EntityHandle;
          const parent = world.get(entity, ChildOf);
          nodes.push({
            ...identity(entity),
            componentNames: world
              .componentsOf(entity)
              .unwrap()
              .map((component) => component.name),
            parentId:
              parent.ok && parent.value.parent !== null
                ? `${targetId}:${world.identity}:${parent.value.parent}`
                : null,
          });
        }
      return {
        targetId,
        worldId: world.identity,
        revision: currentRevision,
        sampledAt: Date.now(),
        nodes,
        nextOffset,
      };
    },
    inspect({ entityId }: { entityId: string }) {
      const entity = observationEntity(world, entityId, targetId);
      const components = world.componentsOf(entity).unwrap();
      return {
        ...identity(entity),
        targetId,
        worldId: world.identity,
        sampledAt: Date.now(),
        components: components.flatMap((component) => {
          const value = world.get(entity, component).unwrap();
          return projectComponentIntrospection(new Map([[component.name, component]])).map(
            (descriptor) => ({ ...descriptor, values: projectValue(value), writable: false }),
          );
        }),
      };
    },
  };
}
