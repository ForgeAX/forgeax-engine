import type { AssetHandle } from '@forgeax/engine-types';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { MeshRenderer } from '@forgeax/engine-render';
import { Rotatable } from './rotating-target';
import { TARGET_PROFILE } from './target-profile-decoder';
import {
  GAME_DEFAULT_TARGET_PROFILE_GUID,
  type TargetProfile,
} from './target-profile-asset';

export type TargetProfileSnapshot = {
  readonly available: boolean;
  readonly active: 'original' | 'profile';
  readonly precisionHits: number;
  readonly precisionComplete: boolean;
  readonly title: string | null;
  readonly scoreMultiplier: number;
  readonly rotationSpeed: number;
  readonly swaps: number;
  readonly guid: string | null;
  readonly baseColor: readonly [number, number, number, number] | null;
};

export type TargetProfileLoop = {
  readonly entity: EntityHandle;
  readonly originalMaterials: readonly AssetHandle<'material'>[];
  readonly profileMaterials: readonly AssetHandle<'material'>[];
  readonly profile: TargetProfile;
  readonly originalRotationSpeed: number | null;
  active: 'original' | 'profile';
  precisionHits: number;
  swaps: number;
};

function cloneWithProfile(
  assets: AssetRegistry,
  source: AssetHandle<'material'>,
  color: readonly [number, number, number, number],
): AssetHandle<'material'> | undefined {
  const copied = assets.copy(source);
  if (!copied.ok) return undefined;
  const updated = assets.update(copied.value, { values: { baseColor: [...color] } });
  if (updated.ok) return copied.value;
  assets.release(copied.value).unwrap();
  return undefined;
}

function setRotationSpeed(world: World, entity: EntityHandle, speed: number): void {
  if (world.get(entity, Rotatable).ok) {
    world.set(entity, Rotatable, { speed });
  } else {
    world.addComponent(entity, { component: Rotatable, data: { speed } }).unwrap();
  }
}

export async function createTargetProfileLoop(
  world: World,
  assets: AssetRegistry | undefined,
  entity: EntityHandle | undefined,
): Promise<TargetProfileLoop | undefined> {
  if (assets === undefined || entity === undefined) return undefined;
  const renderer = world.get(entity, MeshRenderer);
  if (!renderer.ok || renderer.value.materials.length === 0) return undefined;
  const guid = AssetGuid.parse(GAME_DEFAULT_TARGET_PROFILE_GUID);
  if (!guid.ok) return undefined;
  const loaded = await assets.load(guid.value, TARGET_PROFILE);
  if (!loaded.ok) {
    console.warn(`[game] target profile unavailable: ${loaded.error.code} — ${loaded.error.hint}`);
    return undefined;
  }
  const profile = assets.read(loaded.value).unwrap();
  assets.release(loaded.value).unwrap();
  const profileMaterials: AssetHandle<'material'>[] = [];
  for (const material of renderer.value.materials) {
    const clone = cloneWithProfile(assets, material, profile.baseColor);
    if (clone === undefined) {
      for (const material of profileMaterials) assets.release(material).unwrap();
      return undefined;
    }
    profileMaterials.push(clone);
  }
  const originalRotation = world.get(entity, Rotatable);
  return {
    entity,
    originalMaterials: [...renderer.value.materials],
    profileMaterials,
    profile,
    originalRotationSpeed: originalRotation.ok ? originalRotation.value.speed : null,
    active: 'original',
    precisionHits: 0,
    swaps: 0,
  };
}

export function toggleTargetProfile(world: World, state: TargetProfileLoop): void {
  state.active = state.active === 'original' ? 'profile' : 'original';
  state.precisionHits = 0;
  state.swaps += 1;
  world.set(state.entity, MeshRenderer, {
    materials: [...(state.active === 'profile' ? state.profileMaterials : state.originalMaterials)],
  });
  if (state.active === 'profile') {
    setRotationSpeed(world, state.entity, state.profile.rotationSpeed);
  } else if (state.originalRotationSpeed === null) {
    if (world.get(state.entity, Rotatable).ok) world.removeComponent(state.entity, Rotatable).unwrap();
  } else {
    setRotationSpeed(world, state.entity, state.originalRotationSpeed);
  }
}

export function resetTargetProfile(world: World, state: TargetProfileLoop | undefined): void {
  if (state === undefined) return;
  state.precisionHits = 0;
  if (state.active === 'original') return;
  state.active = 'original';
  world.set(state.entity, MeshRenderer, { materials: [...state.originalMaterials] });
  if (state.originalRotationSpeed === null) {
    if (world.get(state.entity, Rotatable).ok) world.removeComponent(state.entity, Rotatable).unwrap();
  } else {
    setRotationSpeed(world, state.entity, state.originalRotationSpeed);
  }
}

/** Record only a real projectile hit on the active profile target. */
export function recordTargetProfileHit(state: TargetProfileLoop | undefined, entity: EntityHandle): boolean {
  if (state?.active !== 'profile' || state.entity !== entity) return false;
  state.precisionHits += 1;
  return true;
}

export function targetProfileSnapshot(state: TargetProfileLoop | undefined): TargetProfileSnapshot {
  if (state === undefined) {
    return {
      available: false,
      active: 'original',
      precisionHits: 0,
      precisionComplete: false,
      title: null,
      scoreMultiplier: 1,
      rotationSpeed: 0,
      swaps: 0,
      guid: null,
      baseColor: null,
    };
  }
  return {
    available: true,
    active: state.active,
    precisionHits: state.precisionHits,
    precisionComplete: state.active === 'profile' && state.precisionHits > 0,
    title: state.profile.title,
    scoreMultiplier: state.profile.scoreMultiplier,
    rotationSpeed: state.profile.rotationSpeed,
    swaps: state.swaps,
    guid: GAME_DEFAULT_TARGET_PROFILE_GUID,
    baseColor: state.profile.baseColor,
  };
}

export function targetProfilePoints(state: TargetProfileLoop | undefined, points: number): number {
  return state?.active === 'profile' ? Math.round(points * state.profile.scoreMultiplier) : points;
}
