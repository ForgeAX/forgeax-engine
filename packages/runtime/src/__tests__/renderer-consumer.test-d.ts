import type {
  FrameObservationRequest,
  FrameReceipt,
  RenderError,
  Renderer,
  RenderFrameInput,
  RenderResult,
} from '@forgeax/engine-render';

const consume = async (renderer: Renderer, request: RenderFrameInput): Promise<boolean> => {
  const drawn: RenderResult<FrameReceipt, RenderError> = renderer.draw(request);
  if (!drawn.ok) return false;
  const observed = await renderer.observe(drawn.value, {
    include: ['timings'],
  } satisfies FrameObservationRequest);
  return observed.ok;
};
void consume;
