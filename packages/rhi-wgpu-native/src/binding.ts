// The Node-API surface of `node/` (napi-rs exposes Rust snake_case methods as camelCase).
// Objects cross the boundary as numeric table ids; descriptors and command recordings
// cross as JSON. Id 0 is the invalid object of a failed creation, whose error the device
// already routed through its error scopes.

import { createRequire } from 'node:module';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';

export interface NativeDevice {
  features(): string[];
  limits(): string;
  timestampPeriod(): number;
  pushErrorScope(filter: string): void;
  popErrorScope(): string;
  drainErrors(): string;
  lostInfo(): string[] | null;
  destroy(): void;
  release(id: number): void;
  reportValidationError(message: string): void;
  createBuffer(descriptor: string): number;
  bufferMap(id: number, mode: number, offset: number, size: number): string | null;
  bufferReadMapped(id: number, offset: number, size: number): Uint8Array;
  bufferWriteMapped(id: number, offset: number, data: Uint8Array): void;
  bufferUnmap(id: number): void;
  bufferDestroy(id: number): void;
  createTexture(descriptor: string): number;
  textureDestroy(id: number): void;
  createView(textureId: number, descriptor: string): number;
  createSampler(descriptor: string): number;
  createShaderModule(code: string, label: string | null): string;
  createBindGroupLayout(descriptor: string): number;
  createPipelineLayout(descriptor: string): number;
  createBindGroup(descriptor: string): number;
  createRenderPipeline(descriptor: string): number;
  createComputePipeline(descriptor: string): number;
  pipelineBindGroupLayout(pipeline: number, index: number): number;
  createQuerySet(descriptor: string): number;
  querySetDestroy(id: number): void;
  createBlas(descriptor: string): number;
  createTlas(descriptor: string): number;
  finishEncoder(recording: string): number;
  finishBundle(descriptor: string, recording: string): number;
  queueSubmit(ids: number[]): boolean;
  queueWriteBuffer(id: number, offset: number, data: Uint8Array): void;
  queueWriteTexture(descriptor: string, data: Uint8Array): void;
  queueWait(): void;
}

export interface NativeAdapter {
  features(): string[];
  limits(): string;
  info(): string;
  requestDevice(descriptor: string): NativeDevice;
}

export interface NativeBinding {
  wgpuVersion(): string;
  readonly NativeWindow: new (options: string) => NativeWindowBinding;
  preferredCanvasFormat?(): GPUTextureFormat;
  requestAdapter(
    powerPreference: string | null,
    forceFallbackAdapter: boolean | null,
  ): NativeAdapter | null;
}

export interface NativeWindowBinding {
  requestAdapter(
    powerPreference: string | null,
    forceFallbackAdapter: boolean | null,
  ): NativeAdapter | null;
  preferredFormat(): GPUTextureFormat;
  supportedAlphaModes(): GPUCanvasAlphaMode[];
  configure(device: NativeDevice, descriptor: string): void;
  acquireTexture(device: NativeDevice): number;
  present(): void;
  unconfigure(): void;
  facts(): string;
  resize(width: number, height: number): void;
  requestRedraw(): void;
  pollEvents(): string;
  close(): void;
}

/** Where `pnpm --filter @forgeax/engine-rhi-wgpu-native build:native` places the addon. */
export const NATIVE_ADDON_PATH = `../native/forgeax-rhi-wgpu-native.${process.platform}-${process.arch}.node`;

let cached: Result<NativeBinding, RhiError> | undefined;

/** Load the opt-in addon once; a missing or unloadable binary is `adapter-unavailable`. */
export function loadNativeBinding(): Result<NativeBinding, RhiError> {
  if (cached !== undefined) return cached;
  const override = process.env.FORGEAX_RHI_WGPU_NATIVE_ADDON;
  const path = override !== undefined && override !== '' ? override : NATIVE_ADDON_PATH;
  try {
    const require = createRequire(import.meta.url);
    cached = ok(require(path) as NativeBinding);
  } catch (cause) {
    cached = err(
      new RhiError({
        code: 'adapter-unavailable',
        expected: `the native wgpu addon at ${path}`,
        hint: `build it with \`pnpm --filter @forgeax/engine-rhi-wgpu-native build:native\` (Rust toolchain required) or set FORGEAX_RHI_WGPU_NATIVE_ADDON; load failure: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    );
  }
  return cached;
}
