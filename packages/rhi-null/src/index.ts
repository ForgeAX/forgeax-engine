import type { RhiCanvasTarget } from '@forgeax/engine-rhi';
// @forgeax/engine-rhi-null - headless no-op RHI backend.
//
// Single entry for `import { rhi } from '@forgeax/engine-rhi-null'`. The
// exported `rhi` singleton has the RhiBackendPack-mandated shape
// `RhiInstance & { acquireCanvasContext }` (research Finding A4 — Channel 1
// injects this verbatim and calls acquireCanvasContext on the facade, so the
// method MUST exist on the singleton even though the public renderer options.rhi
// type does not require it). createShaderModule is exposed at the top level
// (R-2) for symmetry with rhi-webgpu: createRenderer's ready chain resolves the
// shader step through `RhiBackendPack.createShaderModule`, otherwise it rejects
// rhi-not-available.
//
// Strict two-step path: rhi.requestAdapter() -> adapter.requestDevice().
//
// Related: requirements AC-02 + AC-10 + AC-12 + scope row 4; research Finding
// A1 row 1 + A4 + A5; plan-strategy §4 R-1 + R-2.

import type {
  RequestAdapterOptions,
  Result,
  RhiAdapter,
  RhiError as RhiErrorType,
  RhiInstance,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { RhiNullAdapter } from './adapter';
import { acquireCanvasContext } from './canvas-context';
import { createShaderModule, createShaderModuleImmediate } from './shader';

/**
 * Request a headless adapter. The two-positional-arg signature mirrors the spec
 * RhiInstance.requestAdapter (the second compatibleSurface arg is accepted and
 * ignored — there is no GL backend to route it to).
 */
function requestAdapter(
  _opts?: RequestAdapterOptions | undefined,
  _compatibleSurface?: RhiCanvasTarget | undefined,
): Promise<Result<RhiAdapter, RhiErrorType>> {
  return Promise.resolve(ok(new RhiNullAdapter()));
}

/**
 * The `rhi` singleton — RhiBackendPack-shaped entry for Channel 1 injection
 * (`createRenderer(canvas, { rhi })`). Carries acquireCanvasContext (R-1) so
 * the facade never crashes on a missing method, and createShaderModule (R-2) so
 * the ready chain's shader step resolves rather than rejecting.
 */
export const rhi: RhiInstance & {
  acquireCanvasContext: typeof acquireCanvasContext;
  createShaderModule: typeof createShaderModule;
  createShaderModuleImmediate: typeof createShaderModuleImmediate;
} = {
  requestAdapter,
  acquireCanvasContext,
  createShaderModule,
  createShaderModuleImmediate,
};

export { RhiNullAdapter } from './adapter';
export { acquireCanvasContext, RhiNullCanvasContext } from './canvas-context';
export { RhiNullCommandEncoder } from './command-encoder';
export { RhiNullDevice, type RhiNullDeviceOptions } from './device';
export { RhiNullComputePassEncoder, RhiNullRenderPassEncoder } from './pass-encoders';
export { RhiNullQueue } from './queue';
export { createShaderModule, createShaderModuleImmediate } from './shader';
