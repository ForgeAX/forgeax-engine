import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, type Handle, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import { DynamicGeometryError } from '../dynamic-geometry';
import { renderMaterialContext } from '../extract/material-context';
import { extractFrames } from '../render-system-extract-tail';
import type { MeshPipelinePreparation } from './contract';
import { publicationMaterialProgramKeys } from './programs';

/** Extract one real candidate through the ordinary material owner, without rebinding ECS. */
export function captureMeshPipelinePreparation(input: {
  readonly world: World;
  readonly entity: number;
  readonly meshHandle: Handle<'MeshAsset', 'shared'>;
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
    const frame = extractFrames([input.world], 0, input.assets, undefined, undefined, {
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
      row.skin !== undefined ||
      row.skinPose !== undefined ||
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
      for (const key of publicationMaterialProgramKeys(material)) {
        if (programs.has(key)) continue;
        const shader = input.assets.shaderRegistry.findMaterialArtifact(key);
        if (!shader.ok) return invalid(shader.error);
        const artifact = input.assets.getMaterialArtifact(key);
        programs.set(key, {
          key,
          shader: {
            source: shader.value.source,
            paramSchema: shader.value.paramSchema,
            ...(shader.value.receipt === undefined ? {} : { receipt: shader.value.receipt }),
          },
          ...(artifact === undefined ? {} : { artifact }),
        });
      }
    }
    const {
      worldId: _worldId,
      entityKey: _entityKey,
      transform,
      gpuDrivenDraws: _gpuDraws,
      ...snapshot
    } = row;
    return ok({
      entity: input.entity,
      transform,
      template: { snapshot, dispatch: row.pipelinePreparation },
      programs: [...programs.values()],
    });
  } catch (cause) {
    return invalid(cause);
  }
}
