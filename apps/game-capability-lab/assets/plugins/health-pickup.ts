import {
  FixedUpdate,
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  Collider,
  ColliderShapeValue,
  CollidingEntities,
  RigidBody,
  RigidBodyTypeValue,
  type PhysicsWorld,
} from '@forgeax/engine-physics';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { ChildOf, GlobalTransform, Name, Transform } from '@forgeax/engine-scene';
import { inState } from '@forgeax/engine-state';
import type { Handle } from '@forgeax/engine-types';
import { PlayerHealth } from './counterattack';
import { GameState } from './gameplay-state';

const PICKUP_SENSOR_RADIUS = 0.62;

/** Runtime projection marker shared by every authored health pickup. */
export const HealthPickup = defineComponent('GameDefaultHealthPickup', {
  authoredLocalId: 'u32',
}, { transient: true });

export type HealthPickupContact = {
  readonly current: number;
  readonly max: number;
};

export type HealthPickupContactResult = {
  readonly health: number;
  readonly admitted: boolean;
};

export function resolveHealthPickupContact(contact: HealthPickupContact): HealthPickupContactResult {
  if (contact.current >= contact.max) return { health: contact.current, admitted: false };
  return { health: Math.min(contact.max, contact.current + 1), admitted: true };
}

export type AuthoredHealthPickupIdentity = {
  readonly entity: EntityHandle;
  readonly localId: number;
  readonly initiallyActive: boolean;
};

export type HealthPickupItemSnapshot = {
  readonly authoredLocalId: number;
  readonly entity: number | null;
  readonly available: boolean;
  readonly position: readonly [number, number, number];
  readonly visible: boolean;
  readonly sensor: boolean;
  readonly physicsReady: boolean;
  readonly admittedCollections: number;
  readonly deferredDespawns: number;
  readonly fullHealthContactRefused: boolean;
};

export type HealthPickupSnapshot = {
  readonly pickups: readonly HealthPickupItemSnapshot[];
};

export type HealthPickupHandle = {
  readonly installSystem: (ctx: {
    readonly physics: PhysicsWorld | undefined;
    readonly onCollect: (
      health: number,
      max: number,
      position: readonly [number, number, number],
    ) => void;
  }) => void;
  readonly activate: (authoredLocalId: number) => boolean;
  readonly reset: () => void;
  readonly snapshot: () => HealthPickupSnapshot;
  readonly dispose: () => void;
};

type PickupRecipe = {
  readonly localId: number;
  readonly initiallyActive: boolean;
  readonly name: string;
  readonly pos: [number, number, number];
  readonly quat: [number, number, number, number];
  readonly scale: [number, number, number];
  readonly parent: EntityHandle | undefined;
  readonly mesh: Handle<'MeshAsset', 'shared'>;
  readonly materials: Handle<'MaterialAsset', 'shared'>[];
};

type PickupState = {
  readonly recipe: PickupRecipe;
  entity: EntityHandle;
  active: boolean;
  admittedCollections: number;
  fullHealthContactRefused: boolean;
};

function removeIfPresent(world: World, entity: EntityHandle, component: Parameters<World['removeComponent']>[1]): void {
  if (world.get(entity, component).ok) world.removeComponent(entity, component).unwrap();
}

/** Own one roster, one healing policy, and one collision system for authored pickups. */
export function createHealthPickups(
  world: World,
  player: EntityHandle,
  authored: readonly AuthoredHealthPickupIdentity[],
): HealthPickupHandle | undefined {
  const states: PickupState[] = [];
  const retainedMeshes: Handle<'MeshAsset', 'shared'>[] = [];
  const retainedMaterials: Handle<'MaterialAsset', 'shared'>[] = [];

  for (const identity of authored) {
    const transform = world.get(identity.entity, Transform);
    const mesh = world.get(identity.entity, MeshFilter);
    const renderer = world.get(identity.entity, MeshRenderer);
    const name = world.get(identity.entity, Name);
    if (!transform.ok || !mesh.ok || !renderer.ok || !name.ok) continue;
    const child = world.get(identity.entity, ChildOf);
    const meshHandle = mesh.value.assetHandle as Handle<'MeshAsset', 'shared'>;
    const materials = [...renderer.value.materials] as Handle<'MaterialAsset', 'shared'>[];
    if (world.sharedRefs.retain(meshHandle).ok) retainedMeshes.push(meshHandle);
    for (const material of materials) {
      if (world.sharedRefs.retain(material).ok) retainedMaterials.push(material);
    }
    states.push({
      recipe: {
        localId: identity.localId,
        initiallyActive: identity.initiallyActive,
        name: name.value.value,
        pos: [...transform.value.pos] as [number, number, number],
        quat: [...transform.value.quat] as [number, number, number, number],
        scale: [...transform.value.scale] as [number, number, number],
        parent: child.ok ? child.value.parent as EntityHandle : undefined,
        mesh: meshHandle,
        materials,
      },
      entity: identity.entity,
      active: identity.initiallyActive,
      admittedCollections: 0,
      fullHealthContactRefused: false,
    });
  }
  if (states.length !== authored.length) {
    for (const handle of retainedMeshes) world.sharedRefs.release(handle);
    for (const handle of retainedMaterials) world.sharedRefs.release(handle);
    return undefined;
  }

  let physics: PhysicsWorld | undefined;
  let disposed = false;

  const live = (state: PickupState): boolean => world.get(state.entity, Name).ok;
  const available = (state: PickupState): boolean => state.active && live(state) && world.get(state.entity, HealthPickup).ok;

  const addRuntime = (state: PickupState): void => {
    const entity = state.entity;
    if (world.get(entity, MeshFilter).ok) world.set(entity, MeshFilter, { assetHandle: state.recipe.mesh });
    else world.addComponent(entity, { component: MeshFilter, data: { assetHandle: state.recipe.mesh } }).unwrap();
    if (world.get(entity, MeshRenderer).ok) world.set(entity, MeshRenderer, { materials: state.recipe.materials });
    else world.addComponent(entity, { component: MeshRenderer, data: { materials: state.recipe.materials } }).unwrap();
    if (world.get(entity, HealthPickup).ok) world.set(entity, HealthPickup, { authoredLocalId: state.recipe.localId });
    else world.addComponent(entity, { component: HealthPickup, data: { authoredLocalId: state.recipe.localId } }).unwrap();
    if (world.get(entity, RigidBody).ok) world.set(entity, RigidBody, { type: RigidBodyTypeValue.kinematic });
    else world.addComponent(entity, { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } }).unwrap();
    const collider = { shape: ColliderShapeValue.sphere, radius: PICKUP_SENSOR_RADIUS, isSensor: true } as const;
    if (world.get(entity, Collider).ok) world.set(entity, Collider, collider);
    else world.addComponent(entity, { component: Collider, data: collider }).unwrap();
    state.active = true;
  };

  const hide = (state: PickupState): void => {
    if (!live(state)) return;
    removeIfPresent(world, state.entity, Collider);
    removeIfPresent(world, state.entity, RigidBody);
    removeIfPresent(world, state.entity, HealthPickup);
    removeIfPresent(world, state.entity, MeshRenderer);
    removeIfPresent(world, state.entity, MeshFilter);
    state.active = false;
  };

  const spawnAuthored = (state: PickupState): EntityHandle => {
    const entity = world.spawn(
      { component: Name, data: { value: state.recipe.name } },
      { component: Transform, data: { pos: state.recipe.pos, quat: state.recipe.quat, scale: state.recipe.scale } },
    ).unwrap();
    if (state.recipe.parent !== undefined) {
      world.addComponent(entity, { component: ChildOf, data: { parent: state.recipe.parent } }).unwrap();
    }
    state.entity = entity;
    return entity;
  };

  const restore = (state: PickupState): void => {
    if (!live(state)) spawnAuthored(state);
    world.set(state.entity, Name, { value: state.recipe.name });
    world.set(state.entity, Transform, { pos: state.recipe.pos, quat: state.recipe.quat, scale: state.recipe.scale });
    if (state.recipe.parent !== undefined) world.set(state.entity, ChildOf, { parent: state.recipe.parent });
    if (!state.recipe.initiallyActive) {
      hide(state);
      return;
    }
    addRuntime(state);
    if (physics?.hasBody(state.entity)) {
      physics.teleport(state.entity, vec3.create(state.recipe.pos[0], state.recipe.pos[1], state.recipe.pos[2]));
    }
  };

  for (const state of states) {
    if (state.recipe.initiallyActive) {
      world.addComponent(state.entity, { component: HealthPickup, data: { authoredLocalId: state.recipe.localId } }).unwrap();
      world.addComponent(state.entity, { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } }).unwrap();
      world.addComponent(state.entity, {
        component: Collider,
        data: { shape: ColliderShapeValue.sphere, radius: PICKUP_SENSOR_RADIUS, isSensor: true },
      }).unwrap();
    } else {
      hide(state);
    }
  }

  return {
    installSystem: (ctx) => {
      physics = ctx.physics;
      world.addSystem(FixedUpdate, {
        name: 'game-health-pickup-collection',
        runIf: inState(GameState, 'Play'),
        after: ['physicsCollisionSync', 'game-player-movement'],
        before: ['game-counterattack'],
        queries: [],
        fn: (_world, _results, commands) => {
          const collisions = world.get(player, CollidingEntities);
          if (!collisions.ok) return;
          for (const state of states) {
            if (!available(state) || !collisions.value.entities.includes(state.entity)) continue;
            if (ctx.physics?.hasBody(state.entity) !== true) continue;
            const health = world.get(player, PlayerHealth);
            const transform = world.get(state.entity, Transform);
            const global = world.get(state.entity, GlobalTransform);
            if (!health.ok || !transform.ok || !global.ok) continue;
            const result = resolveHealthPickupContact({ current: health.value.current, max: health.value.max });
            if (!result.admitted) {
              state.fullHealthContactRefused = true;
              continue;
            }
            const position = [
              global.value.world[12] ?? transform.value.pos[0] ?? 0,
              global.value.world[13] ?? transform.value.pos[1] ?? 0,
              global.value.world[14] ?? transform.value.pos[2] ?? 0,
            ] as const;
            world.set(player, PlayerHealth, { current: result.health });
            state.admittedCollections += 1;
            state.active = false;
            commands.despawn(state.entity);
            ctx.onCollect(result.health, health.value.max, position);
            return;
          }
        },
      }).unwrap();
    },
    activate: (authoredLocalId) => {
      if (disposed) return false;
      const state = states.find((candidate) => candidate.recipe.localId === authoredLocalId);
      if (state === undefined || available(state)) return false;
      if (!live(state)) spawnAuthored(state);
      addRuntime(state);
      return true;
    },
    reset: () => {
      if (disposed) return;
      for (const state of states) {
        state.admittedCollections = 0;
        state.fullHealthContactRefused = false;
        restore(state);
      }
    },
    snapshot: () => {
      const pickups = states.map((state): HealthPickupItemSnapshot => {
        const isLive = live(state);
        const isAvailable = available(state);
        const transform = isAvailable ? world.get(state.entity, GlobalTransform) : undefined;
        const local = isAvailable ? world.get(state.entity, Transform) : undefined;
        const collider = isAvailable ? world.get(state.entity, Collider) : undefined;
        const renderer = isLive ? world.get(state.entity, MeshRenderer) : undefined;
        return {
          authoredLocalId: state.recipe.localId,
          entity: isLive ? state.entity : null,
          available: isAvailable,
          position: transform?.ok === true
            ? [
                transform.value.world[12] ?? (local?.ok === true ? local.value.pos[0] ?? 0 : 0),
                transform.value.world[13] ?? (local?.ok === true ? local.value.pos[1] ?? 0 : 0),
                transform.value.world[14] ?? (local?.ok === true ? local.value.pos[2] ?? 0 : 0),
              ]
            : state.recipe.pos,
          visible: renderer?.ok === true,
          sensor: collider?.ok === true && collider.value.isSensor,
          physicsReady: isAvailable && physics?.hasBody(state.entity) === true,
          admittedCollections: state.admittedCollections,
          deferredDespawns: state.admittedCollections,
          fullHealthContactRefused: state.fullHealthContactRefused,
        };
      });
      return { pickups };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const handle of retainedMeshes) world.sharedRefs.release(handle);
      for (const handle of retainedMaterials) world.sharedRefs.release(handle);
    },
  };
}
