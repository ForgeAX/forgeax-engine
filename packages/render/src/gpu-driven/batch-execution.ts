import {
  captureVertexLayoutProjection,
  type VertexLayoutProjection,
  visitVertexUvAliases,
} from '@forgeax/engine-geometry';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import {
  err,
  isDeepFrozenJson,
  isTriangleTopology,
  type MaterialRenderState,
  ok,
  RenderQueue,
  type Result,
} from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import { materialAlphaMask } from '../material-alpha-mask';
import { materialLeanInputs } from '../material-lean-inputs';
import { supportsGpuShadowRenderState } from '../material-render-state';
import { isCanonicalStandardPbrMaterialShader, SHADOW_CASTER_SHADER_ID } from '../pbr-pipeline';
import type { MaterialSnapshot } from '../render-system-extract';
import { standardTransmissionValue } from '../transmission/projection';
import { GPU_DRIVEN_LOD_LEVEL_CAPACITY } from './batch-layout';
import type { GpuDrivenBatch, GpuDrivenBatchLod } from './batch-topology';
import {
  type GpuDrivenDrawRange,
  type GpuDrivenGeometryReceipt,
  hasGpuDrivenVertexSemantic,
  hasMaterialResources,
  hasRequiredVertexInputs,
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

interface BatchVertexLayout {
  readonly layout: VertexLayoutProjection;
  readonly vertexInputs: GpuDrivenGeometryReceipt['vertexInputs'];
}

const batchLayouts = new WeakMap<VertexLayoutProjection, BatchVertexLayout>();

/** Extraction and resident mesh binding consume one input declaration per physical layout. */
export function batchVertexLayout(source: VertexLayoutProjection): BatchVertexLayout {
  const known = batchLayouts.get(source);
  if (known !== undefined) return known;
  const layout = captureVertexLayoutProjection(source);
  const vertexInputs = ownGpuDrivenVertexInputs(
    layout.attributes.map(({ key, shaderLocation, format }) => ({
      semantic: key,
      location: shaderLocation,
      format,
    })),
  );
  const value = { layout, vertexInputs };
  batchLayouts.set(layout, value);
  return value;
}

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
      : { layout: captureVertexLayoutProjection(source.layout) }),
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

export type BatchArtifactFacts = Pick<
  MaterialShaderArtifact,
  | 'material'
  | 'layoutIdentity'
  | 'uvSetCount'
  | 'receipt'
  | 'vertexEntry'
  | 'fragmentEntry'
  | 'specializationKey'
>;

export type BatchArtifactResolver<Artifact extends BatchArtifactFacts = MaterialShaderArtifact> = (
  shaderId: string,
  request: {
    readonly vertexColorAvailable: boolean;
    readonly deformation: 'rigid' | 'skin';
    readonly pass: BatchPass['kind'];
    readonly address: 'scene-index';
    /** Compile-time alpha-test lane; opaque programs contain no discard. */
    readonly alphaMask: boolean;
    /** UV0-only, tangent- and basis-free vertex inputs (STANDARD_LEAN_INPUTS). */
    readonly leanInputs: boolean;
    readonly tangentFrame32?: boolean;
  },
) => Artifact | undefined;

export type BatchExecution<Artifact extends BatchArtifactFacts = MaterialShaderArtifact> =
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
      readonly artifact: Artifact;
      readonly prepared: PreparedGpuDrivenDraw;
    };

/** Physical draw proven for one captured geometry and one immutable shader ABI. */
export interface BatchGeometryAdmission {
  readonly geometry: BatchGeometry;
  readonly receipt: NonNullable<BatchArtifactFacts['receipt']>;
  readonly uvSetCount: number | undefined;
  readonly prepared: PreparedGpuDrivenDraw;
}

export function captureBatchGeometryAdmission(
  geometry: BatchGeometry,
  execution: BatchExecution,
): BatchGeometryAdmission | undefined {
  if (execution.route !== 'gpu' || !capturedGeometry.has(geometry)) return undefined;
  const { receipt, uvSetCount } = execution.artifact;
  if (receipt === undefined || !isDeepFrozenJson(receipt)) return undefined;
  return { geometry, receipt, uvSetCount, prepared: execution.prepared };
}

/** Builtin and specialized programs prepare before graph recording can encode their draws. */
export function gpuLanePreparesAsynchronously(artifact: MaterialShaderArtifact): boolean {
  return (
    artifact.specializationKey !== undefined ||
    artifact.material === 'forgeax::default-unlit' ||
    artifact.material === SHADOW_CASTER_SHADER_ID ||
    isCanonicalStandardPbrMaterialShader(artifact.material)
  );
}

function needsDirectRoute(material: MaterialSnapshot, pass: BatchPass): boolean {
  const state = pass.renderState;
  if (state?.stencil !== undefined) return true;
  if (pass.kind === 'shadow' && !supportsGpuShadowRenderState(state)) return true;
  if ((material.textureSources?.size ?? 0) > 0) return true;
  if ((material.videoTextureFields?.size ?? 0) > 0) return true;
  if (pass.kind !== 'forward') return false;
  // fog:false opaque draws record after the opaque fog pass, on the direct route only.
  return (
    (pass.queue ?? RenderQueue.Geometry) >= RenderQueue.Transparent ||
    state?.blend !== undefined ||
    state?.fog === false ||
    (standardTransmissionValue(material) ?? 0) > 0
  );
}

/** Preserve the Pass's logical identity when selecting a physical specialization. */
function projectBatchArtifact<Artifact extends BatchArtifactFacts>(
  artifact: Artifact,
  pass: BatchPass,
): Artifact {
  return {
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
}

/** This join cannot inspect candidates, slots or a representative entity. */
export function prepareBatchExecution<Artifact extends BatchArtifactFacts>(
  geometry: BatchGeometry,
  material: MaterialSnapshot,
  pass: BatchPass | undefined,
  resolve: BatchArtifactResolver<Artifact>,
  admission?: BatchGeometryAdmission,
): Result<BatchExecution<Artifact>, GpuDrivenPreparationError> {
  if (pass === undefined) return ok({ route: 'none' });
  if (pass.kind === 'shadow' && !isTriangleTopology(geometry.draw.topology))
    return ok({ route: 'none' });
  const direct = (): Result<BatchExecution<Artifact>, GpuDrivenPreparationError> =>
    ok({ route: 'direct', material, pass });
  if (needsDirectRoute(material, pass)) return direct();

  const required =
    pass.sceneIndexProgramKey !== undefined || isCanonicalStandardPbrMaterialShader(pass.shaderId);
  const artifact = resolve(pass.sceneIndexProgramKey ?? pass.shaderId, {
    vertexColorAvailable: hasGpuDrivenVertexSemantic(geometry.receipt.vertexInputs, 'color'),
    ...(hasGpuDrivenVertexSemantic(geometry.receipt.vertexInputs, 'tangentFrame')
      ? { tangentFrame32: true }
      : {}),
    deformation: geometry.deformation,
    pass: pass.kind,
    address: 'scene-index',
    alphaMask: materialAlphaMask(material.paramSnapshot),
    leanInputs: materialLeanInputs(
      material.paramSnapshot,
      material.standardTextureMask,
      material.textureCoordinates,
    ),
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
  // Water frame resources and deformation are bound by the specialized direct
  // recorder. A scene-index vertex entry alone does not admit that resource ABI.
  if (receipt.systemInputs?.water === 'water-frame/3') return direct();
  const selected = projectBatchArtifact(artifact, pass);
  // The new material still resolves its own pass, variant, resources and published artifact.
  if (
    admission !== undefined &&
    admission.geometry === geometry &&
    admission.receipt === receipt &&
    receipt === selected.receipt &&
    admission.uvSetCount === selected.uvSetCount &&
    admission.prepared.identity.material === selected.material &&
    receipt.reflection.layoutIdentity === selected.layoutIdentity &&
    hasMaterialResources(material, receipt)
  )
    return ok({ route: 'gpu', material, pass, artifact: selected, prepared: admission.prepared });

  const sourceInputs = geometry.receipt.vertexInputs;
  // Geometry owns physical stream offsets. Admission needs only the required shader
  // inputs those bytes supply; pipeline creation materializes the GPU descriptors.
  let inputs: (typeof sourceInputs)[number][] | undefined;
  if (
    geometry.layout !== undefined &&
    artifact.uvSetCount !== undefined &&
    !hasRequiredVertexInputs(receipt.vertexInputs, sourceInputs)
  ) {
    visitVertexUvAliases(geometry.layout, artifact.uvSetCount, (key, location) => {
      const input = receipt.vertexInputs.find(
        (required) =>
          required.location === location &&
          required.semantic === key &&
          required.format === 'float32x2',
      );
      if (input === undefined || sourceInputs.some((actual) => actual.location === location))
        return;
      inputs ??= [...sourceInputs];
      inputs.push(input);
    });
  }
  const prepared = prepareGpuDrivenDraw({
    material,
    deformation: geometry.deformation,
    artifact: selected,
    geometry:
      inputs === undefined ? geometry.receipt : { ...geometry.receipt, vertexInputs: inputs },
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
