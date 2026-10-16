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
import { Name, Transform } from '@forgeax/engine-scene';
import { inState } from '@forgeax/engine-state';
import type { Handle } from '@forgeax/engine-types';
import { GameState } from './gameplay-state';

const CORE_SENSOR_RADIUS = 0.58;
const BEACON_SENSOR_RADIUS = 0.9;
const ACTIVE_BEACON_SCALE = 1.55;

/** Runtime projection marker for one uniquely authored EnergyCore. */
export const EnergyCore = defineComponent('GameDefaultEnergyCore', {
  authoredLocalId: 'u32',
  rosterIndex: 'u32',
}, { transient: true });

/** The single ECS authority for extraction progress and beacon admission. */
export const ExtractionObjective = defineComponent('GameDefaultExtractionObjective', {
  total: 'u32',
  collectedMask: 'u32',
  wrongContactMask: 'u32',
  unlocked: 'u32',
  active: 'u32',
  beaconOccupied: 'u32',
  refusedContacts: 'u32',
  victoryRequests: 'u32',
}, { transient: true });

export type AuthoredEnergyCoreIdentity = {
  readonly entity: EntityHandle;
  readonly localId: number;
};

export type AuthoredExtractionIdentity = {
  readonly cores: readonly AuthoredEnergyCoreIdentity[];
  readonly beacon: AuthoredEnergyCoreIdentity;
};

export type ExtractionProgress = {
  readonly collected: number;
  readonly total: number;
  readonly active: boolean;
};

export function deriveExtractionProgress(collectedMask: number, total: number): ExtractionProgress {
  const boundedTotal = Math.max(0, Math.min(31, Math.floor(total)));
  const rosterMask = boundedTotal === 0 ? 0 : (2 ** boundedTotal) - 1;
  let bits = collectedMask & rosterMask;
  let collected = 0;
  while (bits !== 0) {
    bits &= bits - 1;
    collected += 1;
  }
  return { collected, total: boundedTotal, active: boundedTotal > 0 && collected === boundedTotal };
}

export function resolveEnergyCoreContacts(
  colliding: ReadonlyArray<number> | Uint32Array,
  roster: ReadonlyMap<number, number>,
  collectedMask: number,
): { readonly collectedMask: number; readonly admitted: readonly number[] } {
  let nextMask = collectedMask;
  const admitted: number[] = [];
  for (const entity of colliding) {
    const index = roster.get(entity);
    if (index === undefined) continue;
    const bit = 2 ** index;
    if ((nextMask & bit) !== 0) continue;
    nextMask |= bit;
    admitted.push(entity);
  }
  return { collectedMask: nextMask, admitted };
}

type AuthoredRecipe = {
  readonly localId: number;
  readonly name: string;
  readonly pos: readonly [number, number, number];
  readonly quat: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
  readonly mesh: Handle<'MeshAsset', 'shared'>;
  readonly materials: readonly Handle<'MaterialAsset', 'shared'>[];
};

export type EnergyCoreSnapshot = {
  readonly authoredLocalId: number;
  readonly entity: number | null;
  readonly available: boolean;
  readonly position: readonly [number, number, number];
  readonly sensor: boolean;
  readonly physicsReady: boolean;
};

export type EnergyCoreExtractionSnapshot = ExtractionProgress & {
  readonly status: 'locked' | 'collecting' | 'ready';
  readonly collectedMask: number;
  readonly wrongContacts: number;
  readonly refusedContacts: number;
  readonly victoryRequests: number;
  readonly deferredDespawns: number;
  readonly cores: readonly EnergyCoreSnapshot[];
  readonly beacon: EnergyCoreSnapshot & { readonly activeVisual: boolean };
};

export type EnergyCoreExtractionHandle = {
  readonly installSystem: (ctx: {
    readonly physics: PhysicsWorld | undefined;
    readonly isUnlocked: () => boolean;
    readonly canExtract: () => boolean;
    readonly requestVictory: () => void;
    readonly onCollect: (progress: ExtractionProgress, position: readonly [number, number, number]) => void;
    readonly onRefuse: (progress: ExtractionProgress, position: readonly [number, number, number]) => void;
    readonly onRewardRequired: (position: readonly [number, number, number]) => void;
    readonly onActivate: (progress: ExtractionProgress, position: readonly [number, number, number]) => void;
    readonly onProgress: (snapshot: EnergyCoreExtractionSnapshot) => void;
  }) => void;
  readonly reset: () => void;
  readonly snapshot: () => EnergyCoreExtractionSnapshot;
  readonly dispose: () => void;
};

function recipeFrom(world: World, identity: AuthoredEnergyCoreIdentity): AuthoredRecipe | undefined {
  const transform = world.get(identity.entity, Transform);
  const mesh = world.get(identity.entity, MeshFilter);
  const renderer = world.get(identity.entity, MeshRenderer);
  const name = world.get(identity.entity, Name);
  if (!transform.ok || !mesh.ok || !renderer.ok || !name.ok) return undefined;
  return {
    localId: identity.localId,
    name: name.value.value,
    pos: [transform.value.pos[0] ?? 0, transform.value.pos[1] ?? 0, transform.value.pos[2] ?? 0],
    quat: [transform.value.quat[0] ?? 0, transform.value.quat[1] ?? 0, transform.value.quat[2] ?? 0, transform.value.quat[3] ?? 1],
    scale: [transform.value.scale[0] ?? 1, transform.value.scale[1] ?? 1, transform.value.scale[2] ?? 1],
    mesh: mesh.value.assetHandle as Handle<'MeshAsset', 'shared'>,
    materials: [...renderer.value.materials] as Handle<'MaterialAsset', 'shared'>[],
  };
}

/** Compose authored core and beacon identities into one reset-safe extraction owner. */
export function createEnergyCoreExtraction(
  world: World,
  player: EntityHandle,
  authored: AuthoredExtractionIdentity,
): EnergyCoreExtractionHandle | undefined {
  const ordered = [...authored.cores].sort((a, b) => a.localId - b.localId);
  const coreRecipes = ordered.map((identity) => recipeFrom(world, identity));
  const beaconRecipe = recipeFrom(world, authored.beacon);
  if (ordered.length !== 3 || coreRecipes.some((recipe) => recipe === undefined) || beaconRecipe === undefined) return undefined;
  const recipes = coreRecipes as AuthoredRecipe[];
  const retained: Array<{ readonly mesh: Handle<'MeshAsset', 'shared'>; readonly materials: readonly Handle<'MaterialAsset', 'shared'>[] }> = [];
  for (const recipe of [...recipes, beaconRecipe]) {
    if (!world.sharedRefs.retain(recipe.mesh).ok) continue;
    const materials = recipe.materials.filter((material) => world.sharedRefs.retain(material).ok);
    retained.push({ mesh: recipe.mesh, materials });
  }

  const coreEntities = new Map<number, EntityHandle>(ordered.map((identity) => [identity.localId, identity.entity]));
  let beaconEntity = authored.beacon.entity;
  let physics: PhysicsWorld | undefined;
  let disposed = false;

  const attachCore = (entity: EntityHandle, recipe: AuthoredRecipe, index: number): void => {
    world.addComponent(entity, { component: EnergyCore, data: { authoredLocalId: recipe.localId, rosterIndex: index } }).unwrap();
    world.addComponent(entity, { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } }).unwrap();
    world.addComponent(entity, {
      component: Collider,
      data: { shape: ColliderShapeValue.sphere, radius: CORE_SENSOR_RADIUS, isSensor: true },
    }).unwrap();
    world.addComponent(entity, { component: CollidingEntities, data: { entities: [] } }).unwrap();
  };
  const attachBeacon = (entity: EntityHandle): void => {
    world.addComponent(entity, {
      component: ExtractionObjective,
      data: {
        total: recipes.length,
        collectedMask: 0,
        wrongContactMask: 0,
        unlocked: 0,
        active: 0,
        beaconOccupied: 0,
        refusedContacts: 0,
        victoryRequests: 0,
      },
    }).unwrap();
    world.addComponent(entity, { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } }).unwrap();
    world.addComponent(entity, {
      component: Collider,
      data: { shape: ColliderShapeValue.sphere, radius: BEACON_SENSOR_RADIUS, isSensor: true },
    }).unwrap();
  };
  const spawn = (recipe: AuthoredRecipe): EntityHandle => world.spawn(
    { component: Name, data: { value: recipe.name } },
    { component: Transform, data: { pos: recipe.pos, quat: recipe.quat, scale: recipe.scale } },
    { component: MeshFilter, data: { assetHandle: recipe.mesh } },
    { component: MeshRenderer, data: { materials: recipe.materials } },
  ).unwrap();
  const objective = () => world.get(beaconEntity, ExtractionObjective);
  const positionOf = (entity: EntityHandle, recipe: AuthoredRecipe): readonly [number, number, number] => {
    const transform = world.get(entity, Transform);
    return transform.ok
      ? [transform.value.pos[0] ?? 0, transform.value.pos[1] ?? 0, transform.value.pos[2] ?? 0]
      : recipe.pos;
  };
  const liveRoster = (): Map<number, number> => {
    const roster = new Map<number, number>();
    for (let index = 0; index < recipes.length; index++) {
      const recipe = recipes[index];
      if (recipe === undefined) continue;
      const entity = coreEntities.get(recipe.localId);
      if (entity !== undefined && world.get(entity, EnergyCore).ok) roster.set(entity, index);
    }
    return roster;
  };

  for (let index = 0; index < recipes.length; index++) {
    const recipe = recipes[index];
    const entity = recipe === undefined ? undefined : coreEntities.get(recipe.localId);
    if (recipe !== undefined && entity !== undefined) attachCore(entity, recipe, index);
  }
  attachBeacon(beaconEntity);

  const reset = (): void => {
    if (disposed) return;
    for (let index = 0; index < recipes.length; index++) {
      const recipe = recipes[index];
      if (recipe === undefined) continue;
      let entity = coreEntities.get(recipe.localId);
      if (entity === undefined || !world.get(entity, EnergyCore).ok) {
        entity = spawn(recipe);
        coreEntities.set(recipe.localId, entity);
        attachCore(entity, recipe, index);
      } else {
        world.set(entity, Name, { value: recipe.name });
        world.set(entity, Transform, { pos: recipe.pos, quat: recipe.quat, scale: recipe.scale });
        world.set(entity, MeshFilter, { assetHandle: recipe.mesh });
        world.set(entity, MeshRenderer, { materials: recipe.materials });
        world.set(entity, EnergyCore, { authoredLocalId: recipe.localId, rosterIndex: index });
        world.set(entity, RigidBody, { type: RigidBodyTypeValue.kinematic });
        world.set(entity, Collider, { shape: ColliderShapeValue.sphere, radius: CORE_SENSOR_RADIUS, isSensor: true });
      }
      if (physics?.hasBody(entity)) physics.teleport(entity, vec3.create(recipe.pos[0], recipe.pos[1], recipe.pos[2]));
    }
    world.set(beaconEntity, Name, { value: beaconRecipe.name });
    world.set(beaconEntity, Transform, { pos: beaconRecipe.pos, quat: beaconRecipe.quat, scale: beaconRecipe.scale });
    world.set(beaconEntity, MeshFilter, { assetHandle: beaconRecipe.mesh });
    world.set(beaconEntity, MeshRenderer, { materials: beaconRecipe.materials });
    world.set(beaconEntity, ExtractionObjective, {
      total: recipes.length,
      collectedMask: 0,
      wrongContactMask: 0,
      unlocked: 0,
      active: 0,
      beaconOccupied: 0,
      refusedContacts: 0,
      victoryRequests: 0,
    });
    world.set(beaconEntity, RigidBody, { type: RigidBodyTypeValue.kinematic });
    world.set(beaconEntity, Collider, { shape: ColliderShapeValue.sphere, radius: BEACON_SENSOR_RADIUS, isSensor: true });
    if (physics?.hasBody(beaconEntity)) physics.teleport(beaconEntity, vec3.create(beaconRecipe.pos[0], beaconRecipe.pos[1], beaconRecipe.pos[2]));
  };

  const snapshotCore = (recipe: AuthoredRecipe, entity: EntityHandle | undefined): EnergyCoreSnapshot => {
    const available = entity !== undefined && world.get(entity, EnergyCore).ok;
    const collider = available ? world.get(entity, Collider) : undefined;
    return {
      authoredLocalId: recipe.localId,
      entity: available ? entity : null,
      available,
      position: entity === undefined ? recipe.pos : positionOf(entity, recipe),
      sensor: collider?.ok === true && collider.value.isSensor,
      physicsReady: available && physics?.hasBody(entity) === true,
    };
  };
  const snapshot = (): EnergyCoreExtractionSnapshot => {
    const state = objective();
    const value = state.ok ? state.value : {
      total: recipes.length, collectedMask: 0, wrongContactMask: 0, unlocked: 0,
      active: 0, refusedContacts: 0, victoryRequests: 0,
    };
    const progress = deriveExtractionProgress(value.collectedMask, value.total);
    const beaconTransform = world.get(beaconEntity, Transform);
    const beaconCollider = world.get(beaconEntity, Collider);
    return {
      ...progress,
      status: value.unlocked === 0 ? 'locked' : progress.active ? 'ready' : 'collecting',
      collectedMask: value.collectedMask,
      wrongContacts: deriveExtractionProgress(value.wrongContactMask, value.total).collected,
      refusedContacts: value.refusedContacts,
      victoryRequests: value.victoryRequests,
      deferredDespawns: progress.collected,
      cores: recipes.map((recipe) => snapshotCore(recipe, coreEntities.get(recipe.localId))),
      beacon: {
        authoredLocalId: beaconRecipe.localId,
        entity: world.get(beaconEntity, ExtractionObjective).ok ? beaconEntity : null,
        available: world.get(beaconEntity, ExtractionObjective).ok,
        position: positionOf(beaconEntity, beaconRecipe),
        sensor: beaconCollider.ok && beaconCollider.value.isSensor,
        physicsReady: physics?.hasBody(beaconEntity) === true,
        activeVisual: progress.active && beaconTransform.ok
          && Math.abs((beaconTransform.value.scale[0] ?? 0) - beaconRecipe.scale[0] * ACTIVE_BEACON_SCALE) < 1e-5,
      },
    };
  };

  return {
    installSystem: (ctx) => {
      physics = ctx.physics;
      world.addSystem(FixedUpdate, {
        name: 'game-energy-core-extraction',
        runIf: inState(GameState, 'Play'),
        after: ['physicsCollisionSync', 'game-player-movement', 'game-health-pickup-collection'],
        before: ['game-counterattack'],
        queries: [],
        fn: (_world, _results, commands) => {
          const state = objective();
          if (!state.ok) return;
          let next = { ...state.value, unlocked: ctx.isUnlocked() ? 1 : 0 };
          const roster = liveRoster();
          for (const [entity, index] of roster) {
            const contacts = world.get(entity as EntityHandle, CollidingEntities);
            if (!contacts.ok) continue;
            for (const contact of contacts.value.entities) {
              if (contact !== player) next.wrongContactMask |= 2 ** index;
            }
          }

          const collisions = world.get(player, CollidingEntities);
          const colliding: ReadonlyArray<number> | Uint32Array = collisions.ok
            ? collisions.value.entities
            : [];
          const wasActive = next.active !== 0;
          if (next.unlocked !== 0) {
            const resolved = resolveEnergyCoreContacts(colliding, roster, next.collectedMask);
            next.collectedMask = resolved.collectedMask;
            for (const admitted of resolved.admitted) {
              const index = roster.get(admitted);
              const recipe = index === undefined ? undefined : recipes[index];
              if (recipe === undefined || ctx.physics?.hasBody(admitted as EntityHandle) !== true) continue;
              commands.despawn(admitted as EntityHandle);
              ctx.onCollect(deriveExtractionProgress(next.collectedMask, next.total), positionOf(admitted as EntityHandle, recipe));
            }
          }

          const progress = deriveExtractionProgress(next.collectedMask, next.total);
          if (progress.active && next.active === 0) {
            next.active = 1;
            world.set(beaconEntity, Transform, {
              scale: [
                beaconRecipe.scale[0] * ACTIVE_BEACON_SCALE,
                beaconRecipe.scale[1] * ACTIVE_BEACON_SCALE,
                beaconRecipe.scale[2] * ACTIVE_BEACON_SCALE,
              ],
            });
            ctx.onActivate(progress, positionOf(beaconEntity, beaconRecipe));
          }

          const onBeacon = colliding.includes(beaconEntity) && ctx.physics?.hasBody(beaconEntity) === true;
          const enteredBeacon = onBeacon && next.beaconOccupied === 0;
          if (next.unlocked !== 0 && enteredBeacon) {
            if (!progress.active) {
              next.refusedContacts += 1;
              ctx.onRefuse(progress, positionOf(beaconEntity, beaconRecipe));
            } else if (!ctx.canExtract()) {
              next.refusedContacts += 1;
              ctx.onRewardRequired(positionOf(beaconEntity, beaconRecipe));
            } else if (wasActive) {
              next.victoryRequests += 1;
              ctx.requestVictory();
            }
          }
          next.beaconOccupied = onBeacon ? 1 : 0;
          world.set(beaconEntity, ExtractionObjective, next);
          ctx.onProgress(snapshot());
        },
      }).unwrap();
    },
    reset,
    snapshot,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const item of retained) {
        world.sharedRefs.release(item.mesh);
        for (const material of item.materials) world.sharedRefs.release(material);
      }
    },
  };
}
