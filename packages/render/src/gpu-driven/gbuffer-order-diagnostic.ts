import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MaterialRenderState } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { deriveInstancesUnionBounds } from '../instances-derived-bounds';
import { computeViewMatrix } from '../record/helpers';
import type { CameraSnapshot } from '../render-contract';
import type { MaterialSnapshot } from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { GpuDrivenBatch } from './batch-topology';

export type GBufferOrderDiagnostic = 'near' | 'far';
export interface GBufferOrderDiagnosticConfig {
  readonly order: GBufferOrderDiagnostic;
  /** Complete source digests independently audited for fixed Standard entry/readonly semantics. */
  readonly programDigests: readonly string[];
}
export interface GBufferOrderEncodeEvidence {
  readonly rendererRecording: boolean;
  readonly filter: string | undefined;
  readonly fragmentEntry: string | undefined;
  readonly coverageOnly: boolean;
  readonly phase: string;
  readonly colorTargetCount: number;
  readonly admitted: boolean;
}
export interface GBufferOrderDiagnosticInspection {
  readonly mode: GBufferOrderDiagnostic;
  readonly eligibleBatches: number;
  readonly movedBatches: number;
  readonly status: 'not-encoded' | 'evaluated';
  readonly encodes: readonly GBufferOrderEncodeEvidence[];
  /** Preparation identity only, not an independent GPU completion receipt. */
  readonly preparation?: { readonly frameId: number; readonly deviceGeneration: number };
  readonly denominator?: { readonly live: number; readonly selected: number | null };
  /** Overlapping predicates: a rejected reference may fail more than one gate. */
  readonly rejections?: Readonly<Record<string, number>>;
  readonly classes?: readonly {
    readonly sourceDigest: string;
    readonly material: string;
    readonly specializationKey: string | undefined;
    readonly facts: Readonly<Record<string, string | number | boolean | null>>;
    readonly checks: Readonly<Record<string, boolean>>;
    readonly rejections: readonly string[];
    readonly auditedSource: boolean;
  }[];
  readonly batches?: readonly {
    readonly batchId: number;
    readonly classIndex: number | undefined;
    readonly candidateCount: number;
    readonly visibleCapacity: number;
    readonly materialPass: string | undefined;
    readonly meshHandle: number;
    readonly materialSlot: number;
    readonly depth: number | undefined;
    readonly rejections: readonly string[];
    readonly rejectedSource?: Readonly<Record<string, unknown>>;
  }[];
}
export function gbufferProgramDigest(source: string): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(source)))}`;
}

/** Interface/state gate only; the caller must also match an audited complete source digest. */
export function gbufferOrderInterfaceEligible(
  artifact: MaterialShaderArtifact,
  state: MaterialRenderState | undefined,
  deformation: 'rigid' | 'skin',
  selectedVertexEntry = artifact.vertexEntry ?? artifact.receipt?.sceneIndexEntry,
): boolean {
  return (
    gbufferOrderInterfaceEvidence(artifact, state, deformation, selectedVertexEntry).rejections
      .length === 0
  );
}

/** Explicit diagnostic only: copy gate inputs rather than exposing retained state. */
export function gbufferOrderInterfaceEvidence(
  artifact: MaterialShaderArtifact,
  state: MaterialRenderState | undefined,
  deformation: 'rigid' | 'skin',
  selectedVertexEntry: string | undefined,
) {
  const facts = {
    deformation,
    receiptSceneIndexEntry: artifact.receipt?.sceneIndexEntry ?? null,
    surfacePresent: artifact.receipt?.surface !== undefined,
    authoredVertexEntry: artifact.vertexEntry ?? null,
    selectedVertexEntry: selectedVertexEntry ?? null,
    authoredFragmentEntry: artifact.fragmentEntry ?? null,
    depthWriteEnabled: state?.depthWriteEnabled ?? null,
    depthCompare: state?.depthCompare ?? null,
    blendPresent: state?.blend !== undefined,
    outputBlendPresent: state?.outputs?.some((output) => output.blend !== undefined) ?? false,
    stencilPresent: state?.stencil !== undefined,
    stencilReadMask: state?.stencilReadMask ?? null,
    stencilWriteMask: state?.stencilWriteMask ?? null,
    depthBias: state?.depthBias ?? null,
    depthBiasSlopeScale: state?.depthBiasSlopeScale ?? null,
    depthBiasClamp: state?.depthBiasClamp ?? null,
    alphaToCoverageEnabled: state?.alphaToCoverageEnabled ?? null,
  };
  const checks = {
    rigid: facts.deformation === 'rigid',
    receiptSceneIndex: facts.receiptSceneIndexEntry === 'vs_scene_index',
    fixedSurface: !facts.surfacePresent,
    selectedVertex: facts.selectedVertexEntry === 'vs_scene_index',
    // The GBuffer encode independently selects fs_gbuffer from the same source.
    fixedFragment:
      facts.authoredFragmentEntry === null ||
      facts.authoredFragmentEntry === 'fs_main' ||
      facts.authoredFragmentEntry === 'fs_gbuffer',
    depthWrite: facts.depthWriteEnabled !== false,
    // Standard supports conventional and reversed-Z strict depth tests.
    strictDepthCompare:
      facts.depthCompare === null ||
      facts.depthCompare === 'less' ||
      facts.depthCompare === 'greater',
    noBlend: !facts.blendPresent,
    noOutputBlend: !facts.outputBlendPresent,
    noStencil: !facts.stencilPresent,
    noStencilReadMask: facts.stencilReadMask === null,
    noStencilWriteMask: facts.stencilWriteMask === null,
    noDepthBias: (facts.depthBias ?? 0) === 0,
    noDepthBiasSlopeScale: (facts.depthBiasSlopeScale ?? 0) === 0,
    noDepthBiasClamp: (facts.depthBiasClamp ?? 0) === 0,
    noAlphaToCoverage: facts.alphaToCoverageEnabled !== true,
  };
  return {
    facts,
    checks,
    rejections: Object.entries(checks)
      .filter(([, pass]) => !pass)
      .map(([key]) => key),
  };
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Current retained CPU bounds; unknown/moving shader geometry stays a barrier. */
export function gbufferBatchDepth(
  batch: GpuDrivenBatch,
  slotAt: PersistentGpuDrivenState['slotAt'],
  view: Float32Array,
  reject?: (reason: string, source: Readonly<Record<string, unknown>>) => void,
  material: MaterialSnapshot | undefined = undefined,
): number | undefined {
  let near = Infinity;
  let far = -Infinity;
  let previous = -1;
  for (const candidate of batch.candidates) {
    if (candidate.primitiveIndex === previous) continue;
    previous = candidate.primitiveIndex;
    const source = slotAt(candidate.primitiveIndex)?.snapshot;
    if (source === undefined || source.skin !== undefined || source.morph !== undefined) {
      reject?.('source-or-deformation', {
        primitiveIndex: candidate.primitiveIndex,
        sourcePresent: source !== undefined,
        skinPresent: source?.skin !== undefined,
        morphPresent: source?.morph !== undefined,
      });
      return undefined;
    }
    const selectedMaterial =
      material ?? (source.materials[batch.key.materialSlot] ?? source.material).snapshot;
    if (
      typeof selectedMaterial.paramSnapshot?.displacementScale === 'number' &&
      selectedMaterial.paramSnapshot.displacementScale !== 0
    ) {
      reject?.('displacement', {
        primitiveIndex: candidate.primitiveIndex,
        displacementScale: selectedMaterial.paramSnapshot.displacementScale,
        displacementBias: selectedMaterial.paramSnapshot.displacementBias ?? null,
        standardTextureMask: selectedMaterial.standardTextureMask ?? null,
        materialHandle: selectedMaterial.materialHandle ?? null,
        materialShaderId: selectedMaterial.materialShaderId ?? null,
        displacementSchema:
          selectedMaterial.materialParamSchema?.some(
            (entry) => entry.name === 'displacementTexture' && entry.type === 'texture2d',
          ) ?? false,
      });
      return undefined;
    }
    const bounds = deriveInstancesUnionBounds({
      meshAabb: source.localAabb,
      entityWorld: source.transform.world,
      transforms: source.instances?.transforms ?? IDENTITY,
    });
    if (bounds === undefined) {
      reject?.('bounds-invalid', {
        primitiveIndex: candidate.primitiveIndex,
        localAabb: source.localAabb === undefined ? null : Array.from(source.localAabb),
        world: Array.from(source.transform.world),
        instanceTransformLength: source.instances?.transforms.length ?? null,
        materialHandle: selectedMaterial.materialHandle ?? null,
        displacementScale: selectedMaterial.paramSnapshot?.displacementScale ?? null,
        standardTextureMask: selectedMaterial.standardTextureMask ?? null,
      });
      return undefined;
    }
    const cx = ((bounds[0] as number) + (bounds[3] as number)) * 0.5;
    const cy = ((bounds[1] as number) + (bounds[4] as number)) * 0.5;
    const cz = ((bounds[2] as number) + (bounds[5] as number)) * 0.5;
    const ex = ((bounds[3] as number) - (bounds[0] as number)) * 0.5;
    const ey = ((bounds[4] as number) - (bounds[1] as number)) * 0.5;
    const ez = ((bounds[5] as number) - (bounds[2] as number)) * 0.5;
    const depth = -(
      (view[2] as number) * cx +
      (view[6] as number) * cy +
      (view[10] as number) * cz +
      (view[14] as number)
    );
    const extent =
      Math.abs(view[2] as number) * ex +
      Math.abs(view[6] as number) * ey +
      Math.abs(view[10] as number) * ez;
    if (!Number.isFinite(depth) || !Number.isFinite(extent)) {
      reject?.('depth-nonfinite', {
        primitiveIndex: candidate.primitiveIndex,
        depth: String(depth),
        extent: String(extent),
      });
      return undefined;
    }
    near = Math.min(near, depth - extent);
    far = Math.max(far, depth + extent);
  }
  const center = (near + far) * 0.5;
  if (!Number.isFinite(center))
    reject?.('empty-or-nonfinite-batch', { near: String(near), far: String(far) });
  return Number.isFinite(center) ? center : undefined;
}

/** Reorder references only, independently inside contiguous admitted runs. */
export function orderGBufferDiagnostic<T>(
  batches: readonly T[],
  mode: GBufferOrderDiagnostic | undefined,
  depth: (batch: T) => number | undefined,
): { readonly batches: readonly T[]; readonly eligible: number; readonly moved: number } {
  if (mode === undefined) return { batches, eligible: 0, moved: 0 };
  const ordered = [...batches];
  let eligible = 0;
  let start = 0;
  let run: { value: T; depth: number; ordinal: number }[] = [];
  const flush = () => {
    run.sort(
      (left, right) =>
        (mode === 'near' ? left.depth - right.depth : right.depth - left.depth) ||
        left.ordinal - right.ordinal,
    );
    for (let index = 0; index < run.length; index++)
      ordered[start + index] = (run[index] as { value: T }).value;
    run = [];
  };
  for (let index = 0; index < batches.length; index++) {
    const value = batches[index] as T;
    const key = depth(value);
    if (key === undefined || !Number.isFinite(key)) {
      flush();
      start = index + 1;
    } else {
      eligible++;
      run.push({ value, depth: key, ordinal: index });
    }
  }
  flush();
  return {
    batches: ordered,
    eligible,
    moved: ordered.filter((value, index) => value !== batches[index]).length,
  };
}

export function gbufferDiagnosticView(camera: CameraSnapshot): Float32Array | undefined {
  if (camera.world.length !== 16 || !camera.world.every(Number.isFinite)) return undefined;
  return computeViewMatrix(camera);
}

/** Stock six-target early GBuffer only; raw/late/shadow/direct lanes retain order. */
export function isGBufferOrderDiagnosticEncode(
  rendererRecording: boolean,
  filter: string | undefined,
  fragmentEntry: string | undefined,
  coverageOnly: boolean,
  phase: string,
  colorTargetCount: number,
): boolean {
  return (
    rendererRecording &&
    filter === 'deferred-opaque' &&
    fragmentEntry === 'fs_gbuffer' &&
    !coverageOnly &&
    phase === 'all' &&
    colorTargetCount === 6
  );
}
