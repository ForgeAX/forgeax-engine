import { type AssetRevisionGuard, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { Entity, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { readComponentMutationEpoch } from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { meshAttributeWindow } from '@forgeax/engine-geometry';
import { GlobalTransform, readPresentationWorldMatrix } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { AssetHandle, MeshAsset, SkeletonAsset } from '@forgeax/engine-types';
import { skeletonDefinitionValid } from '../scene/skin-inputs';
import type { SkinBindingInput } from '../scene/skin-scene-inputs';

/** Match ordinary extraction: a zero Skeleton is a dormant rigid binding. */
export function hasCandidateSkin(world: World, entity: number): boolean {
  const skeleton = world[worldRead].getFieldValue(entity as EntityHandle, Skin, 'skeleton');
  return skeleton !== undefined && skeleton !== 0;
}

/** Candidate validation must not route malformed author input through extraction errors. */
export function readCandidateSkinBinding(
  world: World,
  entity: number,
  mesh: MeshAsset,
): SkinBindingInput | undefined | false {
  if (!hasCandidateSkin(world, entity)) return undefined;
  const reader = world[worldRead],
    owner = entity as EntityHandle;
  const skeleton = reader.getFieldValue(owner, Skin, 'skeleton'),
    count = reader.getArrayLength(owner, Skin, 'joints');
  if (skeleton === undefined || count === undefined || count === 0) return false;
  const joints: number[] = [];
  for (let index = 0; index < count; index++) {
    const joint = reader.getArrayElement(owner, Skin, 'joints', index);
    if (joint === undefined) return false;
    joints.push(joint);
  }
  const affinePoint = reader.getFieldValue(owner, Skin, 'affinePoint');
  const binding = {
    skeleton,
    joints: Object.freeze(joints),
    ...(affinePoint ? { affinePoint: true } : {}),
  };
  return candidateSkinBindingValid(world, entity, mesh, binding) ? binding : false;
}

/** Static membership only. Motion belongs to the ordinary submitted Skin frame. */
export function candidateSkinBindingValid(
  world: World,
  entity: number,
  mesh: MeshAsset,
  binding: SkinBindingInput | undefined,
): boolean {
  const skin = world.get(entity as EntityHandle, Skin);
  if (binding === undefined) return !hasCandidateSkin(world, entity);
  if (!skin.ok || !sameBinding(world, entity, binding)) return false;
  const skeleton = runtimeAssets(world.assets).resolveAsset<SkeletonAsset>(binding.skeleton);
  if (
    !skeleton.ok ||
    skeleton.value.kind !== 'skeleton' ||
    !skeletonDefinitionValid(
      skeleton.value.jointCount,
      skeleton.value.inverseBindMatrices,
      skeleton.value.shadowCapsules,
    ) ||
    skeleton.value.jointCount !== binding.joints.length
  )
    return false;
  // Admission only needs valid joint addresses. Missing culling envelopes
  // (such as for signed or zero weights) leave the draw uncullable.
  const indices = meshAttributeWindow(mesh, 'skinIndex');
  const weights = meshAttributeWindow(mesh, 'skinWeight');
  if (!indices || !weights || indices.count !== weights.count) return false;
  for (let vertex = 0; vertex < indices.count; vertex++) {
    const base = indices.offset + vertex * indices.stride;
    for (let lane = 0; lane < 4; lane++)
      if ((indices.data[base + lane] as number) >= binding.joints.length) return false;
  }
  for (const joint of binding.joints) {
    const matrix = readPresentationWorldMatrix(world, joint as EntityHandle);
    if (matrix === undefined) return false;
    for (let index = 0; index < 16; index++) if (!Number.isFinite(matrix[index])) return false;
  }
  return true;
}

function sameBinding(world: World, entity: number, binding: SkinBindingInput): boolean {
  const reader = world[worldRead],
    owner = entity as EntityHandle;
  if (
    reader.getFieldValue(owner, Skin, 'skeleton') !== binding.skeleton ||
    reader.getArrayLength(owner, Skin, 'joints') !== binding.joints.length ||
    Boolean(reader.getFieldValue(owner, Skin, 'affinePoint')) !== Boolean(binding.affinePoint)
  )
    return false;
  for (let index = 0; index < binding.joints.length; index++) {
    const joint = binding.joints[index] as EntityHandle;
    if (
      reader.getArrayElement(owner, Skin, 'joints', index) !== joint ||
      !world.get(joint, Entity).ok ||
      !world.hasComponent(joint, GlobalTransform)
    )
      return false;
  }
  return true;
}

export interface CandidateSkinGuard {
  isCurrent(): boolean;
  release(): void;
}

/** Preserve a rigid candidate's absence proof until its first pipeline capture. */
export function captureInitialCandidateSkinGuard(
  world: World,
  entity: number,
): { readonly skin?: CandidateSkinGuard } {
  const skin = hasCandidateSkin(world, entity)
    ? undefined
    : captureCandidateSkinGuard(world, entity, undefined);
  return skin === undefined ? {} : { skin };
}

/** Hold the exact Skeleton revision until the candidate's physical release fence. */
export function captureCandidateSkinGuard(
  world: World,
  entity: number,
  binding: SkinBindingInput | undefined,
): CandidateSkinGuard | undefined {
  if (binding === undefined)
    return {
      isCurrent: () => !hasCandidateSkin(world, entity),
      release() {},
    };
  const assets = runtimeAssets(world.assets),
    handle = binding.skeleton as AssetHandle<'skeleton'>;
  if (!sameBinding(world, entity, binding)) return undefined;
  const retained = assets.retain(handle);
  if (!retained.ok) return undefined;
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    assets.release(handle).unwrap();
  };
  let revision: AssetRevisionGuard | undefined;
  try {
    const captured = assets.captureRevision(handle);
    if (!captured.ok) {
      release();
      return undefined;
    }
    revision = captured.value;
    let active = true;
    let skins = readComponentMutationEpoch(world, Skin),
      structure = world.getStructureEpoch();
    let current = true;
    return {
      isCurrent() {
        if (!active || !current || !captured.value.matchesCurrent()) return false;
        const nextSkins = readComponentMutationEpoch(world, Skin),
          nextStructure = world.getStructureEpoch();
        if (nextSkins !== skins || nextStructure !== structure) {
          current = sameBinding(world, entity, binding);
          skins = nextSkins;
          structure = nextStructure;
        }
        return current;
      },
      release() {
        if (!active) return;
        active = false;
        captured.value.dispose();
        release();
      },
    };
  } catch (cause) {
    revision?.dispose();
    release();
    throw cause;
  }
}
