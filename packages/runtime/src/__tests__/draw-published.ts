import type { World } from '@forgeax/engine-ecs';
import type {
  FrameReceipt,
  RenderError,
  Renderer,
  RenderFrameInput,
  RenderReadLease,
} from '@forgeax/engine-render';
import { ok, type Result } from '@forgeax/engine-types';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';

const sources = new WeakMap<Renderer, { readonly world: World; readonly lease: RenderReadLease }>();

/** Drive the production attach -> update -> draw contract in direct-render tests. */
export async function drawPublished(
  renderer: Renderer,
  world: World,
  observation?: readonly ('linear-ldr' | 'linear-hdr')[],
): Promise<Result<FrameReceipt, RenderError>> {
  let source = sources.get(renderer);
  if (source?.world !== world) {
    source?.lease.dispose();
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    source = { world, lease: attached.value };
    sources.set(renderer, source);
  }
  world.update(1 / 60).unwrap();
  return ok(await drawReadyFrame(renderer, { source: source.lease }, observation));
}

/** Submit one ready scene picture for an already updated World. */
export async function drawReady(
  renderer: Renderer,
  request: RenderFrameInput,
): Promise<Result<FrameReceipt, RenderError>> {
  return ok(await drawReadyFrame(renderer, request));
}
