// apps/collectathon -- player assembly with parent/child separation (AC-04, D-1).
//
// The player is TWO entities, not one, because two systems each want to own a
// Transform writer and they would conflict on a single entity:
//
//   parent (KCC physics):  RigidBody(kinematic) + Collider(capsule) +
//                          CharacterController + Transform
//     -> player-move writes parent Transform.local via PhysicsWorld.moveAndSlide
//
//   child  (skinned mesh): the humanoid.fbx scene root, carrying Skin +
//                          AnimationPlayer on its Skin-bearing descendant, and
//                          ChildOf(parent) on the scene root
//     -> advanceAnimationPlayer writes the child's joint Transforms
//     -> propagateTransforms derives the child's world mat4 from parent.world
//
// The child NEVER writes Transform.local.position to chase the parent and there
// is NO second position cache (no *PositionCache field): the child's world
// placement is purely derived through ChildOf + propagateTransforms (AC-04
// review anchor). The only Transform pos writes here are the parent spawn pose and the
// child's authored local offset (cm->world scale + feet drop) -- never a
// per-frame parent-follow copy.

import {
  AnimationPlayer,
  AnimationTargetId,
  bindAnimationTargets,
} from '@forgeax/engine-animation';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ENTITY_NULL_RAW, type EntityHandle, type World } from '@forgeax/engine-ecs';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  CollidingEntities,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { MeshRenderer, SceneInstance } from '@forgeax/engine-render';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { Handle, MaterialAsset, SceneAsset } from '@forgeax/engine-types';

import { PLAYER_GROUPS } from '../collision-groups';

// Capsule character dims (matches apps/hello/character KCC tuning):
// radius 0.3 + halfHeight 0.5 -> half-total 0.8. The capsule rests with its
// center at PLAYER_SPAWN_Y so the body sits cleanly on the ground (y=0 top).
export const CHAR_RADIUS = 0.3;
export const CHAR_HALF_HEIGHT = 0.5;
export const CHAR_HALF_TOTAL = CHAR_RADIUS + CHAR_HALF_HEIGHT;
// Ground top sits at y=0 (the M2 ground plane / M3 cuboid top). The capsule
// center rests one half-total above so the KCC has a clean contact.
export const PLAYER_SPAWN_Y = CHAR_HALF_TOTAL;

// humanoid.fbx is authored in centimeters (~150 unit body height). The level is
// ~30m, character target ~1.7m, so scale cm->world by ~1/90 to land the body
// near 1.7 world units. Exposed as a constant per plan D-3.
export const FBX_CM_TO_WORLD_SCALE = 1 / 90;

// The skinned mesh's local origin sits at the FBX feet; drop it by the capsule
// half-total so the visual feet align with the capsule's lower cap rather than
// its center.
const CHILD_FEET_OFFSET_Y = -CHAR_HALF_TOTAL;

type ClipHandle = Handle<'AnimationClip', 'shared'>;
type SceneHandle = Handle<'SceneAsset', 'shared'>;

export interface PlayerHandles {
  /** KCC parent entity -- player-move drives this Transform via moveAndSlide. */
  readonly parent: EntityHandle;
  /** Scene root carrying AnimationPlayer for the complete imported target subtree. */
  readonly animationPlayer: EntityHandle;
  /** Skin-bearing descendant used by the renderer. */
  readonly skin: EntityHandle;
  /** Scene root entity (ChildOf parent) -- the visual hierarchy follow point. */
  readonly sceneRoot: EntityHandle;
}

export type SpawnPlayerResult =
  | { readonly ok: true; readonly value: PlayerHandles }
  | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string } };

/**
 * Spawn the player parent/child pair.
 *
 * @param world owning World
 * @param assets the App-owned AssetRegistry -- used to
 *   instantiate the humanoid scene hierarchy
 * @param sceneHandle a user-tier SceneAsset handle for humanoid.fbx (minted via
 *   world.allocSharedRef after assets.loadByGuid in main.ts)
 * @param locomotionClip the run clip handle, played on the AnimationPlayer slots
 * @param spawnXZ planar spawn position; the parent rests at PLAYER_SPAWN_Y
 */
export function spawnPlayer(
  world: World,
  assets: AssetRegistry,
  sceneHandle: SceneHandle,
  locomotionClip: ClipHandle,
  spawnXZ: { readonly x: number; readonly z: number } = { x: 0, z: 0 },
): SpawnPlayerResult {
  // 1. KCC parent: kinematic capsule + CharacterController. player-move resolves
  //    moveAndSlide against the world and writes this entity's Transform.local.
  const parentRes = world.spawn(
    {
      component: Transform,
      data: { pos: [spawnXZ.x, PLAYER_SPAWN_Y, spawnXZ.z] },
    },
    { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
    {
      component: Collider,
      data: {
        shape: ColliderShapeValue.capsule,
        radius: CHAR_RADIUS,
        halfHeight: CHAR_HALF_HEIGHT,
        // The player is the only entity Core/Guardian/Portal sensors react to.
        // Without an explicit group the collider defaults to collisionGroups=0
        // (membership 0 / filter 0), which under Rapier's interaction rule
        // `(A.membership & B.filter) && (B.membership & A.filter)` overlaps
        // NOTHING -- every pickup/hit/portal sensor silently misses. PLAYER_GROUPS
        // makes it a PLAYER member that filters LEVEL+CORE+GUARDIAN+PORTAL.
        collisionGroups: PLAYER_GROUPS,
      },
    },
    { component: CharacterController, data: {} },
    // CollidingEntities is REQUIRED for the player to receive overlap writeback:
    // writebackCollidingEntities skips entities that do not already carry the
    // component, so core-collect / guardian-hit / portal-activate / win-lose all
    // read an empty {ok:false} set without it. Spawn it empty; the physics tick
    // fills it each frame.
    { component: CollidingEntities, data: { entities: [] } },
  );
  if (!parentRes.ok) {
    return { ok: false, error: { code: parentRes.error.code, hint: 'player parent spawn failed' } };
  }
  const parent = parentRes.value;

  // 2. Child visual: instantiate the humanoid scene. instantiate returns the
  //    synthetic scene root; the Skin entity is a descendant found via mapping.
  const instRes = assets.instantiate<SceneAsset>(sceneHandle, world);
  if (!instRes.ok) {
    return {
      ok: false,
      error: { code: instRes.error.code, hint: 'humanoid scene instantiate failed' },
    };
  }
  const sceneRoot = instRes.value;

  // Scale the scene root local (cm->world) and drop to the capsule feet. The
  // root's world is then parent.world x root.local through ChildOf, so the
  // visual rig rigid-follows the KCC parent without a position cache.
  world.set(sceneRoot, Transform, {
    pos: [0, CHILD_FEET_OFFSET_Y, 0],
    scale: [FBX_CM_TO_WORLD_SCALE, FBX_CM_TO_WORLD_SCALE, FBX_CM_TO_WORLD_SCALE],
  });

  // 3. Parent the scene root under the KCC parent. propagateTransforms (auto-
  //    registered by createApp) derives the child world mat4 each frame.
  world.addComponent(sceneRoot, { component: ChildOf, data: { parent } });

  // 4. Find the Skin-bearing descendant and attach the AnimationPlayer. Two
  //    slots: slot 0 = locomotion (run, speed 1), slot 1 = idle (same run clip
  //    held at speed 0). Spawn pose is idle (weights=[0,1]); player-anim
  //    crossfades the weights per frame.
  const skinRes = collectAnimationTargets(world, sceneRoot);
  if (!skinRes.ok) {
    return {
      ok: false,
      error: { code: 'asset-not-registered', hint: 'no Skin entity in humanoid scene' },
    };
  }
  const skin = skinRes.value;
  world.addComponent(sceneRoot, {
    component: AnimationPlayer,
    data: {
      clips: [locomotionClip, locomotionClip],
      times: [0, 0],
      weights: [0, 1],
      speeds: [1, 0],
    },
  });
  const bound = bindAnimationTargets(world, sceneRoot, skinRes.targets);
  if (!bound.ok) {
    return { ok: false, error: { code: bound.error.code, hint: bound.error.hint } };
  }

  // Override the humanoid's default grey FBX material with a vivid protagonist
  // colour. humanoid.fbx ships a flat mid-grey material that is invisible against
  // the grey ground + skybox (the level reads grey-on-grey). A saturated cyan
  // makes the player read clearly against the grey level and the warm (gold Core
  // / red Portal) accents. The replacement MUST keep the `forgeax::pbr-skin`
  // shader -- a skinned mesh entity fail-fasts (skin-material-mismatch) on a
  // plain `forgeax::default-standard-pbr` material, so Materials.standard() is
  // wrong here; the material is hand-built with the skin Forward pass.
  //
  // Single Forward pass, matching the FBX cooker default (to-asset-pack.ts) and
  // the working apps/hello/fbx-skin reference. The app runs URP (forward), whose
  // main pass selector is {LightMode:['Forward']}. world.set replaces the
  // MeshRenderer material list on the Skin-bearing descendant.
  const playerMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::pbr-skin' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [0.1, 0.6, 0.85, 1], metallic: 0.05, roughness: 0.55 },
  });
  world.set(skin, MeshRenderer, { materials: [playerMat] });

  return { ok: true, value: { parent, animationPlayer: sceneRoot, skin, sceneRoot } };
}

// Walk the SceneInstance mapping to find the first entity carrying Skin.
function collectAnimationTargets(
  world: World,
  sceneRoot: EntityHandle,
): { ok: true; value: EntityHandle; targets: readonly EntityHandle[] } | { ok: false } {
  const inst = world.get(sceneRoot, SceneInstance);
  if (!inst.ok) return { ok: false };
  let skin: EntityHandle | undefined;
  const targets: EntityHandle[] = [];
  for (const entRaw of inst.value.mapping) {
    if (entRaw === undefined || entRaw === ENTITY_NULL_RAW) continue;
    const ent = entRaw as EntityHandle;
    if (world.get(ent, AnimationTargetId).ok) targets.push(ent);
    if (skin === undefined && world.get(ent, Skin).ok) skin = ent;
  }
  return skin === undefined ? { ok: false } : { ok: true, value: skin, targets };
}
