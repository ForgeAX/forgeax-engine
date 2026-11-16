import type { World } from '@forgeax/engine-ecs';
import type {
  FrameReceipt,
  RenderError,
  Renderer,
  RenderResult,
  RenderWorldLease,
} from '@forgeax/engine-render';
import { createRenderer } from '../createRenderer';

export async function requireRenderer(
  ...args: Parameters<typeof createRenderer>
): Promise<Renderer> {
  const result = await createRenderer(...args);
  if (!result.ok) throw result.error;
  return result.value;
}

const sources = new WeakMap<Renderer, { world: World; lease: RenderWorldLease }>();

/** Keep one explicit source lease for this renderer fixture. */
export function drawWorld(
  renderer: Renderer,
  world: World,
): RenderResult<FrameReceipt, RenderError> {
  let source = sources.get(renderer);
  if (source !== undefined && source.world !== world) {
    source.lease.dispose();
    source = undefined;
  }
  if (source === undefined) {
    const attached = renderer.attach(world);
    if (!attached.ok) return attached;
    source = { world, lease: attached.value };
    sources.set(renderer, source);
  }
  return renderer.draw({ source: source.lease });
}
