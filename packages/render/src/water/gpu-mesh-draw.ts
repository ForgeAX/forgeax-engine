import { RhiError } from '@forgeax/engine-rhi';
import {
  currentRenderFeaturePass,
  type RenderFeatureExecutionFrame,
} from '../features/frame-execution';
import { featureResourceKey, featureScopeKey } from '../features/frame-plan';
import type { RenderFeatureResolvedGpuBuffer } from '../features/prepared-gpu-work';
import type { RenderableSnapshot } from '../render-system-extract';
import {
  WATER_GPU_MESH_FEATURE,
  waterGpuMeshResource,
  waterGpuMeshViewBindingBytes,
} from './gpu-mesh-source';

/** Reads physical resources from the admitted Feature execution, never a parallel GPU registry. */
export function waterGpuMeshDrawBuffers(
  frame: RenderFeatureExecutionFrame,
  source: Pick<RenderableSnapshot, 'waterGpuMesh' | 'waterOwner' | 'waterMeshTiles'>,
):
  | Readonly<{
      tiles: RenderFeatureResolvedGpuBuffer;
      args: RenderFeatureResolvedGpuBuffer;
      headerOffset: number;
      indirectOffset: number;
      bindingBytes: number;
    }>
  | undefined {
  const draw = source.waterGpuMesh;
  if (draw === undefined) return undefined;
  // Scatter writes both outputs for exactly one zone and view. Read the execution
  // being recorded, including a captured view with a different accepted plan.
  const owner = source.waterOwner?.viewIdentity ?? source.waterMeshTiles?.viewIdentity;
  const scope = owner === undefined ? undefined : { view: owner };
  const scatter =
    scope === undefined
      ? undefined
      : currentRenderFeaturePass(
          frame,
          WATER_GPU_MESH_FEATURE,
          waterGpuMeshResource(draw.zoneKey, 'scatter'),
          featureScopeKey(scope),
        );
  let tiles: RenderFeatureResolvedGpuBuffer | undefined;
  let args: RenderFeatureResolvedGpuBuffer | undefined;
  if (
    scatter?.enabled !== false &&
    scatter?.resolvedGpuCompute !== undefined &&
    scope !== undefined
  ) {
    const tileKey = featureResourceKey(scope, waterGpuMeshResource(draw.zoneKey, 'tiles'));
    const argsKey = featureResourceKey(scope, waterGpuMeshResource(draw.zoneKey, 'args'));
    for (const buffer of scatter.resolvedGpuCompute.buffers) {
      if (buffer.name === tileKey) tiles = buffer;
      else if (buffer.name === argsKey) args = buffer;
    }
  }
  if (
    !tiles ||
    !args ||
    draw.viewIndex >= draw.viewCount ||
    draw.materialBucket >= draw.materialCount
  )
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'the same-frame admitted Water GPU tile and indirect buffers',
      hint: 'retain the GPU Water Feature plan through all selected Water passes',
    });
  const row = draw.materialBucket;
  return {
    tiles,
    args,
    headerOffset: row * 256,
    indirectOffset: row * 20,
    bindingBytes: waterGpuMeshViewBindingBytes(draw),
  };
}
