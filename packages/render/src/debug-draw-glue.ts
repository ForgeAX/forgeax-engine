// @forgeax/engine-render - typed debug overlay graph contribution.
//
// App owns a CPU-only overlay source; the Renderer prepares and draws it.
// `render-debug-overlay-prepare` stages the frame's outcome and this pass only
// consumes it, so an overlay failure skips the overlay, never the frame.

import { mat4 } from '@forgeax/engine-math';
import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import type { Result } from '@forgeax/engine-types';
import { cameraLensProjection } from './camera-projection';
import type { RenderPipelineFrame, RenderPipelineTarget } from './render-pipeline';
import { consumeDebugOverlay, encodeDebugOverlay } from './world/debug-overlay-systems';

export function addTypedDebugOverlayPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  output: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  return graph.addRasterPass('debug-overlay', {
    accesses: [{ resource: output.view, usage: 'color-attachment' }],
    colorAttachments: [{ view: output.view, loadOp: 'load', storeOp: 'store' }],
    executeIf: (frame) =>
      frame.runtime.debugOverlay !== undefined &&
      consumeDebugOverlay(frame.runtime).kind === 'staged',
    encodeDirect: (pass, frame, _graphresources) => {
      const projection = cameraLensProjection(frame.camera, mat4.create());
      const view = mat4.invert(mat4.create(), frame.camera.world);
      encodeDebugOverlay(
        frame.runtime as never,
        pass,
        mat4.multiply(mat4.create(), projection, view),
        output.format,
      );
    },
  });
}
