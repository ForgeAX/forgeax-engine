import { RAY_QUERY_FEATURE, type RhiAdapter, type RhiDevice } from '@forgeax/engine-rhi';
import {
  type StandardSharedTransmissionHost,
  standardSharedTransmissionConflicts,
} from '@forgeax/engine-shader';
import { ATMOSPHERE_REQUIRED_SAMPLED_TEXTURES } from '../environment/capability';
import { EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES } from '../prepare/extended-lighting/resources';
import type { MaterialSnapshot } from '../render-system-extract';
import { DEFERRED_ATTACHMENT_BYTES, SUBSURFACE_ATTACHMENT_BYTES } from '../standard-attachments';
import { standardTransmissionValue } from '../transmission/projection';
import { STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES } from './shader-prewarm-policy';

const COMPRESSION_FEATURES: GPUFeatureName[] = [
  'texture-compression-bc',
  'texture-compression-etc2',
  'texture-compression-astc',
];

// The Standard transmission fragment ABI needs 21 sampled textures across its
// material, IBL, clustered-light, and SSAO bindings. Ordinary Standard draws
// omit both transmission maps and the backdrop and remain valid on the WebGPU minimum of
// 16. The extended-lighting topology reserves 24, so a device descriptor must
// request that larger limit when the adapter can provide it; adapter limits are
// not automatically inherited by requestDevice().
export { STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES };

export function transmissionBackdropAvailable(limit: number | undefined): boolean {
  return limit === undefined || limit >= STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES;
}

/**
 * How one Standard transmission material fits the sampled-texture budget.
 * `dedicated` uses the full layout; `shared` binds transmission, thickness and
 * the backdrop through the split metallic/roughness/alpha pairs of the fixed
 * 16-texture layout; `exceeded` names the authored maps that occupy those pairs.
 */
export type StandardTransmissionSlotAdmission =
  | { readonly kind: 'dedicated' }
  | { readonly kind: 'shared' }
  | {
      readonly kind: 'exceeded';
      readonly conflicts: readonly StandardSharedTransmissionHost[];
    };

/**
 * Admit a Standard transmission material against the sampled-texture budget.
 * The canonical boot schema reserves transmission fields even for base-only
 * materials, so presence comes from authored data. `undefined` means the draw
 * requests no transmission; below the dedicated budget the material either
 * shares the split scalar-map pairs or is `exceeded` and renders without it.
 */
export function standardTransmissionAdmission(
  material: Pick<
    MaterialSnapshot,
    'materialShaderId' | 'surfaceModel' | 'paramSnapshot' | 'standardTextureMask'
  >,
  sampledTextureLimit: number | undefined,
): StandardTransmissionSlotAdmission | undefined {
  if (standardTransmissionValue(material) === undefined) return undefined;
  if (transmissionBackdropAvailable(sampledTextureLimit)) return { kind: 'dedicated' };
  const conflicts = standardSharedTransmissionConflicts(material.standardTextureMask ?? 0);
  return conflicts.length === 0 ? { kind: 'shared' } : { kind: 'exceeded', conflicts };
}

/**
 * The complete Standard physical root can declare all optional texture slots.
 * Its material group therefore needs two more sampled-texture entries than the
 * extended-lighting topology alone. Request this ceiling when the adapter can
 * provide it; lower-capability devices remain fail-closed at material
 * pipeline admission instead of receiving an invalid WebGPU layout.
 */
export const STANDARD_PHYSICAL_REQUIRED_SAMPLED_TEXTURES = 27;

export interface DeviceFeatureAdmission {
  readonly requiredFeatures: GPUFeatureName[];
  readonly requiredLimits?: {
    readonly maxSampledTexturesPerShaderStage?: number;
    readonly maxColorAttachmentBytesPerSample?: number;
    readonly maxComputeWorkgroupStorageSize?: number;
  };
}

type AdapterFeatureProbe = Pick<RhiAdapter, 'features'> & Partial<Pick<RhiAdapter, 'limits'>>;

export function deriveDeviceFeatureAdmission(adapter: AdapterFeatureProbe): DeviceFeatureAdmission {
  const requiredFeatures: GPUFeatureName[] = [
    'depth32float-stencil8',
    ...COMPRESSION_FEATURES.filter((feature) => adapter.features.has(feature)),
  ];
  // GPU-driven draws can address one shared visible stream instead of
  // binding an individual storage window for every batch and LOD level.
  if (adapter.features.has('indirect-first-instance')) {
    requiredFeatures.push('indirect-first-instance');
  }
  // Camera companions may enable DRS after device creation. Admitting the
  // feature allocates no queries; the timing owner still follows frame demand.
  if (adapter.features.has('timestamp-query')) {
    requiredFeatures.push('timestamp-query');
  }
  // SSS can be enabled after construction. Admit precise HDR sampling/blending
  // and bounded workgroup scratch without allocating any effect resources.
  for (const feature of ['float32-filterable', 'float32-blendable'] as const) {
    if (adapter.features.has(feature)) requiredFeatures.push(feature);
  }
  // Native wgpu exposes hardware Ray Query as an extension feature; admitting it
  // lets the GI lanes select `traversal: 'ray-query'` from `caps.rayQuery`.
  const rayQuery = RAY_QUERY_FEATURE as GPUFeatureName;
  if (adapter.features.has(rayQuery)) requiredFeatures.push(rayQuery);
  const adapterSampledTextureLimit = adapter.limits?.maxSampledTexturesPerShaderStage ?? 0;
  const visibleSurface =
    adapter.features.has('primitive-index') &&
    (adapter.limits?.maxColorAttachments ?? 0) >= 7 &&
    (adapter.limits?.maxColorAttachmentBytesPerSample ?? 0) >=
      DEFERRED_ATTACHMENT_BYTES.visibleSurface;
  if (visibleSurface) requiredFeatures.push('primitive-index');
  // Request the real Standard attachment footprint, including receiver channels
  // and temporal/visible-surface metadata, only when the adapter
  // supports it; graph admission keeps the independent raster otherwise.
  const colorAttachmentBytes = adapter.limits?.maxColorAttachmentBytesPerSample ?? 0;
  const workgroupStorage =
    (adapter.limits?.maxComputeWorkgroupStorageSize ?? 0) >= 32768 ? 32768 : undefined;
  const requiredColorAttachmentBytes = visibleSurface
    ? Math.min(colorAttachmentBytes, SUBSURFACE_ATTACHMENT_BYTES.visibleSurfaceTemporal)
    : colorAttachmentBytes >= DEFERRED_ATTACHMENT_BYTES.surface
      ? Math.min(colorAttachmentBytes, SUBSURFACE_ATTACHMENT_BYTES.temporal)
      : undefined;
  const requiredSampledTextureLimit =
    adapterSampledTextureLimit >= ATMOSPHERE_REQUIRED_SAMPLED_TEXTURES
      ? ATMOSPHERE_REQUIRED_SAMPLED_TEXTURES
      : adapterSampledTextureLimit >= STANDARD_PHYSICAL_REQUIRED_SAMPLED_TEXTURES
        ? STANDARD_PHYSICAL_REQUIRED_SAMPLED_TEXTURES
        : adapterSampledTextureLimit >= EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES
          ? EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES
          : adapterSampledTextureLimit >= STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES
            ? STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES
            : undefined;
  return {
    requiredFeatures,
    ...(requiredSampledTextureLimit === undefined &&
    requiredColorAttachmentBytes === undefined &&
    workgroupStorage === undefined
      ? {}
      : {
          requiredLimits: {
            ...(requiredSampledTextureLimit === undefined
              ? {}
              : { maxSampledTexturesPerShaderStage: requiredSampledTextureLimit }),
            ...(requiredColorAttachmentBytes === undefined
              ? {}
              : { maxColorAttachmentBytesPerSample: requiredColorAttachmentBytes }),
            ...(workgroupStorage === undefined
              ? {}
              : { maxComputeWorkgroupStorageSize: workgroupStorage }),
          },
        }),
  };
}

export function deviceOptionsForAdapter(
  adapter: AdapterFeatureProbe,
): DeviceFeatureAdmission | undefined {
  const admission = deriveDeviceFeatureAdmission(adapter);
  return admission.requiredFeatures.length === 0 && admission.requiredLimits === undefined
    ? undefined
    : admission;
}

export function isTimestampQueryAdmitted(
  caps: Pick<RhiDevice['caps'], 'timestampQuery' | 'timestampPeriodNanoseconds'>,
): boolean {
  return (
    caps.timestampQuery === true &&
    caps.timestampPeriodNanoseconds !== null &&
    Number.isFinite(caps.timestampPeriodNanoseconds) &&
    caps.timestampPeriodNanoseconds > 0
  );
}

/** WebGPU limits may be prototype accessors; publish their numeric POD values. */
export function inspectDeviceCapabilities(device: RhiDevice) {
  const numeric: Record<string, number> = {};
  for (const key in device.limits) {
    const value = device.limits[key as keyof typeof device.limits];
    if (typeof value === 'number') numeric[key] = value;
  }
  return { capabilities: Object.freeze({ ...device.caps }), limits: Object.freeze(numeric) };
}
