import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type {
  MaterialProgramAbi,
  MaterialProgramVertexInput,
  PrimitiveTopology,
} from '@forgeax/engine-types';
import { materialProgramUsesSkin } from '@forgeax/engine-types';
import {
  GpuDrivenPreparationError,
  type GpuDrivenPreparationErrorDetail,
} from '../errors/gpu-driven';
import type { MaterialSnapshot } from '../render-system-extract';
import { GenerationalWeakMap } from '../scene/generational-weak-map';

export interface GpuDrivenGeometryReceipt {
  readonly identity: string;
  readonly vertexInputs: readonly MaterialProgramVertexInput[];
  readonly topology: PrimitiveTopology;
  readonly indexed: boolean;
}

export interface PreparedGpuDrivenDraw {
  readonly identity: {
    readonly material: string;
    readonly geometry: string;
    readonly deformation: 'rigid' | 'skin';
  };
  readonly receiptGeneration: number;
  /** Content/layout identity that separates ABI variants (for example COLOR_0). */
  readonly receiptIdentity?: string;
  readonly directEntry: string;
  readonly sceneIndexEntry: string;
  readonly materialRow: MaterialProgramAbi['materialRow'];
  readonly resourceSlots: MaterialProgramAbi['resourceSlots'];
  readonly uvSets: MaterialProgramAbi['uvSets'];
  readonly vertexInputs: MaterialProgramAbi['vertexInputs'];
  readonly alphaMask: MaterialProgramAbi['alphaMask'];
  readonly topology: PrimitiveTopology;
  readonly indexed: boolean;
  readonly first: number;
  readonly count: number;
  readonly baseVertex: number;
}

/**
 * Stable lookup key for the producer-published material artifact selected by
 * one prepared draw.  The receipt identity is intentionally part of the key:
 * a COLOR_0 variant (or any later ABI variant) must never share a pipeline or
 * projection cache entry with its no-color sibling.
 */
export function gpuDrivenMaterialArtifactKey(input: {
  readonly material: string;
  readonly deformation: 'rigid' | 'skin';
  readonly receiptIdentity: string | undefined;
  readonly receiptGeneration: number;
}): string {
  return [
    input.material,
    input.deformation,
    input.receiptIdentity ?? '<legacy-receipt>',
    input.receiptGeneration,
  ].join('|');
}

// A derived fact belongs to the immutable draw, not to another World or batch index.
// Weak ownership lets old publications release it with their original draw record.
const preparedMaterialKeys = new WeakMap<PreparedGpuDrivenDraw, string>();

/** Complete a detached producer/receiver draw; borrowed records never enter this owner. */
export function freezePreparedGpuDrivenDraw(
  prepared: PreparedGpuDrivenDraw,
): PreparedGpuDrivenDraw {
  const owned = Object.freeze(prepared);
  const identity = Object.getOwnPropertyDescriptor(owned, 'identity')?.value;
  // Frozen accessors are still live. Only captured primitive data fields qualify.
  if (identity === undefined || !Object.isFrozen(identity)) return owned;
  const material = Object.getOwnPropertyDescriptor(identity, 'material')?.value;
  const deformation = Object.getOwnPropertyDescriptor(identity, 'deformation')?.value;
  const receiptIdentity = Object.getOwnPropertyDescriptor(owned, 'receiptIdentity')?.value;
  const receiptGeneration = Object.getOwnPropertyDescriptor(owned, 'receiptGeneration')?.value;
  if (
    typeof material === 'string' &&
    (deformation === 'rigid' || deformation === 'skin') &&
    typeof receiptIdentity === 'string' &&
    typeof receiptGeneration === 'number'
  ) {
    preparedMaterialKeys.set(
      owned,
      gpuDrivenMaterialArtifactKey({
        material,
        deformation,
        receiptIdentity,
        receiptGeneration,
      }),
    );
  }
  return owned;
}

/** Undefined keeps authored mutable, accessor and legacy observations on their original path. */
export function capturedPreparedMaterialArtifactKey(
  prepared: PreparedGpuDrivenDraw,
): string | undefined {
  return preparedMaterialKeys.get(prepared);
}

/** Exact extracted draw range consumed by the preparation owner. */
export interface GpuDrivenDrawRange {
  readonly kind: 'indexed' | 'non-indexed';
  readonly first: number;
  readonly count: number;
  readonly baseVertex: number;
  readonly topology: PrimitiveTopology;
}

export interface PrepareGpuDrivenDrawInput {
  readonly material: MaterialSnapshot;
  readonly deformation: 'rigid' | 'skin';
  readonly artifact: MaterialShaderArtifact;
  readonly geometry: GpuDrivenGeometryReceipt;
  readonly generation: number;
  /** The submesh draw currently being prepared; never infer draw zero. */
  readonly draw: GpuDrivenDrawRange;
}

function failure(
  code: ConstructorParameters<typeof GpuDrivenPreparationError>[0],
  detail: GpuDrivenPreparationErrorDetail,
): { readonly ok: false; readonly error: GpuDrivenPreparationError } {
  return { ok: false, error: new GpuDrivenPreparationError(code, detail) };
}

// Only scene-owned tables retain admission results. Borrowed inputs remain live.
// Re-owning a forgotten immutable table returns the same table; see GenerationalWeakMap.
const ownedVertexInputs = new GenerationalWeakMap<
  readonly MaterialProgramVertexInput[],
  {
    readonly admissions: WeakMap<readonly MaterialProgramVertexInput[], boolean>;
    readonly vertexColor: boolean;
  }
>();
const immutableVertexInputs = new WeakSet<readonly MaterialProgramVertexInput[]>();

export function ownGpuDrivenVertexInputs(
  inputs: readonly MaterialProgramVertexInput[],
): readonly MaterialProgramVertexInput[] {
  if (ownedVertexInputs.has(inputs)) return inputs;
  // Registry receipts already own immutable POD tables. Preserve that sharing
  // across scene receivers; borrowed inputs still get a fresh value snapshot.
  const owned = isImmutableVertexInputs(inputs)
    ? inputs
    : Object.freeze(
        inputs.map(({ semantic, location, format }) =>
          Object.freeze({ semantic, location, format }),
        ),
      );
  // Custom map implementations and Array species can return live observations.
  if (!isImmutableVertexInputs(owned)) return owned;
  ownedVertexInputs.set(owned, {
    admissions: new WeakMap(),
    vertexColor: owned.some((input) => input.semantic === 'color'),
  });
  return owned;
}

/** Derived from the existing scene-owned immutable table; borrowed inputs stay live. */
export function hasGpuDrivenVertexColor(inputs: readonly MaterialProgramVertexInput[]): boolean {
  return (
    ownedVertexInputs.get(inputs)?.vertexColor ?? inputs.some((input) => input.semantic === 'color')
  );
}

function isImmutableVertexInputs(inputs: readonly MaterialProgramVertexInput[]): boolean {
  if (immutableVertexInputs.has(inputs)) return true;
  if (
    !Array.isArray(inputs) ||
    !Object.isFrozen(inputs) ||
    Object.getPrototypeOf(inputs) !== Array.prototype ||
    Reflect.ownKeys(inputs).length !== inputs.length + 1
  )
    return false;
  for (let index = 0; index < inputs.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(inputs, index)?.value;
    if (
      entry === null ||
      typeof entry !== 'object' ||
      !Object.isFrozen(entry) ||
      Object.getPrototypeOf(entry) !== Object.prototype ||
      Reflect.ownKeys(entry).length !== 3
    )
      return false;
    for (const field of ['semantic', 'location', 'format']) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, field);
      if (descriptor === undefined || !('value' in descriptor)) return false;
      if (typeof descriptor.value !== (field === 'location' ? 'number' : 'string')) return false;
    }
  }
  immutableVertexInputs.add(inputs);
  return true;
}

/**
 * A material receipt declares the inputs its shader consumes. Geometry may
 * carry additional authored attributes (for example an unused TEXCOORD_1),
 * so admission checks required locations and formats without treating those
 * producer-owned extras as an ABI mismatch.
 */
export function hasRequiredVertexInputs(
  expected: readonly MaterialProgramVertexInput[],
  actual: readonly MaterialProgramVertexInput[],
): boolean {
  const admissions = ownedVertexInputs.get(actual)?.admissions;
  const retained = admissions?.get(expected);
  if (retained !== undefined) return retained;
  const matches = expected.every((input) =>
    actual.some(
      (candidate) =>
        candidate.semantic === input.semantic &&
        candidate.location === input.location &&
        candidate.format === input.format,
    ),
  );
  if (admissions !== undefined && isImmutableVertexInputs(expected)) {
    admissions.set(expected, matches);
  }
  return matches;
}

function hasMaterialResources(material: MaterialSnapshot, receipt: MaterialProgramAbi) {
  // Video frames and renderer-local target sources have no stable
  // scene-index binding in this feature. Extract keeps those draws on the
  // explicit CPU semantic lane; direct contract callers must fail closed too.
  if ((material.textureSources?.size ?? 0) > 0 || (material.videoTextureFields?.size ?? 0) > 0) {
    return false;
  }
  const textures = material.textureHandles;
  const samplers = material.samplerHandles;
  const authoredTextures = material.authoredTextureFields;
  const authoredSamplers = material.authoredSamplerFields;
  // Standard PBR declares optional texture slots whose missing values are
  // supplied by the existing frame material producer (white, flat-normal,
  // black, or the configured IBL defaults). Only an explicitly authored slot
  // is a readiness requirement; this keeps numeric-only PBR on the same GPU
  // lane while still rejecting an authored handle that failed to resolve.
  return receipt.resourceSlots.every((slot) => {
    // The renderer-owned Surface page is the one storage resource that is
    // intentionally available to a scene-index draw. Its address is
    // published in the Surface ABI; every other storage declaration still
    // fails closed because MaterialSnapshot has no generic storage handle.
    if (slot.kind === 'storage-buffer') {
      return (
        receipt.surface?.dynamicInput?.group === slot.group &&
        receipt.surface.dynamicInput.binding === slot.binding &&
        slot.group === 3 &&
        slot.binding === 3
      );
    }
    if (slot.kind === 'texture') {
      if (!authoredTextures?.has(slot.parameter)) return true;
      return (
        textures?.has(slot.parameter) === true ||
        material.textureSources?.has(slot.parameter) === true ||
        material.videoTextureFields?.has(slot.parameter) === true
      );
    }
    if (!authoredSamplers?.has(slot.parameter)) return true;
    return samplers?.has(slot.parameter) === true;
  });
}

export function prepareGpuDrivenDraw(
  input: PrepareGpuDrivenDrawInput,
):
  | { readonly ok: true; readonly value: PreparedGpuDrivenDraw }
  | { readonly ok: false; readonly error: GpuDrivenPreparationError } {
  const receipt = input.artifact.receipt;
  if (receipt === undefined || receipt.sceneIndexEntry === undefined) {
    return failure('missing-material-receipt', {
      reason: 'material-receipt-missing',
      owner: 'material',
      expected: 'MaterialShaderArtifact.receipt',
    });
  }
  if (receipt.generation !== input.generation) {
    return failure('stale-generation', {
      reason: 'generation-stale',
      owner: 'generation',
      expectedGeneration: input.generation,
      actualGeneration: receipt.generation,
    });
  }
  if (receipt.reflection.layoutIdentity !== input.artifact.layoutIdentity) {
    return failure('reflection-mismatch', {
      reason: 'reflection-receipt-mismatch',
      owner: 'material',
      expected: input.artifact.layoutIdentity,
      actual: receipt.reflection.layoutIdentity,
    });
  }
  if (receipt.uvSets.some((uv) => uv.set > 0) && input.geometry.vertexInputs.length < 3) {
    return failure('missing-uv', {
      reason: 'uv-set-missing',
      owner: 'geometry',
      expected: `${receipt.uvSets.length} material UV sets`,
      actual: `${input.geometry.vertexInputs.filter((vertex) => vertex.semantic.startsWith('uv')).length} geometry UV sets`,
    });
  }
  if (!hasRequiredVertexInputs(receipt.vertexInputs, input.geometry.vertexInputs)) {
    return failure('vertex-input-mismatch', {
      reason: 'vertex-semantic-mismatch',
      owner: 'geometry',
      expected: receipt.vertexInputs.map((input) => input.semantic).join(','),
      actual: input.geometry.vertexInputs.map((input) => input.semantic).join(','),
    });
  }
  const hasAlphaMask = receipt.alphaMask.cutoff.length > 0 || receipt.alphaMask.source.length > 0;
  if (
    hasAlphaMask &&
    (receipt.alphaMask.cutoff.length === 0 || receipt.alphaMask.source.length === 0)
  ) {
    return failure('alpha-mask-mismatch', {
      reason: 'alpha-mask-receipt-missing',
      owner: 'material',
      expected: 'alphaMask.cutoff and alphaMask.source for a masked Pass',
    });
  }
  if (!hasMaterialResources(input.material, receipt)) {
    return failure('resource-not-ready', {
      reason: 'material-resource-missing',
      owner: 'material',
      expected: receipt.resourceSlots.map((slot) => slot.parameter).join(','),
    });
  }
  const deformation = input.deformation;
  if (deformation === 'skin' && !materialProgramUsesSkin(receipt)) {
    return failure('skin-receipt-mismatch', {
      reason: 'skin-inputs-missing',
      owner: 'skin',
      expected: 'a material ABI with paired Skin vertex inputs',
    });
  }
  return {
    ok: true,
    value: freezePreparedGpuDrivenDraw({
      identity: Object.freeze({
        material: input.artifact.material,
        geometry: input.geometry.identity,
        deformation,
      }),
      receiptGeneration: receipt.generation,
      receiptIdentity: receipt.receiptIdentity,
      directEntry: receipt.directEntry,
      sceneIndexEntry: receipt.sceneIndexEntry,
      materialRow: receipt.materialRow,
      resourceSlots: receipt.resourceSlots,
      uvSets: receipt.uvSets,
      vertexInputs: receipt.vertexInputs,
      alphaMask: receipt.alphaMask,
      topology: input.draw.topology,
      indexed: input.draw.kind === 'indexed',
      first: input.draw.first,
      count: input.draw.count,
      baseVertex: input.draw.baseVertex,
    }),
  };
}
