import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { RhiCaps } from '@forgeax/engine-rhi';
import type { MaterialShaderEntry, RegisteredMaterialShaderEntry } from '@forgeax/engine-shader';
import { type AssetHandle, err, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import { DynamicGeometryError } from '../dynamic-geometry';
import { renderMaterialContext } from '../extract/material-context';
import type { RenderableSnapshot } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import type { MeshPipelinePreparation } from './contract';
import { publicationMaterialProgramKeys } from './programs';

// Program delivery is selected by the publisher after capture. Borrow text only
// when an unpublished entry is actually serialized across the Worker boundary.
function publicationShader(entry: RegisteredMaterialShaderEntry): MaterialShaderEntry {
  const program = entry.program;
  return {
    get source() {
      return program.source;
    },
    paramSchema: entry.paramSchema,
    ...(entry.receipt === undefined ? {} : { receipt: entry.receipt }),
  };
}

/** Extract one real candidate through the ordinary material owner, without rebinding ECS. */
export function captureMeshPipelinePreparation(input: {
  readonly world: World;
  readonly entity: number;
  readonly meshHandle: AssetHandle<'mesh'>;
  readonly mesh: MeshAsset;
  readonly assets: AssetRegistry;
  readonly capabilities: RhiCaps;
  readonly limits?: Parameters<typeof renderMaterialContext>[1];
}): Result<MeshPipelinePreparation, DynamicGeometryError> {
  const invalid = (actual: unknown) =>
    err(
      new DynamicGeometryError(
        'dynamic-geometry-invalid',
        'the candidate has a complete rigid mesh material/program projection',
        'prepare the real entity and its candidate MeshAsset after its materials are available',
        { actual },
      ),
    );
  try {
    const frame = extractFrames([input.world], 0, input.assets, undefined, {
      ...renderMaterialContext(input.capabilities, input.limits),
      cull: 'none',
      retainHidden: true,
      renderables: { kind: 'partial', entitiesByWorld: [new Set([input.entity])] },
      preparationMesh: input,
    });
    const row = frame.renderables.find((row) => row.entityKey === input.entity);
    if (
      row === undefined ||
      row.assetHandle !== input.meshHandle ||
      row.pipelinePreparation === undefined
    )
      return invalid('candidate render snapshot is unavailable');
    if (
      row.skinBinding !== undefined ||
      row.morph !== undefined ||
      row.terrain !== undefined ||
      row.pointsLines !== undefined ||
      row.spriteInstances !== undefined
    )
      return invalid(
        'posed, terrain and expanded geometry require their specialized preparation owner',
      );
    const programs = new Map<string, MeshPipelinePreparation['programs'][number]>();
    for (const material of row.materials) {
      for (const key of publicationMaterialProgramKeys(material.snapshot)) {
        if (programs.has(key)) continue;
        const shader = input.assets.shaderRegistry.findMaterialArtifact(key);
        if (!shader.ok) return invalid(shader.error);
        const artifact = input.assets.getMaterialArtifact(key);
        programs.set(key, {
          key,
          shader: publicationShader(shader.value),
          ...(artifact === undefined ? {} : { artifact }),
        });
      }
    }
    const {
      worldId: _worldId,
      entityKey: _entityKey,
      transform,
      gpuDrivenDraws: _gpuDraws,
      materialOverrides: _overrides,
      ...snapshot
    } = row;
    const materials: MeshPipelinePreparation['materials'][number][] = [];
    const ids = new Map<RenderableSnapshot['material'], number>();
    const materialId = (resource: RenderableSnapshot['material']) => {
      const previous = ids.get(resource);
      if (previous !== undefined) return previous;
      const id = materials.length + 1;
      ids.set(resource, id);
      materials.push({ id, value: resource.snapshot });
      return id;
    };
    return ok({
      materials,
      entity: input.entity,
      transform,
      template: {
        snapshot: {
          ...snapshot,
          material: materialId(row.material),
          materials: row.materials.map(materialId),
          ...(row.materialOverrides === undefined
            ? {}
            : {
                materialOverrides: row.materialOverrides.map((resource) =>
                  resource === undefined ? 0 : materialId(resource),
                ),
              }),
        },
        dispatch: row.pipelinePreparation,
      },
      programs: [...programs.values()],
    });
  } catch (cause) {
    return invalid(cause);
  }
}
