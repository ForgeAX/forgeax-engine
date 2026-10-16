// @forgeax/engine-rhi-null/src/shader - headless shader module factory (R-2).
//
// createShaderModule is the highest-risk hidden contract: the createRenderer
// ready chain resolves a shader module through a three-tier fallback
// (RhiBackendPack.createShaderModule -> RhiDevice.createShaderModule duck-typed
// -> err('rhi-not-available')). If RhiNull provides neither, createRenderer ->
// ready REJECTS rhi-not-available and AC-02 / AC-10 / AC-13 all fail. RhiNull
// exposes the top-level async factory (symmetric with rhi-webgpu) that skips
// real WGSL compilation and returns a legal ShaderModule brand.
//
// Related: requirements AC-10 (shader brand skips compile) + AC-02
// (createRenderer ready does not reject); research Finding A5 (three-tier
// fallback, top-level factory recommended) + A6 (brand construction);
// plan-strategy §4 R-2.

import type {
  Result,
  RhiDevice,
  RhiError as RhiErrorType,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';

/**
 * Build a shader module for the headless backend. No WGSL is compiled — the
 * code is ignored and a legal ShaderModule brand is returned immediately
 * (<1ms), so the ready chain's shader step always resolves ok (AC-10). Mirrors
 * the rhi-webgpu top-level `createShaderModule(device, desc)` signature so
 * Channel 1's RhiBackendPack picks it up via the same `'createShaderModule' in
 * mod` probe.
 */
export function createShaderModule(
  _device: RhiDevice,
  _desc: { label?: string | undefined; code: string },
): Promise<Result<ShaderModule, RhiErrorType>> {
  return Promise.resolve(ok({} as unknown as ShaderModule));
}

/**
 * Synchronous companion used by Engine-owned static feature programs. The
 * null backend has no compiler or device validation, so it can return the same
 * branded handle without introducing a first-frame pending state.
 */
export function createShaderModuleImmediate(
  _device: RhiDevice,
  _desc: { label?: string | undefined; code: string },
): Result<ShaderModule, RhiErrorType> {
  return ok({} as unknown as ShaderModule);
}
