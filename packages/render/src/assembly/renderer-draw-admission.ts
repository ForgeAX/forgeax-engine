import { RhiError } from '@forgeax/engine-rhi';
import type { PipelineState } from '../render-system';
import { rejectZeroCanvasSize } from './canvas-draw-guard';
import type { WebGPURendererInternals } from './webgpu-renderer-bootstrap';
export function runDrawLifecycleError(
  readDisposed: () => boolean,
  readSurfaceReleased: () => boolean,
  internals: WebGPURendererInternals,
  drawHealthError: () => RhiError | undefined,
  drawReadinessError: () => RhiError | undefined,
): RhiError | undefined {
  if (readDisposed()) {
    const e = new RhiError({
      code: 'rhi-not-available',
      expected: 'renderer not disposed before calling renderer.draw(input)',
      hint: 'renderer.dispose() flipped the lifecycle latch; rebuild via createRenderer / Engine.create',
    });
    internals.errorRegistry.fire(e);
    return e;
  }
  if (readSurfaceReleased()) {
    return new RhiError({
      code: 'rhi-not-available',
      expected: 'renderer surface restored before drawing',
      hint: 'call renderer.restoreSurface() after the temporary surface owner stops',
    });
  }
  const canvasSizeError = rejectZeroCanvasSize(internals.canvas.width, internals.canvas.height);
  if (canvasSizeError !== undefined) return canvasSizeError;
  const healthError = drawHealthError();
  if (healthError !== undefined) return healthError;
  return drawReadinessError();
}

export function runDrawReadinessError(
  ui: import('../world/surface-ui').SurfaceUiState | undefined,
  readReadySettled: () => boolean,
  readPipelineState: () => PipelineState | null,
  internals: WebGPURendererInternals,
): RhiError | undefined {
  if (ui !== undefined) return undefined;
  if (!readReadySettled()) {
    const e = new RhiError({
      code: 'rhi-not-available',
      expected: 'await renderer.initialization before calling renderer.draw(input)',
      hint: 'await renderer.initialization resolves once the manifest / pipeline / asset upload chain completes',
    });
    internals.errorRegistry.fire(e);
    return e;
  }
  if (readPipelineState() !== null) return undefined;
  const e = new RhiError({
    code: 'rhi-not-available',
    expected: 'pipelineState built during Renderer.initialization',
    hint: 'await renderer.initialization resolved successfully; rebuild renderer or fix the upstream RhiError',
  });
  internals.errorRegistry.fire(e);
  return e;
}
