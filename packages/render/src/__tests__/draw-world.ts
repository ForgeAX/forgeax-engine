import type { World } from '@forgeax/engine-ecs';
import type {
  RendererHostImplementation,
  RendererLegacyHostAdapter,
} from '../assembly/host-contract';
import type { RenderWorldLease } from '../render-contract';

type FixtureRenderer = Pick<RendererHostImplementation, 'attach'> &
  Pick<RendererLegacyHostAdapter, 'draw'>;
const sources = new WeakMap<FixtureRenderer, { world: World; lease: RenderWorldLease }>();

/** Exercise the explicit source lease without repeating fixture attachment. */
export function drawWorld(renderer: FixtureRenderer, world: World) {
  let source = sources.get(renderer);
  if (source !== undefined && source.world !== world) {
    source.lease.dispose();
    source = undefined;
  }
  if (source === undefined) {
    const result = renderer.attach(world);
    if (!result.ok) return result;
    source = { world, lease: result.value };
    sources.set(renderer, source);
  }
  return renderer.draw({ source: source.lease });
}
