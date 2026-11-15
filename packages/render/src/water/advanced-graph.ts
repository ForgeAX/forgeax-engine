import type { BindGroupLayoutEntry } from '@forgeax/engine-types';
import type {
  RenderFeaturePassDeclaration,
  RenderFeatureResourceDeclaration,
} from '../features/plan';
import type { RenderFeatureGpuBufferInitialization } from '../features/types';

export const read = (
  binding: number,
  dimension: '2d' | '2d-array' = '2d',
): BindGroupLayoutEntry => ({
  binding,
  visibility: 4,
  texture: { sampleType: 'unfilterable-float', viewDimension: dimension },
});
export const write = (
  binding: number,
  format: 'r32float' | 'rgba16float' | 'rgba32float',
): BindGroupLayoutEntry => ({
  binding,
  visibility: 4,
  storageTexture: { access: 'write-only', format, viewDimension: '2d' },
});
export const storage = (binding: number, writable = false): BindGroupLayoutEntry => ({
  binding,
  visibility: 4,
  buffer: { type: writable ? 'storage' : 'read-only-storage' },
});
export function texture(
  name: string,
  width: number,
  height: number,
  format: 'r32float' | 'rgba8unorm' | 'rgba16float' | 'rgba32float',
  allocationKey: string,
  persistent = false,
  materialSource = false,
): RenderFeatureResourceDeclaration {
  return {
    kind: 'graph-texture',
    name,
    allocationKey,
    materialSource,
    descriptor: {
      format,
      size: { width, height, depthOrArrayLayers: 1 },
      sampleCount: 1,
      dimension: '2d',
      lifetime: persistent ? 'persistent' : 'transient',
      usage: 0x01 | 0x04 | 0x10 | (format === 'rgba8unorm' ? 0 : 0x08),
    },
  };
}
export function buffer(
  name: string,
  data: Float32Array | Uint8Array,
): RenderFeatureResourceDeclaration {
  return { kind: 'buffer', name, size: Math.max(16, data.byteLength), usage: ['storage'], data };
}
export function initializedBuffer(
  name: string,
  initialization: RenderFeatureGpuBufferInitialization,
): RenderFeatureResourceDeclaration {
  return {
    kind: 'buffer',
    name,
    allocationKey: initialization.version,
    size: Math.max(16, initialization.byteLength),
    usage: ['storage'],
    initialization,
  };
}
export function view(name: string, target: string): RenderFeatureResourceDeclaration {
  return {
    kind: 'prepared-gpu-resource',
    name,
    resource: { kind: 'texture-view', value: undefined },
    logicalTarget: target,
  };
}
export function program(
  name: string,
  source: string,
  entry: string,
  entries: readonly BindGroupLayoutEntry[],
): RenderFeatureResourceDeclaration {
  return {
    kind: 'compute-program',
    name,
    preparePipelines: true,
    program: { wgsl: source, entryPoints: [entry], bindings: [{ entries }] },
  };
}
export function compute(
  resources: RenderFeatureResourceDeclaration[],
  passes: RenderFeaturePassDeclaration[],
  name: string,
  programName: string,
  entry: string,
  entries: readonly { readonly binding: number; readonly resource: string }[],
  width: number,
  height: number,
): void {
  const bindings = `${name}-bindings`;
  resources.push({ kind: 'compute-bindings', name: bindings, program: programName, entries });
  passes.push({
    kind: 'compute',
    name,
    program: programName,
    bindings,
    dispatches: [
      {
        kind: 'direct',
        entryPoint: entry,
        workgroups: [Math.ceil(width / 8), Math.ceil(height / 8), 1],
      },
    ],
  });
}
