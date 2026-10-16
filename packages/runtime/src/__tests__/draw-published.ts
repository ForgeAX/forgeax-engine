import type { World } from '@forgeax/engine-ecs';
import type { FrameReceipt, RenderError, Renderer, RenderResult } from '@forgeax/engine-render';

/** Drive the production attach -> update -> draw contract in direct-render tests. */
export function drawPublished(
  renderer: Renderer,
  world: World,
): RenderResult<FrameReceipt, RenderError> {
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  world.update(1 / 60).unwrap();
  return renderer.draw({
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  });
}
