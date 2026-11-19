import type { BindGroupLayout, RhiDevice, TextureView } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import type { ShaderEntryPointReads } from '@forgeax/engine-types';
import { createHdrpBindGroupLayoutDescriptor } from '../pbr-pipeline';
import type { PipelineState } from '../render-system';
import { isOwnedWaterMeshAdmissionUpload } from '../water/mesh-source-admission';
import {
  WATER_BODY_ONLY_BINDING_KEY,
  waterMaterialFrameBindGroupLayoutEntries,
} from '../water/wave-material';
import { resolveMaterialPipelineBindGroups } from './material/pipeline-helpers';
import type { LayoutKind } from './material-shader-policy';
import { completeFrameFailure } from './renderer-frame-transaction';

export function runSameWaterMeshDraw(
  left: import('../water/wave-material').WaterMeshInstanceDrawUpload,
  right: import('../water/wave-material').WaterMeshInstanceDrawUpload,
): boolean {
  if (left === right && isOwnedWaterMeshAdmissionUpload(left)) return true;
  if (
    left.bodyGuid !== right.bodyGuid ||
    left.bodyGeneration !== right.bodyGeneration ||
    left.zoneGeneration !== right.zoneGeneration ||
    left.viewIdentity !== right.viewIdentity ||
    left.transitionTargets.length !== right.transitionTargets.length ||
    left.transitionTargets.some((target, index) => {
      const other = right.transitionTargets[index];
      return (
        other === undefined ||
        target.instanceIndex !== other.instanceIndex ||
        target.bodyGuid !== other.bodyGuid ||
        target.bodyGeneration !== other.bodyGeneration ||
        target.zoneGeneration !== other.zoneGeneration
      );
    }) ||
    left.layout.schemaVersion !== right.layout.schemaVersion ||
    left.layout.strideBytes !== right.layout.strideBytes ||
    left.layout.byteLength !== right.layout.byteLength ||
    left.layout.coverageByteLength !== right.layout.coverageByteLength ||
    left.layout.layoutHash !== right.layout.layoutHash ||
    left.layout.dataHash !== right.layout.dataHash ||
    left.layout.coverageDataHash !== right.layout.coverageDataHash ||
    left.bytes.byteLength !== right.bytes.byteLength ||
    left.coverageBytes.byteLength !== right.coverageBytes.byteLength ||
    Object.keys(left.layout.offsets).length !== Object.keys(right.layout.offsets).length ||
    Object.entries(left.layout.offsets).some(
      ([name, offset]) => right.layout.offsets[name] !== offset,
    )
  )
    return false;
  const compareWaterMeshDrawBytes = () => {
    for (let index = 0; index < left.bytes.byteLength; index++)
      if (left.bytes[index] !== right.bytes[index]) return false;
    for (let index = 0; index < left.coverageBytes.byteLength; index++)
      if (left.coverageBytes[index] !== right.coverageBytes[index]) return false;
    return true;
  };
  return compareWaterMeshDrawBytes();
}

export function runWaterMaterialFrameTargetsMatch(
  bindings: ReadonlyMap<string, import('../water/wave-material').WaterMaterialFrameBindings>,
  views: ReadonlyMap<string, TextureView>,
): boolean {
  for (const [targetName, view] of views)
    if (bindings.get(targetName)?.waterInfoTextureView !== view) return false;
  for (const targetName of bindings.keys())
    if (targetName !== WATER_BODY_ONLY_BINDING_KEY && !views.has(targetName)) return false;
  return true;
}

export function runDestroyWaterMaterialFrameEntry(
  internals: import('./webgpu-renderer-contract').WebGPURendererInternals,
  waterMaterialBuffers: (
    bindings: import('../water/wave-material').WaterMaterialFrameGpuBuffers,
  ) => import('@forgeax/engine-rhi').Buffer[],
  device: RhiDevice,
  entry: {
    lifetime: 'active' | 'retiring' | 'destroyed';
    readonly deviceGeneration: number;
    readonly bindings: ReadonlyMap<
      string,
      import('../water/wave-material').WaterMaterialFrameBindings
    >;
    readonly retiredBuffers: readonly (readonly import('@forgeax/engine-rhi').Buffer[])[];
  },
): void {
  if (entry.lifetime === 'destroyed') return;
  entry.lifetime = 'destroyed';
  const destroy = (buffer: import('@forgeax/engine-rhi').Buffer): void => {
    try {
      const result = device.destroyBuffer(buffer);
      if (!result.ok) internals.errorRegistry.fire(result.error);
    } catch (cause) {
      internals.errorRegistry.fire(completeFrameFailure(undefined, entry.deviceGeneration, cause));
    }
  };
  const buffers = new Set<import('@forgeax/engine-rhi').Buffer>();
  for (const bindings of entry.bindings.values())
    for (const buffer of waterMaterialBuffers(bindings)) buffers.add(buffer);
  for (const retired of entry.retiredBuffers) for (const buffer of retired) buffers.add(buffer);
  for (const buffer of buffers) destroy(buffer);
}

export function runWaterMaterialFrameLayout(
  waterWavesBindGroupLayouts: WeakMap<
    object,
    Map<string, import('@forgeax/engine-rhi').BindGroupLayout>
  >,
  currentBuildDevice: () => import('@forgeax/engine-rhi').RhiDevice,
  internals: import('./webgpu-renderer-contract').WebGPURendererInternals,
  state: PipelineState,
  waterInfoFormat: 'rgba16float' | 'rgba32float' | 'none',
): BindGroupLayout | undefined {
  let layouts = waterWavesBindGroupLayouts.get(state as object);
  if (layouts === undefined) {
    layouts = new Map();
    waterWavesBindGroupLayouts.set(state as object, layouts);
  }
  const cached = layouts.get(`frame:${waterInfoFormat}`);
  if (cached !== undefined) return cached;
  const created = currentBuildDevice().createBindGroupLayout({
    label: `water-material-frame-layout:${waterInfoFormat}`,
    entries: waterMaterialFrameBindGroupLayoutEntries(
      waterInfoFormat === 'none' ? undefined : waterInfoFormat,
      0,
      undefined,
      waterInfoFormat !== 'none',
    ),
  });
  if (!created.ok) {
    internals.errorRegistry.fire(created.error);
    return undefined;
  }
  layouts.set(`frame:${waterInfoFormat}`, created.value);
  return created.value;
}

export function runWaterMaterialGroup2Layout(
  waterWavesBindGroupLayouts: WeakMap<
    object,
    Map<string, import('@forgeax/engine-rhi').BindGroupLayout>
  >,
  currentBuildDevice: () => import('@forgeax/engine-rhi').RhiDevice,
  internals: import('./webgpu-renderer-contract').WebGPURendererInternals,
  state: PipelineState,
  layoutKind: LayoutKind,
  waterInfoFormat: 'rgba16float' | 'rgba32float' | undefined,
  entryPoints?: readonly ShaderEntryPointReads[],
): BindGroupLayout | undefined {
  let layouts = waterWavesBindGroupLayouts.get(state as object);
  if (layouts === undefined) {
    layouts = new Map();
    waterWavesBindGroupLayouts.set(state as object, layouts);
  }
  const waterEntries = waterMaterialFrameBindGroupLayoutEntries(waterInfoFormat, 16, entryPoints);
  const key = `group2:${layoutKind}:${waterInfoFormat}:${waterEntries.map((entry) => `${entry.binding}:${entry.visibility}`).join(',')}`;
  const cached = layouts.get(key);
  if (cached !== undefined) return cached;
  const baseEntries: import('@forgeax/engine-rhi').BindGroupLayoutEntry[] =
    layoutKind === 'hdrp-pbr'
      ? createHdrpBindGroupLayoutDescriptor(currentBuildDevice().caps.storageBuffer).entries
      : [
          {
            binding: 0,
            visibility: 3,
            buffer: {
              type: currentBuildDevice().caps.storageBuffer ? 'read-only-storage' : 'uniform',
              hasDynamicOffset: true,
            },
          },
        ];
  const created = currentBuildDevice().createBindGroupLayout({
    label: `water-waves-${layoutKind}-group2:${waterInfoFormat}`,
    entries: [...baseEntries, ...waterEntries],
  });
  if (!created.ok) {
    internals.errorRegistry.fire(created.error);
    return undefined;
  }
  layouts.set(key, created.value);
  return created.value;
}

export function runWaterWavesPipelineLayout(
  currentBuildDevice: () => import('@forgeax/engine-rhi').RhiDevice,
  internals: import('./webgpu-renderer-contract').WebGPURendererInternals,
  waterWavesPipelineLayouts: WeakMap<
    object,
    Map<
      string,
      {
        readonly pipelineLayout: import('@forgeax/engine-rhi').PipelineLayout;
        readonly group2Layout: import('@forgeax/engine-rhi').BindGroupLayout;
      }
    >
  >,
  waterMaterialGroup2Layout: (
    state: import('../record/render-context').PipelineState,
    layoutKind: import('./material-shader-policy').LayoutKind,
    waterInfoFormat: 'rgba16float' | 'rgba32float' | undefined,
    entryPoints?: readonly import('@forgeax/engine-types').ShaderEntryPointReads[] | undefined,
  ) => import('@forgeax/engine-rhi').BindGroupLayout | undefined,
  state: PipelineState | null,
  layoutKind: LayoutKind,
  probeBlend: boolean,
  waterInfoFormat: 'rgba16float' | 'rgba32float' | undefined,
  materialBgl: BindGroupLayout | undefined,
  shaderIdentity: string,
  entryPoints?: readonly ShaderEntryPointReads[],
): {
  readonly pipelineLayout: import('@forgeax/engine-rhi').PipelineLayout;
  readonly group2Layout: BindGroupLayout;
} | null {
  if (state === null) return null;
  const meshLayoutKind =
    layoutKind === 'hdrp-pbr' || layoutKind === 'surface-direct-cluster-pbr'
      ? 'hdrp-pbr'
      : layoutKind === 'pbr' || layoutKind === 'surface-direct-pbr'
        ? 'pbr'
        : undefined;
  if (meshLayoutKind === undefined) return null;
  const limits = currentBuildDevice().limits;
  const requiredLimits = {
    maxBindingsPerBindGroup:
      meshLayoutKind === 'hdrp-pbr' ? (currentBuildDevice().caps.storageBuffer ? 16 : 12) : 10,
    maxUniformBuffersPerShaderStage: 7,
    maxSampledTexturesPerShaderStage: 1,
  } as const;
  const exceeded = Object.entries(requiredLimits).find(
    ([name, required]) => Number(limits[name as keyof typeof limits] ?? 0) < required,
  );
  if (!currentBuildDevice().caps.storageBuffer || exceeded !== undefined) {
    const [name, required] = exceeded ?? ['storageBuffer', 1];
    const actual =
      name === 'storageBuffer'
        ? Number(currentBuildDevice().caps.storageBuffer)
        : Number(limits[name as keyof typeof limits] ?? 0);
    internals.errorRegistry.fire(
      new RhiError({
        code: 'limit-exceeded',
        expected: `Water wave group(2) layout requires ${name} >= ${required}`,
        hint: `use a device satisfying the ${layoutKind} water layout limit ${name} >= ${required}; current value is ${actual} for ${waterInfoFormat}`,
      }),
    );
    return null;
  }
  let layouts = waterWavesPipelineLayouts.get(state as object);
  if (layouts === undefined) {
    layouts = new Map();
    waterWavesPipelineLayouts.set(state as object, layouts);
  }
  const key = `${shaderIdentity}:${layoutKind}:${probeBlend}:${waterInfoFormat}`;
  const cached = layouts.get(key);
  if (cached !== undefined) return cached;
  const group2 = waterMaterialGroup2Layout(state, meshLayoutKind, waterInfoFormat, entryPoints);
  const group3 = resolveMaterialPipelineBindGroups(
    layoutKind,
    state,
    false,
    probeBlend,
  )?.instancesLayout;
  if (group2 === undefined || group3 == null) return null;
  const created = currentBuildDevice().createPipelineLayout({
    label: `water-waves-${layoutKind}-pipeline-layout`,
    bindGroupLayouts: [
      state.viewBindGroupLayout,
      materialBgl ?? state.materialBindGroupLayout,
      group2,
      group3,
    ],
  });
  if (!created.ok) {
    internals.errorRegistry.fire(created.error);
    return null;
  }
  const layout = { pipelineLayout: created.value, group2Layout: group2 };
  layouts.set(key, layout);
  return layout;
}
