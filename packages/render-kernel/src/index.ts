// @forgeax/engine-render-kernel public entrypoint.

import type { RhiDevice } from '@forgeax/engine-rhi';
import type {
  KernelBackendMode,
  KernelCreateShaderModuleImmediate,
  RenderKernel,
} from './contract.js';
import { type KernelError, ok, type Result } from './errors.js';
import { TsRenderKernel } from './ts-kernel.js';
import { loadRenderKernelWasm, WasmRenderKernel } from './wasm-kernel.js';
import {
  unwrapRhiWgpuHandle,
  type WasmWgpuKernelModule,
  WasmWgpuRenderKernel,
} from './wasm-wgpu-kernel.js';

export * from './command-stream.js';
export * from './contract.js';
export * from './dynamic-texture.js';
export * from './errors.js';
export * from './graph/index.js';
export * from './handles.js';
export * from './hot-path.js';
export * from './pipeline/index.js';
export * from './pso-key.js';
export * from './rhi-replay.js';
export * from './scene-delta.js';
export { TsRenderKernel } from './ts-kernel.js';
export { loadRenderKernelWasm, WasmRenderKernel } from './wasm-kernel.js';
export {
  type RawWasmWgpuKernel,
  unwrapRhiWgpuHandle,
  type WasmWgpuKernelModule,
  type WasmWgpuKernelOptions,
  WasmWgpuRenderKernel,
} from './wasm-wgpu-kernel.js';

export interface CreateRenderKernelOptions {
  readonly device: RhiDevice;
  /** Synchronous backend shader factory (e.g. `rhi.createShaderModuleImmediate` or recorder-wrapped). */
  readonly createShaderModuleImmediate?: KernelCreateShaderModuleImmediate;
  /** 'ts' forces pure TypeScript kernel; 'wasm' requires Rust WASM kernel; 'auto' prefers WASM with TS fallback. */
  readonly backend?: KernelBackendMode | 'auto';
  readonly wasmBytes?: BufferSource;
  /** Optional initialized `@forgeax/engine-wgpu-wasm` module to run the in-WASM closure on `rhi-wgpu` devices. */
  readonly wgpuWasmModule?: WasmWgpuKernelModule;
  /** Capture resolved physical command stream for `rhi-debug` when running in-WASM. */
  readonly captureResolved?: boolean;
}

export async function createRenderKernel(
  options: CreateRenderKernelOptions,
): Promise<Result<RenderKernel, KernelError>> {
  const mode = options.backend ?? 'auto';
  if (mode === 'ts') {
    return ok(new TsRenderKernel(options.device, options.createShaderModuleImmediate));
  }
  if (options.wgpuWasmModule && unwrapRhiWgpuHandle(options.device) !== undefined) {
    return ok(
      new WasmWgpuRenderKernel(options.device, options.wgpuWasmModule, {
        captureResolved: options.captureResolved,
      }),
    );
  }
  const wasmRes = await loadRenderKernelWasm(options.wasmBytes);
  if (!wasmRes.ok) {
    if (mode === 'wasm') return wasmRes;
    return ok(new TsRenderKernel(options.device, options.createShaderModuleImmediate));
  }
  return ok(
    new WasmRenderKernel(options.device, wasmRes.value, options.createShaderModuleImmediate),
  );
}
