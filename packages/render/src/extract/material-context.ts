import type { MaterialCookRasterContext } from '@forgeax/engine-pack/material-cook';
import type { RhiCaps } from '@forgeax/engine-rhi';
import { STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES } from '../assembly/shader-prewarm-policy';
import { atmosphereAvailable } from '../environment/capability';
import { EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES } from '../prepare/extended-lighting/resources';

interface MaterialContextProjection {
  readonly materialContext: MaterialCookRasterContext;
}

function materialContextDefinition(
  backend: MaterialCookRasterContext['backend'],
  capability: MaterialCookRasterContext['capability'],
  visibleSurface: boolean,
): MaterialContextProjection {
  return Object.freeze({
    materialContext: Object.freeze({
      backend,
      capability,
      pipeline: 'forward',
      geometry: 'mesh',
      pass: 'forward',
      profile: 'forgeax-material-wgsl-v1',
      toolchain: 'naga-oil',
      instrumentation: 'none',
      ...(visibleSurface ? { visibleSurface: true } : {}),
    }),
  });
}

function materialContextPair(
  backend: MaterialCookRasterContext['backend'],
  capability: MaterialCookRasterContext['capability'],
) {
  return Object.freeze([
    materialContextDefinition(backend, capability, false),
    materialContextDefinition(backend, capability, true),
  ] as const);
}

function materialContextDefinitions(backend: MaterialCookRasterContext['backend']) {
  return Object.freeze({
    'uniform-fallback': materialContextPair(backend, 'uniform-fallback'),
    'storage-buffer-minimum': materialContextPair(backend, 'storage-buffer-minimum'),
    'storage-buffer-projector': materialContextPair(backend, 'storage-buffer-projector'),
    'storage-buffer': materialContextPair(backend, 'storage-buffer'),
    'storage-buffer-atmosphere': materialContextPair(backend, 'storage-buffer-atmosphere'),
  });
}

// The closed material domain has 30 immutable definitions, independent of the
// number or lifetime of devices, frames and borrowed capability objects.
const MATERIAL_CONTEXTS = Object.freeze({
  webgpu: materialContextDefinitions('webgpu'),
  webgl2: materialContextDefinitions('webgl2'),
  'wgpu-native': materialContextDefinitions('wgpu-native'),
});

/** The receiving device selects the immutable material program domain. */
export function renderMaterialContext(
  caps: Pick<RhiCaps, 'backendKind' | 'storageBuffer'>,
  limits?: Readonly<{ maxSampledTexturesPerShaderStage?: number }>,
  visibleSurface = false,
): {
  readonly materialContext?: MaterialCookRasterContext;
} {
  const backend =
    caps.backendKind === 'null'
      ? 'webgpu'
      : caps.backendKind === 'wgpu-webgl2'
        ? 'webgl2'
        : caps.backendKind;
  const capability = atmosphereAvailable(
    caps.storageBuffer,
    limits?.maxSampledTexturesPerShaderStage,
  )
    ? 'storage-buffer-atmosphere'
    : caps.storageBuffer
      ? limits?.maxSampledTexturesPerShaderStage === undefined ||
        limits.maxSampledTexturesPerShaderStage >= EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES
        ? 'storage-buffer'
        : limits.maxSampledTexturesPerShaderStage >= STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES
          ? 'storage-buffer-projector'
          : 'storage-buffer-minimum'
      : 'uniform-fallback';
  // Null records the WGSL material domain structurally. Its device/receipt
  // still reports `null`; this selection never claims GPU shader validation.
  if (backend === 'webgpu' || backend === 'webgl2' || backend === 'wgpu-native')
    return MATERIAL_CONTEXTS[backend][capability][visibleSurface ? 1 : 0];
  // Borrowed structural inputs can omit the receiving backend. Preserve their
  // original detached projection rather than retaining an unrecognized domain.
  return materialContextDefinition(backend, capability, visibleSurface);
}
