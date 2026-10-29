import type { World } from '@forgeax/engine-ecs';
import type { FrameReceipt, RenderError, Renderer } from '@forgeax/engine-render';
import { ok, type Result } from '@forgeax/engine-types';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';

/** Drive the production attach -> update -> draw contract in direct-render tests. */
export async function drawPublished(
  renderer: Renderer,
  world: World,
  observation?: readonly ('linear-ldr' | 'linear-hdr')[],
): Promise<Result<FrameReceipt, RenderError>> {
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  world.update(1 / 60).unwrap();
  return ok(
    await drawReadyFrame(
      renderer,
      {
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      },
      observation,
    ),
  );
}

/** Submit one ready scene picture for an already updated World. */
export async function drawReady(
  renderer: Renderer,
  request: Parameters<Renderer['draw']>[0],
): Promise<Result<FrameReceipt, RenderError>> {
  return ok(await drawReadyFrame(renderer, request));
}
