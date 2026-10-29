// @forgeax/engine-render - typed debug overlay graph contribution.
//
// App owns the concrete DebugDraw instance and injects its declaration-only
// capability through the Renderer host. Render owns graph ordering and pass
// encoding without depending on the debug-draw package.

import { mat4 } from '@forgeax/engine-math';
import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import type { Result } from '@forgeax/engine-types';
import { cameraLensProjection } from './camera-projection';
import type { RenderPipelineFrame, RenderPipelineTarget } from './render-pipeline';

export function addTypedDebugOverlayPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  output: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  return graph.addRasterPass('debug-overlay', {
    accesses: [{ resource: output.view, usage: 'color-attachment' }],
    colorAttachments: [{ view: output.view, loadOp: 'load', storeOp: 'store' }],
    executeIf: (frame) => {
      const overlay = frame.runtime.debugOverlay;
      return overlay !== undefined && (overlay.hasWork?.() ?? true);
    },
    encode: ({ pass, frame }) => {
      const projection = cameraLensProjection(frame.camera, mat4.create());
      const view = mat4.invert(mat4.create(), frame.camera.world);
      const result = frame.runtime.debugOverlay?.encode(
        pass,
        mat4.multiply(mat4.create(), projection, view),
        output.format,
      );
      if (result !== undefined && !result.ok) throw result.error;
    },
  });
}
