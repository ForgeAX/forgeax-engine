import { readMaterialContent, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { readRenderArrayView } from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { mat4, vec3 } from '@forgeax/engine-math';
import { GlobalTransform } from '@forgeax/engine-scene';
import type { AssetHandle, SamplerAsset, TextureAsset } from '@forgeax/engine-types';
import { noteEnvironmentPose } from '../extract/environment-gate';
import { worldRenderResources } from '../publication/resource-scope';
import { deriveRenderDataTexture } from '../render-data';
import {
  collectAuthoredMaterialSamplerFields,
  collectAuthoredMaterialTextureFields,
  type MaterialSnapshot,
  materialSnapshotContext,
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

function invertProjectedDecalTransform(transform: Float32Array): Float32Array {
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
  return inverse;
}

/** Detached source facts; no World or asset lookup is retained by the graph. */
export function extractProjectedDecals(
  world: World,
  context: PreparedExtractContext,
): ProjectedDecalSnapshot[] {
  const result: ProjectedDecalSnapshot[] = [];
  const query = world.query({ read: [ProjectedDecal] }).unwrap();
  for (const batch of query.batches().unwrap()) {
    const entities = batch.entities;
    const selection = batch.kind === 'indexed' ? batch.rows : undefined;
    const first = batch.kind === 'range' ? batch.start : 0;
    const columns = {
      order: batch.read(ProjectedDecal, 'order'),
      opacity: batch.read(ProjectedDecal, 'opacity'),
      normalThreshold: batch.read(ProjectedDecal, 'normalThreshold'),
      colorOpacity: batch.read(ProjectedDecal, 'colorOpacity'),
      normalOpacity: batch.read(ProjectedDecal, 'normalOpacity'),
      roughnessOpacity: batch.read(ProjectedDecal, 'roughnessOpacity'),
    };
    for (let ordinal = 0; ordinal < batch.count; ordinal++) {
      const physicalRow =
        selection === undefined ? first + ordinal : (selection[ordinal] as number);
      const entity = entities[physicalRow] as EntityHandle;
      if (context.visibility.effective(entity) === 'hidden') continue;
      const materialHandle = world[worldRead].getFieldValue(
        entity,
        ProjectedDecal,
        'material',
      ) as number;
      for (const field of [
        'opacity',
        'colorOpacity',
        'normalOpacity',
        'roughnessOpacity',
        'normalThreshold',
      ] as const) {
        const minimum = field === 'normalThreshold' ? -1 : 0;
        if (
          !Number.isFinite(columns[field][physicalRow] as number) ||
          (columns[field][physicalRow] as number) < minimum ||
          (columns[field][physicalRow] as number) > 1
        )
          throw new ProjectedDecalInvalidError(field, `a finite number in [${minimum}, 1]`);
      }
      if (
        (columns.opacity[physicalRow] as number) === 0 ||
        ((columns.colorOpacity[physicalRow] as number) === 0 &&
          (columns.normalOpacity[physicalRow] as number) === 0 &&
          (columns.roughnessOpacity[physicalRow] as number) === 0)
      )
        continue;
      noteEnvironmentPose(entity);
      const raw = readRenderArrayView(world, entity, GlobalTransform, 'world');
      if (raw === undefined)
        throw new ProjectedDecalInvalidError('transform', 'a propagated world transform');
      const transform = new Float32Array(raw);
      const inverse = invertProjectedDecalTransform(transform);
      const handle = Number(materialHandle) as AssetHandle<'material'>;
      if (context.assets === undefined || context.assets === null || Number(materialHandle) === 0)
        throw new ProjectedDecalInvalidError('material', 'a loaded Standard MaterialAsset');
      const resolved = readMaterialContent(runtimeAssets(world.assets), handle);
      if (!resolved.ok) throw new ProjectedDecalInvalidError('material', resolved.error.expected);
      const material = resolveMaterialSnapshot(
        Number(handle),
        worldRenderResources(world),
        context.assets,
        undefined,
        materialSnapshotContext(
          context.materialSnapshotContexts,
          context.materialContext?.geometry ?? 'mesh',
          false,
        ),
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
      const authoredSamplers = collectAuthoredMaterialSamplerFields(
        resolved.value.values,
        authored,
      );
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
        const texture = runtimeAssets(world.assets).resolveAsset<TextureAsset>(textureHandle);
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
        const resolved = runtimeAssets(world.assets).resolveAsset<SamplerAsset>(sampler);
        if (!resolved.ok) throw new ProjectedDecalInvalidError(field, resolved.error.expected);
        if (resolved.value.compare !== undefined)
          throw new ProjectedDecalInvalidError(field, 'a color sampler without comparison');
        return resolved.value;
      });
      result.push({
        order: columns.order[physicalRow] as number,
        opacity: columns.opacity[physicalRow] as number,
        normalThreshold: columns.normalThreshold[physicalRow] as number,
        colorOpacity: columns.colorOpacity[physicalRow] as number,
        normalOpacity: columns.normalOpacity[physicalRow] as number,
        roughnessOpacity: columns.roughnessOpacity[physicalRow] as number,
        entityKey: entity,
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
  }
  return result.sort((a, b) => a.order - b.order || a.entityKey - b.entityKey);
}
