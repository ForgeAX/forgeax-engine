import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { type RenderReadLease, setDerivedComponent } from '@forgeax/engine-ecs/projection';
import { type RenderResourceScope, worldRenderResources } from '../publication/resource-scope';
import type { DrawOwnerOptions } from '../render-contract';
import { canonicalWorldCompositionOrder } from '../render-system-projections';
import { EMPTY_VIEW_STATE_UPDATE, requireViewField } from './view-field';

type Owners = Pick<DrawOwnerOptions, 'cameraOwner' | 'resourceOwner' | 'cameraEntityKey'>;
export interface ViewWorldComposition {
  readonly worlds: readonly World[];
  readonly owners: Owners;
  readonly leases: readonly RenderReadLease[] | undefined;
}

/** Durable source membership, canonical order and camera/resource ownership of one view. */
export class ViewWorldRouting {
  private source: readonly World[] = [];
  private order: readonly number[] = [];
  private cameraOwner = -1;
  private resourceOwner = -1;
  private cameraEntityKey: number | undefined;
  private initialized = false;
  private composition: ViewWorldComposition = Object.freeze({
    worlds: Object.freeze([]),
    owners: Object.freeze({ cameraOwner: 0, resourceOwner: 0 }),
    leases: undefined,
  });
  resources: readonly RenderResourceScope[] = Object.freeze([]);

  /** Read authoring once at frame adoption, not once per downstream consumer. */
  adopt(worlds: readonly World[], owners: Owners): boolean {
    const cameraOwner = owners.cameraOwner;
    const resourceOwner = owners.resourceOwner;
    const cameraEntityKey = owners.cameraEntityKey;
    let membershipChanged = this.source.length !== worlds.length;
    for (let i = 0; !membershipChanged && i < worlds.length; i++)
      membershipChanged = this.source[i] !== worlds[i];
    if (
      this.initialized &&
      !membershipChanged &&
      this.cameraOwner === cameraOwner &&
      this.resourceOwner === resourceOwner &&
      this.cameraEntityKey === cameraEntityKey
    )
      return false;
    if (!this.initialized || membershipChanged) {
      this.source = Object.freeze(Array.from(worlds));
      this.order = canonicalWorldCompositionOrder(worlds);
    }
    this.initialized = true;
    this.cameraOwner = cameraOwner;
    this.resourceOwner = resourceOwner;
    this.cameraEntityKey = cameraEntityKey;
    const canonicalWorlds = this.order.map((index) => worlds[index] as World);
    const camera = this.order.indexOf(cameraOwner);
    const resource = this.order.indexOf(resourceOwner);
    const nextCamera = camera < 0 ? cameraOwner : camera;
    const nextResource = resource < 0 ? resourceOwner : resource;
    const previous = this.composition;
    if (
      previous.worlds.length === canonicalWorlds.length &&
      previous.worlds.every((world, index) => world === canonicalWorlds[index]) &&
      previous.owners.cameraOwner === nextCamera &&
      previous.owners.resourceOwner === nextResource &&
      previous.owners.cameraEntityKey === cameraEntityKey
    )
      return false;
    this.composition = Object.freeze({
      worlds: Object.freeze(canonicalWorlds),
      owners: Object.freeze({
        cameraOwner: nextCamera,
        resourceOwner: nextResource,
        ...(cameraEntityKey === undefined ? {} : { cameraEntityKey }),
      }),
      leases: undefined,
    });
    this.resources = Object.freeze(canonicalWorlds.map(worldRenderResources));
    return true;
  }

  /** Leases remain frame-owned; prior projections keep their original order and leases. */
  project(leases: readonly RenderReadLease[] | undefined): ViewWorldComposition {
    if (leases === undefined) return this.composition;
    return Object.freeze({
      ...this.composition,
      leases: Object.freeze(
        this.order.map((index) => leases[index]).filter((lease) => lease !== undefined),
      ),
    });
  }
}

export const ViewWorldSource = defineComponent('ViewWorldSource', {
  routing: 'unique<ViewWorldRouting>',
});

/** Called with the view's ordinary staging structural work, before preparation iterates. */
export function attachViewWorldSource(world: World, entity: EntityHandle): void {
  if (world.hasComponent(entity, ViewWorldSource)) return;
  world
    .addComponent(entity, {
      component: ViewWorldSource,
      data: { routing: world.allocUniqueRef('ViewWorldRouting', new ViewWorldRouting()) },
    })
    .unwrap();
}

export function adoptViewWorldSource(
  world: World,
  entity: EntityHandle,
  worlds: readonly World[],
  owners: Owners,
): ViewWorldRouting {
  const handle = requireViewField(world, entity, ViewWorldSource, 'routing');
  const routing = world.resolveUniqueRef<ViewWorldRouting>(handle).unwrap();
  if (routing.adopt(worlds, owners))
    setDerivedComponent(world, entity, ViewWorldSource, EMPTY_VIEW_STATE_UPDATE).unwrap();
  return routing;
}
