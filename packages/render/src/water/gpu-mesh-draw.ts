import { RhiError } from '@forgeax/engine-rhi';
import { featureResourceKey } from '../features/frame-plan';
import { getRenderFeaturePlanExecutionProjection } from '../features/host';
import type { RenderFeatureResolvedGpuBuffer } from '../features/prepared-gpu-work';
import type { RenderSystemInternals } from '../record/render-context';
import type { RenderableSnapshot } from '../render-system-extract';
import { viewFeaturePlanOf } from '../world/feature-plan-systems';
import { renderWorldFor } from '../world/render-world';
import {
  WATER_GPU_MESH_FEATURE,
  waterGpuMeshBufferSizes,
  waterGpuMeshResource,
} from './gpu-mesh-source';

/** Reads physical resources from the admitted Feature execution, never a parallel GPU registry. */
export function waterGpuMeshDrawBuffers(
  runtime: Pick<RenderSystemInternals, 'renderWorld' | 'viewEntity'>,
  source: RenderableSnapshot,
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
  const planned = viewFeaturePlanOf(renderWorldFor(runtime), runtime.viewEntity);
  const plans = planned?.kind === 'planned' ? (planned.plan.candidate?.plans ?? []) : [];
  const execution = plans
    .filter((plan) => plan.featureIdentity === WATER_GPU_MESH_FEATURE)
    .map(getRenderFeaturePlanExecutionProjection);
  const buffers = execution.flatMap(
    (plan) => plan?.passes.flatMap((pass) => pass.resolvedGpuCompute?.buffers ?? []) ?? [],
  );
  const scope = plans.find(
    (plan) => plan.featureIdentity === WATER_GPU_MESH_FEATURE && plan.scope !== 'frame',
  )?.scope;
  const find = (kind: string) =>
    scope === undefined
      ? undefined
      : buffers.find(
          (buffer) =>
            buffer.name === featureResourceKey(scope, waterGpuMeshResource(draw.zoneKey, kind)),
        );
  const tiles = find('tiles'),
    args = find('args');
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
    bindingBytes: waterGpuMeshBufferSizes({ ...draw, viewCount: 1 }).bindingBytes,
  };
}
