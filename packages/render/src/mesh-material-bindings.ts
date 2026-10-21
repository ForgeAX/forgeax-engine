import type { AssetErrorDetail, AssetGuid, AssetHandle, MeshAsset } from '@forgeax/engine-types';

export type MeshMaterialBindingSource = 'renderer-override' | 'mesh-default' | 'engine-default';

export interface MeshMaterialBindingDiagnostic {
  readonly code:
    | 'mesh-renderer-material-override-invalid'
    | 'mesh-renderer-material-override-overflow';
  readonly slotIndex: number;
  readonly handle?: number;
  /** Structured detail mirrors the renderer error for the active frame. */
  readonly detail?: Readonly<AssetErrorDetail>;
}

/** Detached final-frame receipt for the Standard material IBL binding chain. */
export interface IblBindingResourceInspection {
  readonly viewIdentity: number;
  readonly samplerIdentity: number;
  readonly deviceGeneration: number;
}

export interface IblBindingEntryInspection {
  readonly binding: number;
  readonly kind: 'textureView' | 'sampler' | 'buffer';
  readonly resourceIdentity: number;
}

export interface IblBindingInspection {
  readonly status: 'binding-chain-consistent' | 'binding-chain-mismatch';
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly active: 'active' | 'fallback';
  readonly cache: {
    readonly identity: number;
    readonly generation: number;
    readonly prefilterMipCount: number;
    readonly prefilterViewMipCount: number;
  };
  readonly sampler: {
    readonly expected: {
      readonly magFilter: 'linear';
      readonly minFilter: 'linear';
      readonly mipmapFilter: 'linear';
      readonly addressModeU: 'clamp-to-edge';
      readonly addressModeV: 'clamp-to-edge';
      readonly addressModeW: 'clamp-to-edge';
    };
    readonly identities: readonly number[];
  };
  readonly resources: {
    readonly irradiance: IblBindingResourceInspection;
    readonly prefilter: IblBindingResourceInspection;
    readonly brdfLut: IblBindingResourceInspection;
    readonly intensityBufferIdentity: number;
  };
  readonly material?: {
    readonly bindGroupIdentity: number;
    readonly materialBglIdentity: number;
    readonly cache: 'hit' | 'miss';
    readonly skylightBindingStart: number;
    readonly entries: readonly IblBindingEntryInspection[];
    readonly reflectionBindings: readonly number[];
  };
  readonly pipeline?: {
    readonly pipelineIdentity: number;
    readonly effectiveMaterialLayoutIdentity: string | undefined;
    readonly materialBglIdentity: number;
    readonly bindGroupIdentity: number;
    readonly drawFrameId: number;
  };
  readonly errors: readonly string[];
}

export interface ResolvedMeshMaterialBinding {
  readonly handle: number;
  readonly source: MeshMaterialBindingSource;
}

/** Lifecycle values projected from an already prepared resident binding. */
export type MeshMaterialBindingReadiness = 'ready' | 'pending' | 'failed' | 'last-known-good';

/** Structured producer failure retained by the renderer's bounded projection. */
export interface MeshMaterialBindingPreparationFailure {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface MeshMaterialBindingSamplerObservation {
  readonly handle: number;
  readonly resident: boolean;
}

export interface MeshMaterialBindingTextureObservation {
  readonly handle: number;
  readonly mipLevelCount: number;
}

/**
 * One material-slot's bounded resident projection. The renderer reports only
 * resources it actually resolved for the slot; Pack/AssetRegistry lifecycle
 * records stay owned by the producer and are never copied here.
 */
export interface MeshMaterialBindingResidency {
  readonly readiness: MeshMaterialBindingReadiness;
  readonly samplers: readonly MeshMaterialBindingSamplerObservation[];
  readonly textures: readonly MeshMaterialBindingTextureObservation[];
  readonly preparationFailure?: MeshMaterialBindingPreparationFailure;
}

/** Public read-only observation of the bindings used by the last frame. */
export interface MeshMaterialBindingObservation {
  readonly worldId: number;
  /** Stable World identity for cross-world inspection; worldId is only a frame slot. */
  readonly worldIdentity?: string;
  readonly entityKey: number;
  readonly bindings: readonly ResolvedMeshMaterialBinding[];
  readonly diagnostics: readonly MeshMaterialBindingDiagnostic[];
  /** One resident projection per resolved material slot. */
  readonly residency: readonly MeshMaterialBindingResidency[];
}

export interface MeshMaterialBindingSummary {
  readonly total: number;
  readonly ready: number;
  readonly pending: number;
  readonly failed: number;
  readonly lastKnownGood: number;
  readonly textureCount: number;
  readonly samplerCount: number;
}

// Qualification belongs to the detached producer factory, never to shallow freezing.
const capturedResidencies = new WeakSet<MeshMaterialBindingResidency>();

function captureSampler(
  sampler: MeshMaterialBindingSamplerObservation,
): MeshMaterialBindingSamplerObservation {
  return Object.freeze({ ...sampler });
}
function captureTexture(
  texture: MeshMaterialBindingTextureObservation,
): MeshMaterialBindingTextureObservation {
  return Object.freeze({ ...texture });
}

function captureResidency(
  value: MeshMaterialBindingResidency,
  producer: boolean,
): MeshMaterialBindingResidency {
  return Object.freeze({
    ...value,
    samplers: Object.freeze(
      producer
        ? (Array.prototype.map.call(
            value.samplers,
            captureSampler,
          ) as MeshMaterialBindingSamplerObservation[])
        : value.samplers.map(captureSampler),
    ),
    textures: Object.freeze(
      producer
        ? (Array.prototype.map.call(
            value.textures,
            captureTexture,
          ) as MeshMaterialBindingTextureObservation[])
        : value.textures.map(captureTexture),
    ),
    ...(value.preparationFailure === undefined
      ? {}
      : {
          preparationFailure: Object.freeze({
            ...value.preparationFailure,
            ...(value.preparationFailure.detail === undefined
              ? {}
              : {
                  detail: Object.freeze({ ...value.preparationFailure.detail }),
                }),
          }),
        }),
  });
}

/** The material observer publishes detached data rows once per observed material. */
export function publishMeshMaterialBindingResidency(
  value: MeshMaterialBindingResidency,
): MeshMaterialBindingResidency {
  const captured = captureResidency(value, true);
  capturedResidencies.add(captured);
  return captured;
}

const EMPTY_RESIDENCY: MeshMaterialBindingResidency = publishMeshMaterialBindingResidency({
  readiness: 'pending',
  samplers: Object.freeze([]),
  textures: Object.freeze([]),
});

/**
 * Build the sole renderer observation projection from the resident seam.
 * Missing facts remain `pending`; they are never guessed from a URL, asset
 * name, or authoring field. Slot cardinality is normalized so aggregation is
 * deterministic even while a preparation candidate is incomplete.
 */
export function projectMeshMaterialBindingObservation(input: {
  readonly worldId: number;
  readonly worldIdentity?: string;
  readonly entityKey: number;
  readonly bindings: readonly ResolvedMeshMaterialBinding[];
  readonly diagnostics: readonly MeshMaterialBindingDiagnostic[];
  readonly residency?: readonly MeshMaterialBindingResidency[];
}): MeshMaterialBindingObservation {
  const residency = input.bindings.map((_, index) => {
    const value = input.residency?.[index] ?? EMPTY_RESIDENCY;
    return capturedResidencies.has(value) ? value : captureResidency(value, false);
  });
  return {
    worldId: input.worldId,
    ...(input.worldIdentity === undefined ? {} : { worldIdentity: input.worldIdentity }),
    entityKey: input.entityKey,
    bindings: Object.freeze([...input.bindings]),
    diagnostics: Object.freeze([...input.diagnostics]),
    residency: Object.freeze(residency),
  };
}

/** Recompute bounded readiness/resource counts from retained observations. */
export function summarizeMeshMaterialBindings(
  observations: readonly MeshMaterialBindingObservation[],
): MeshMaterialBindingSummary {
  let ready = 0;
  let pending = 0;
  let failed = 0;
  let lastKnownGood = 0;
  let textureCount = 0;
  let samplerCount = 0;
  for (const observation of observations) {
    for (const residency of observation.residency) {
      switch (residency.readiness) {
        case 'ready':
          ready += 1;
          break;
        case 'pending':
          pending += 1;
          break;
        case 'failed':
          failed += 1;
          break;
        case 'last-known-good':
          lastKnownGood += 1;
          break;
      }
      textureCount += residency.textures.length;
      samplerCount += residency.samplers.length;
    }
  }
  return {
    total: ready + pending + failed + lastKnownGood,
    ready,
    pending,
    failed,
    lastKnownGood,
    textureCount,
    samplerCount,
  };
}

export type ResolveMeshMaterialBindingsResult =
  | {
      readonly ok: true;
      readonly bindings: readonly ResolvedMeshMaterialBinding[];
      readonly diagnostics: readonly MeshMaterialBindingDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly code: 'mesh-material-slots-missing';
    }
  | {
      readonly ok: false;
      readonly code: 'mesh-default-material-not-ready';
      readonly slotIndex: number;
      readonly defaultMaterial: AssetGuid | AssetHandle<'material'>;
    };

/**
 * Single owner of the instance override -> mesh default -> engine default
 * inheritance rule. It resolves once per logical slot; submeshes only project
 * their materialSlot index onto the returned table.
 */
export function resolveMeshMaterialBindings(
  mesh: MeshAsset,
  rendererOverrides: ArrayLike<number>,
  deps: {
    readonly isValidOverride: (handle: number) => boolean;
    readonly resolveMeshDefault: (
      reference: AssetGuid | AssetHandle<'material'>,
    ) => number | undefined;
  },
): ResolveMeshMaterialBindingsResult {
  const bindings: ResolvedMeshMaterialBinding[] = [];
  const diagnostics: MeshMaterialBindingDiagnostic[] = [];

  if (!Array.isArray(mesh.materialSlots)) {
    return { ok: false, code: 'mesh-material-slots-missing' };
  }

  if (rendererOverrides.length > mesh.materialSlots.length) {
    diagnostics.push({
      code: 'mesh-renderer-material-override-overflow',
      slotIndex: mesh.materialSlots.length,
    });
  }

  for (let slotIndex = 0; slotIndex < mesh.materialSlots.length; slotIndex++) {
    const override = rendererOverrides[slotIndex] ?? 0;
    if (override !== 0 && deps.isValidOverride(override)) {
      bindings.push({ handle: override, source: 'renderer-override' });
      continue;
    }
    if (override !== 0) {
      diagnostics.push({
        code: 'mesh-renderer-material-override-invalid',
        slotIndex,
        handle: override,
      });
    }
    const declaredDefault = mesh.materialSlots[slotIndex]?.defaultMaterial;
    if (declaredDefault !== undefined) {
      const handle = deps.resolveMeshDefault(declaredDefault);
      if (handle === undefined) {
        return {
          ok: false,
          code: 'mesh-default-material-not-ready',
          slotIndex,
          defaultMaterial: declaredDefault,
        };
      }
      bindings.push({ handle, source: 'mesh-default' });
      continue;
    }
    bindings.push({ handle: 0, source: 'engine-default' });
  }

  return { ok: true, bindings, diagnostics };
}
