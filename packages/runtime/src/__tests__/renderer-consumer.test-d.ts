import type {
  FrameObservationRequest,
  FrameReceipt,
  RenderError,
  Renderer,
  RenderFrameInput,
  RenderResult,
  RenderWorldLease,
} from '@forgeax/engine-render';
import { drawSceneFrame } from '../../../../scripts/test/ready-render-frame.mjs';

const consume = async (renderer: Renderer, request: RenderFrameInput): Promise<boolean> => {
  const drawn: RenderResult<FrameReceipt, RenderError> = renderer.draw(request);
  if (!drawn.ok) return false;
  const observed = await renderer.observe(drawn.value, {
    include: ['timings'],
  } satisfies FrameObservationRequest);
  return observed.ok;
};
void consume;

const consumeScene = (renderer: Renderer, scene: RenderWorldLease): Promise<FrameReceipt> => {
  // @ts-expect-error Scene acceptance requires an admitted lease.
  void drawSceneFrame(renderer, {});
  return drawSceneFrame(renderer, scene);
};
void consumeScene;
