import { RAY_QUERY_FEATURE } from '@forgeax/engine-rhi';
import { stripWgslComments } from '@forgeax/engine-types';
import type { Tape } from '../protocol/types';
import type { RhiCapsRecorded } from '../types';

export const RECORDED_CAPABILITY_FEATURES = [
  ['timestampQuery', 'timestamp-query'],
  ['textureCompressionBc', 'texture-compression-bc'],
  ['textureCompressionEtc2', 'texture-compression-etc2'],
  ['textureCompressionAstc', 'texture-compression-astc'],
  ['firstInstanceIndirect', 'indirect-first-instance'],
  ['float32Filterable', 'float32-filterable'],
  ['rg11b10ufloatRenderable', 'rg11b10ufloat-renderable'],
] as const satisfies readonly (readonly [keyof RhiCapsRecorded, GPUFeatureName])[];

const WGSL_FEATURES = new Map<string, GPUFeatureName>([
  ['f16', 'shader-f16'],
  ['subgroups', 'subgroups'],
  ['primitive_index', 'primitive-index'],
]);

/** Whether replaying the tape creates or builds acceleration structures. */
export function usesAccelerationStructures(tape: Tape): boolean {
  return (
    tape.bootstrap.some((resource) => resource.kind === 'acceleration-structure') ||
    tape.events.some(
      (event) =>
        event.kind === 'createBlas' ||
        event.kind === 'createTlas' ||
        event.kind === 'buildAccelerationStructures',
    )
  );
}

/** Derive descriptor requirements from the captured resources, including bootstrap shaders. */
export function requiredReplayDescriptorFeatures(tape: Tape): ReadonlySet<GPUFeatureName> {
  const features = new Set<GPUFeatureName>();
  for (const event of [...tape.bootstrap.map((resource) => resource.create), ...tape.events]) {
    if (event.kind === 'createRenderPipeline') {
      const targets = (event.desc as GPURenderPipelineDescriptor).fragment?.targets ?? [];
      for (const target of targets) {
        if (
          target?.blend !== undefined &&
          ['r32float', 'rg32float', 'rgba32float'].includes(target.format)
        ) {
          features.add('float32-blendable');
        }
      }
    }
    if (event.kind === 'createBindGroupLayout') {
      const entries = (event.desc as GPUBindGroupLayoutDescriptor).entries;
      for (const entry of entries) {
        const storage = entry.storageTexture;
        // Core read access only covers the three R32 formats. Other captured
        // read-only/read-write formats require tier2 on the fresh device too.
        if (
          storage !== undefined &&
          (storage.access === 'read-only' || storage.access === 'read-write') &&
          !['r32float', 'r32sint', 'r32uint'].includes(storage.format)
        ) {
          features.add('texture-formats-tier2' as GPUFeatureName);
        }
      }
    }
    if (
      event.kind === 'createTexture' &&
      typeof event.desc === 'object' &&
      event.desc !== null &&
      'format' in event.desc &&
      event.desc.format === 'depth32float-stencil8'
    ) {
      features.add('depth32float-stencil8');
    }
    if (event.kind === 'createShaderModule' && typeof event.wgslCode === 'string') {
      for (const directive of stripWgslComments(event.wgslCode).matchAll(/\benable\s+([^;]+);/g)) {
        for (const extension of (directive[1] ?? '').split(',')) {
          const feature = WGSL_FEATURES.get(extension.trim());
          if (feature !== undefined) features.add(feature);
        }
      }
    }
  }
  return features;
}

/**
 * Build the strongest fresh WebGPU device the current adapter can provide for
 * a recorded tape. Optional features must be enabled, not merely advertised,
 * and replay receives concrete adapter limits instead of lower device defaults.
 */
export function replayDeviceRequest(
  tape: Tape,
  adapterFeatures: ReadonlySet<GPUFeatureName>,
  adapterLimits: Readonly<Record<string, number>>,
): GPUDeviceDescriptor {
  const requiredFeatures: GPUFeatureName[] = RECORDED_CAPABILITY_FEATURES.filter(
    ([capability, feature]) =>
      tape.header.rhiCaps[capability] === true && adapterFeatures.has(feature),
  ).map(([, feature]) => feature);
  // Replay-owned per-pass timing needs timestamps even when the capture had none.
  if (!requiredFeatures.includes('timestamp-query') && adapterFeatures.has('timestamp-query'))
    requiredFeatures.push('timestamp-query');
  // Do not filter descriptor requirements against adapter support: an
  // unsupported replay must fail admission instead of compiling weaker work.
  requiredFeatures.push(...requiredReplayDescriptorFeatures(tape));
  // Acceleration structures only exist behind the Ray Query extension feature;
  // without it the fresh device reports caps.rayQuery unsupported.
  if (usesAccelerationStructures(tape)) requiredFeatures.push(RAY_QUERY_FEATURE as GPUFeatureName);
  const limitEntries = Object.entries(adapterLimits).filter(
    ([, value]) => Number.isFinite(value) && value >= 0,
  );
  const request: GPUDeviceDescriptor = {};
  if (requiredFeatures.length > 0) request.requiredFeatures = requiredFeatures;
  if (limitEntries.length > 0) {
    request.requiredLimits = Object.fromEntries(limitEntries) as NonNullable<
      GPUDeviceDescriptor['requiredLimits']
    >;
  }
  return request;
}
