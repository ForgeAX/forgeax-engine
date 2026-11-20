import type { RenderPipeline, Result, RhiError } from '@forgeax/engine-rhi';
import type { RendererShaderState } from '../recovery/renderer-recover';
import type { PreparedRenderPipelineOwner } from './prepared-pipeline-owner';

/** Module admission precedes PSO compilation; either live owner can defer a candidate. */
export function materialPipelineRequestPending(
  result: Result<RenderPipeline, RhiError>,
  pipeline: PreparedRenderPipelineOwner | undefined,
  active: RendererShaderState,
  candidate: RendererShaderState | undefined,
): boolean {
  if (pipeline?.isPending(result)) return true;
  if (result.ok) return false;
  const state = candidate ?? active;
  return (
    state.sharedShaderModuleAdapter?.isPending(result.error) === true ||
    state.sharedImmediateShaderModuleAdapter?.isPending(result.error) === true
  );
}

/** Only this issued request's module/PSO completion, never another pending flight. */
export function materialPipelineRequestCompletion(
  error: RhiError,
  key: string,
  pipeline: PreparedRenderPipelineOwner | undefined,
  active: RendererShaderState,
  candidate: RendererShaderState | undefined,
): Promise<Result<void, RhiError>> | undefined {
  const state = candidate ?? active;
  return (
    pipeline?.pendingCompletion(key) ??
    state.sharedShaderModuleAdapter?.pendingCompletion(error) ??
    state.sharedImmediateShaderModuleAdapter?.pendingCompletion(error)
  );
}
