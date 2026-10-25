import {
  deriveVertexBufferLayoutFromProjection,
  type VertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import {
  err,
  isTriangleTopology,
  type MaterialRenderState,
  ok,
  RenderQueue,
  type Result,
} from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import { supportsGpuShadowRenderState } from '../material-render-state';
import { isCanonicalStandardPbrMaterialShader, SHADOW_CASTER_SHADER_ID } from '../pbr-pipeline';
import type { MaterialSnapshot } from '../render-system-extract';
import { standardTransmissionValue } from '../transmission/projection';
import { GPU_DRIVEN_LOD_LEVEL_CAPACITY } from './batch-layout';
import type { GpuDrivenBatch, GpuDrivenBatchLod } from './batch-topology';
import {
  type GpuDrivenDrawRange,
  type GpuDrivenGeometryReceipt,
  hasGpuDrivenVertexColor,
  ownGpuDrivenVertexInputs,
  type PreparedGpuDrivenDraw,
  prepareGpuDrivenDraw,
} from './prepared-draw';

/** Shared geometry facts. Instance bounds and palette addresses belong to binding admission. */
export interface BatchGeometry {
  readonly receipt: GpuDrivenGeometryReceipt;
  readonly layout?: VertexLayoutProjection;
  readonly draw: GpuDrivenDrawRange;
  readonly deformation: 'rigid' | 'skin';
}

const capturedGeometry = new WeakSet<BatchGeometry>();

/** Capture borrowed source facts once, sharing the immutable result across bindings. */
export function captureBatchGeometry(source: BatchGeometry): BatchGeometry {
  if (capturedGeometry.has(source)) return source;
  const value: BatchGeometry = Object.freeze({
    receipt: Object.freeze({
      ...source.receipt,
      vertexInputs: ownGpuDrivenVertexInputs(source.receipt.vertexInputs),
    }),
    ...(source.layout === undefined
      ? {}
      : {
          layout: Object.freeze({
            ...source.layout,
            attributes: Object.freeze(
              source.layout.attributes.map((attribute) => Object.freeze({ ...attribute })),
            ),
          }),
        }),
    draw: Object.freeze({ ...source.draw }),
    deformation: source.deformation,
  });
  capturedGeometry.add(value);
  return value;
}

/** The selected program pair from one accepted material Pass. */
export interface BatchPass {
  readonly kind: 'forward' | 'shadow' | 'depth';
  readonly shaderId: string;
  readonly sceneIndexProgramKey?: string;
  readonly renderState?: MaterialRenderState;
  /** Dispatch queue; GPU-driven batches encode before the CPU list, so transparent and overlay queues stay direct. */
  readonly queue?: number;
  readonly vertexEntry?: string;
  readonly fragmentEntry?: string;
}

export type BatchArtifactResolver = (
  shaderId: string,
  request: {
    readonly vertexColorAvailable: boolean;
    readonly deformation: 'rigid' | 'skin';
    readonly pass: BatchPass['kind'];
    readonly address: 'scene-index';
  },
) => MaterialShaderArtifact | undefined;

export type BatchExecution =
  | { readonly route: 'none' }
  | {
      readonly route: 'direct';
      readonly material: MaterialSnapshot;
      readonly pass: BatchPass;
      readonly reason?: GpuDrivenPreparationError;
    }
  | {
      readonly route: 'gpu';
      readonly material: MaterialSnapshot;
      readonly pass: BatchPass;
      readonly artifact: MaterialShaderArtifact;
      readonly prepared: PreparedGpuDrivenDraw;
    };

/**
 * Standard-family and scene-index specialized programs prepare their GPU-lane
 * pipelines asynchronously and hold the picture pending meanwhile. Other
 * programs (opaque Unlit) were presentable on the direct lane before joining
 * the GPU lane, so their GPU-lane pipelines keep that synchronous readiness.
 */
export function gpuLanePreparesAsynchronously(artifact: MaterialShaderArtifact): boolean {
  return (
    artifact.specializationKey !== undefined ||
    artifact.material === SHADOW_CASTER_SHADER_ID ||
    isCanonicalStandardPbrMaterialShader(artifact.material)
  );
}

/** This join cannot inspect candidates, slots or a representative entity. */
export function prepareBatchExecution(
  geometry: BatchGeometry,
  material: MaterialSnapshot,
  pass: BatchPass | undefined,
  resolve: BatchArtifactResolver,
): Result<BatchExecution, GpuDrivenPreparationError> {
  if (pass === undefined) return ok({ route: 'none' });
  if (pass.kind === 'shadow' && !isTriangleTopology(geometry.draw.topology))
    return ok({ route: 'none' });
  const direct = (): Result<BatchExecution, GpuDrivenPreparationError> =>
    ok({ route: 'direct', material, pass });
  const state = pass.renderState;
  if (
    state?.stencil !== undefined ||
    (pass.kind === 'shadow' && !supportsGpuShadowRenderState(state)) ||
    (material.textureSources?.size ?? 0) > 0 ||
    (material.videoTextureFields?.size ?? 0) > 0 ||
    (pass.kind === 'forward' &&
      ((pass.queue ?? RenderQueue.Geometry) >= RenderQueue.Transparent ||
        state?.blend !== undefined ||
        (standardTransmissionValue(material) ?? 0) > 0))
  )
    return direct();

  const required =
    pass.sceneIndexProgramKey !== undefined || isCanonicalStandardPbrMaterialShader(pass.shaderId);
  const artifact = resolve(pass.sceneIndexProgramKey ?? pass.shaderId, {
    vertexColorAvailable: hasGpuDrivenVertexColor(geometry.receipt.vertexInputs),
    deformation: geometry.deformation,
    pass: pass.kind,
    address: 'scene-index',
  });
  if (artifact?.receipt?.sceneIndexEntry === undefined) {
    if (!required) return direct();
    return err(
      new GpuDrivenPreparationError('missing-material-receipt', {
        reason: 'material-receipt-missing',
        owner: 'material',
        expected: `scene-index artifact for ${pass.sceneIndexProgramKey ?? pass.shaderId}`,
      }),
    );
  }
  const receipt = artifact.receipt;
  // A specialization has a physical program key and the Pass's logical material identity.
  const selected: MaterialShaderArtifact = {
    ...artifact,
    ...(pass.sceneIndexProgramKey === undefined
      ? {}
      : {
          material: pass.shaderId,
          specializationKey: pass.sceneIndexProgramKey,
        }),
    ...(pass.vertexEntry === undefined ? {} : { vertexEntry: pass.vertexEntry }),
    ...(pass.fragmentEntry === undefined ? {} : { fragmentEntry: pass.fragmentEntry }),
  };
  const sourceInputs = geometry.receipt.vertexInputs;
  // UV aliases reuse bytes inside the uploaded stride (Geometry owns the alias choice).
  const layout =
    geometry.layout === undefined ||
    artifact.uvSetCount === undefined ||
    receipt.vertexInputs.every((input) =>
      sourceInputs.some((actual) => actual.location === input.location),
    )
      ? undefined
      : deriveVertexBufferLayoutFromProjection(geometry.layout, {
          shaderUvSetCount: artifact.uvSetCount,
        })[0];
  const aliases =
    layout?.arrayStride !== geometry.layout?.arrayStride
      ? []
      : receipt.vertexInputs.filter(
          (input) =>
            !sourceInputs.some((actual) => actual.location === input.location) &&
            layout?.attributes.some(
              (actual) =>
                actual.shaderLocation === input.location && actual.format === input.format,
            ),
        );
  const prepared = prepareGpuDrivenDraw({
    material,
    deformation: geometry.deformation,
    artifact: selected,
    geometry:
      aliases.length === 0
        ? geometry.receipt
        : { ...geometry.receipt, vertexInputs: [...sourceInputs, ...aliases] },
    generation: receipt.generation,
    draw: geometry.draw,
  });
  return prepared.ok
    ? ok({ route: 'gpu', material, pass, artifact: selected, prepared: prepared.value })
    : err(prepared.error);
}

/** Numeric task facts are captured here, never borrowed from raw author arrays. */
export function captureBatchLod(
  batch: Pick<GpuDrivenBatch, 'lod' | 'binding'>,
  mesh?: MeshGpuHandles,
): GpuDrivenBatchLod | undefined {
  const lod = batch.lod;
  if (lod === undefined) return undefined;
  const coverages: number[] = [];
  for (let i = 0; i < Math.min(lod.coverages.length, GPU_DRIVEN_LOD_LEVEL_CAPACITY); i++)
    coverages.push(lod.coverages[i] as number);
  const ranges: NonNullable<GpuDrivenBatchLod['ranges']>[number][] = [];
  const count = Math.max(
    0,
    Math.min(
      mesh?.lodRanges === undefined ? (lod.ranges?.length ?? 0) : mesh?.lodRanges.length - 1,
      GPU_DRIVEN_LOD_LEVEL_CAPACITY - 1,
    ),
  );
  for (let i = 0; i < count; i++) {
    let range: NonNullable<GpuDrivenBatchLod['ranges']>[number];
    if (mesh?.lodRanges === undefined) range = lod.ranges?.[i];
    else {
      if (batch.binding === undefined)
        throw Error('Resident LOD requires a shared geometry binding');
      range = mesh.lodRanges[i + 1]?.[batch.binding.drawItemIndex];
    }
    ranges.push(
      range === undefined
        ? undefined
        : Object.freeze({
            first: range.first,
            count: range.count,
            baseVertex: range.baseVertex,
          }),
    );
  }
  return Object.freeze({
    coverages: Object.freeze(coverages),
    ...(lod.hysteresis === undefined ? {} : { hysteresis: lod.hysteresis }),
    ...(lod.crossfade === undefined ? {} : { crossfade: lod.crossfade }),
    ...(lod.ranges === undefined && mesh?.lodRanges === undefined
      ? {}
      : { ranges: Object.freeze(ranges) }),
  });
}
