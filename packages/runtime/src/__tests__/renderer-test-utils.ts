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

const leasesByRenderer = new WeakMap<Renderer, Map<World, RenderWorldLease>>();

/** Adapt pre-lease multi-world fixtures to the public frame input contract. */
export function drawWithOwners(
  renderer: Renderer,
  worldsOrWorld: World | readonly World[],
  options: { readonly cameraOwner?: number; readonly resourceOwner?: number } = {},
): RenderResult<FrameReceipt, RenderError> {
  const worlds = Array.isArray(worldsOrWorld) ? worldsOrWorld : [worldsOrWorld];
  let leases = leasesByRenderer.get(renderer);
  if (leases === undefined) {
    leases = new Map();
    leasesByRenderer.set(renderer, leases);
  }
  const attached = worlds.map((world) => {
    const existing = leases.get(world);
    if (existing !== undefined) return existing;
    const result = renderer.attach(world);
    if (!result.ok) throw result.error;
    leases.set(world, result.value);
    return result.value;
  });
  const camera = worlds[options.cameraOwner ?? 0];
  const environment = worlds[options.resourceOwner ?? 0];
  if (camera === undefined || environment === undefined) {
    throw new Error('drawWithOwners requires cameraOwner/resourceOwner worlds');
  }
  const cameraLease = leases.get(camera);
  const environmentLease = leases.get(environment);
  if (cameraLease === undefined || environmentLease === undefined) {
    throw new Error('drawWithOwners failed to attach owner worlds');
  }
  return renderer.draw({
    leases: attached,
    camera: { lease: cameraLease },
    environment: { lease: environmentLease },
  });
}
