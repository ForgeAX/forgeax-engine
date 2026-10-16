import {
  resolveAssetHandle,
  walkMaterialPassesOverSharedRefs,
} from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { readRenderArrayView } from '@forgeax/engine-ecs/projection';
import { mat4, vec3 } from '@forgeax/engine-math';
import { GlobalTransform } from '@forgeax/engine-scene';
import { type SamplerAsset, type TextureAsset, toShared } from '@forgeax/engine-types';
import { deriveRenderDataTexture } from '../render-data';
import {
  collectAuthoredMaterialSamplerFields,
  collectAuthoredMaterialTextureFields,
  type MaterialSnapshot,
  type PreparedExtractContext,
  resolveMaterialSnapshot,
} from '../render-system-extract';
import { ProjectedDecal, ProjectedDecalInvalidError } from './component';

export const MAX_PROJECTED_DECALS = 64;
export const DECAL_TEXTURE_FIELDS = [
  'baseColorTexture',
  'normalTexture',
  'roughnessTexture',
] as const;

export interface ProjectedDecalSnapshot {
  readonly entityKey: number;
  readonly worldId: number;
  readonly transform: Float32Array;
  readonly inverse: Float32Array;
  readonly material: MaterialSnapshot;
  readonly textures: readonly (TextureAsset | undefined)[];
  readonly samplers: readonly (SamplerAsset | undefined)[];
  readonly order: number;
  readonly opacity: number;
  readonly normalThreshold: number;
  readonly colorOpacity: number;
  readonly normalOpacity: number;
  readonly roughnessOpacity: number;
}

/** Detached source facts; no World or asset lookup is retained by the graph. */
export function extractProjectedDecals(
  world: World,
  context: PreparedExtractContext,
): ProjectedDecalSnapshot[] {
  const result: ProjectedDecalSnapshot[] = [];
  const query = world.query({ read: [ProjectedDecal] }).unwrap();
  for (const row of query) {
    if (context.visibility.effective(row.entity) === 'hidden') continue;
    const data = row.get(ProjectedDecal);
    for (const field of [
      'opacity',
      'colorOpacity',
      'normalOpacity',
      'roughnessOpacity',
      'normalThreshold',
    ] as const) {
      const minimum = field === 'normalThreshold' ? -1 : 0;
      if (!Number.isFinite(data[field]) || data[field] < minimum || data[field] > 1)
        throw new ProjectedDecalInvalidError(field, `a finite number in [${minimum}, 1]`);
    }
    if (
      data.opacity === 0 ||
      (data.colorOpacity === 0 && data.normalOpacity === 0 && data.roughnessOpacity === 0)
    )
      continue;
    const raw = readRenderArrayView(world, row.entity, GlobalTransform, 'world');
    if (raw === undefined)
      throw new ProjectedDecalInvalidError('transform', 'a propagated world transform');
    const transform = new Float32Array(raw);
    const basis = [0, 4, 8].map((offset) => transform.subarray(offset, offset + 3));
    const x = basis[0] as Float32Array;
    const y = basis[1] as Float32Array;
    const z = basis[2] as Float32Array;
    const determinant = vec3.dot(vec3.cross(vec3.create(), x, y), z);
    const scale = Math.hypot(...x) * Math.hypot(...y) * Math.hypot(...z);
    if (
      !transform.every(Number.isFinite) ||
      !Number.isFinite(scale) ||
      scale === 0 ||
      Math.abs(determinant) <= scale * 1e-8
    )
      throw new ProjectedDecalInvalidError('transform', 'a finite invertible projection box');
    const inverse = mat4.invert(mat4.create(), transform);
    if (
      !inverse.every(Number.isFinite) ||
      !mat4.equals(
        mat4.multiply(mat4.create(), inverse, transform),
        mat4.identity(mat4.create()),
        1e-4,
      )
    )
      throw new ProjectedDecalInvalidError('transform', 'a stable float32 inverse');
    const handle = toShared<'MaterialAsset'>(Number(data.material));
    if (context.assets === undefined || context.assets === null || Number(data.material) === 0)
      throw new ProjectedDecalInvalidError('material', 'a loaded Standard MaterialAsset');
    const resolved = walkMaterialPassesOverSharedRefs(world, handle, context.assets);
    if (!resolved.ok) throw new ProjectedDecalInvalidError('material', resolved.error.expected);
    const material = resolveMaterialSnapshot(
      Number(handle),
      world,
      context.assets,
      undefined,
      context.materialSnapshotCache,
      context.materialContext,
    );
    if (!material.deferredPass || material.materialShaderId !== 'forgeax::default-standard-pbr')
      throw new ProjectedDecalInvalidError(
        'material',
        'a base Standard material with a Deferred pass',
      );
    if (![...material.baseColor, material.roughness].every(Number.isFinite))
      throw new ProjectedDecalInvalidError('material', 'finite color and roughness');
    const authored = collectAuthoredMaterialTextureFields(
      resolved.value.values,
      material.materialShaderId,
      material.materialParamSchema,
      context.assets,
    );
    const authoredSamplers = collectAuthoredMaterialSamplerFields(resolved.value.values, authored);
    if (Number(material.paramSnapshot?.alphaHash ?? 0) !== 0)
      throw new ProjectedDecalInvalidError('alphaHash', 'continuous opacity or alphaCutoff');
    for (const field of authored ?? []) {
      if (!(DECAL_TEXTURE_FIELDS as readonly string[]).includes(field))
        throw new ProjectedDecalInvalidError(
          field,
          'baseColorTexture, normalTexture, or roughnessTexture',
        );
    }
    const textures = DECAL_TEXTURE_FIELDS.map((field) => {
      const textureHandle = material.textureHandles?.get(field);
      if (textureHandle === undefined) {
        if (authored?.has(field))
          throw new ProjectedDecalInvalidError(field, 'a resolved static 2D texture');
        return undefined;
      }
      const texture = resolveAssetHandle<TextureAsset>(world, textureHandle);
      if (!texture.ok) throw new ProjectedDecalInvalidError(field, texture.error.expected);
      if (texture.value.kind !== 'texture' || texture.value.shape.viewDimension !== '2d')
        throw new ProjectedDecalInvalidError(field, 'a static 2D texture');
      if (field !== 'baseColorTexture' && texture.value.colorSpace !== 'linear')
        throw new ProjectedDecalInvalidError(field, 'linear material data');
      if (
        texture.value.format.endsWith('uint') ||
        texture.value.format.endsWith('sint') ||
        texture.value.format.includes('32float') ||
        texture.value.format.startsWith('depth')
      )
        throw new ProjectedDecalInvalidError(field, 'a filterable color texture format');
      const layout = deriveRenderDataTexture(texture.value);
      if (!layout.ok) throw new ProjectedDecalInvalidError(field, layout.error.expected);
      const coordinates = material.textureCoordinates?.get(field);
      if (coordinates?.set !== undefined && coordinates.set !== 0)
        throw new ProjectedDecalInvalidError(field, 'projector UV set 0');
      return texture.value;
    });
    const samplers = DECAL_TEXTURE_FIELDS.map((field) => {
      const sampler = material.samplerHandles?.get(field);
      if (sampler === undefined) {
        if (authoredSamplers?.has(field))
          throw new ProjectedDecalInvalidError(field, 'a resolved sampler');
        return undefined;
      }
      const resolved = resolveAssetHandle<SamplerAsset>(world, sampler);
      if (!resolved.ok) throw new ProjectedDecalInvalidError(field, resolved.error.expected);
      if (resolved.value.compare !== undefined)
        throw new ProjectedDecalInvalidError(field, 'a color sampler without comparison');
      return resolved.value;
    });
    result.push({
      ...data,
      entityKey: row.entity,
      worldId: context.worldId,
      transform,
      inverse,
      material,
      textures,
      samplers,
    });
    if (result.length > MAX_PROJECTED_DECALS)
      throw new ProjectedDecalInvalidError(
        'count',
        `at most ${MAX_PROJECTED_DECALS} visible decals`,
      );
  }
  return result.sort((a, b) => a.order - b.order || a.entityKey - b.entityKey);
}
