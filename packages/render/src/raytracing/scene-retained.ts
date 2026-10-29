import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { type ProjectedRows, RowProjection } from '../scene/row-projection';
import { projectRayScene } from './scene-projection';
import { RaySceneRefit, type RayTrianglePatch } from './scene-refit';
import type { VisibleSurfaceProjection } from './visible-surface';

type Projection = ReturnType<typeof projectRayScene>;

/** Physical upload addresses of the last stable-shape edit; absent after a cold rebuild. */
export interface RaySceneEdit {
  readonly triangles: readonly number[];
  readonly nodes: readonly number[];
  readonly records: readonly { readonly first: number; readonly count: number }[];
}

/** Renderer-owned world-space reference BVH. Stable shapes refit only changed source rows. */
export class RaySceneProjection {
  #worlds: readonly RenderResourceScope[] = [];
  readonly #rows = new RowProjection<RenderSceneSlot>((slot, _rows, read) => {
    const scope = this.#worlds[slot.worldId];
    if (scope !== undefined && slot.snapshot.assetHandle !== undefined)
      read(scope, slot.snapshot.assetHandle);
    return slot;
  });
  #projection: Projection | undefined;
  #refit: RaySceneRefit | undefined;
  #edit: RaySceneEdit | undefined;

  get edit(): RaySceneEdit | undefined {
    return this.#edit;
  }

  reset(): void {
    this.#rows.reset();
    this.#projection = undefined;
    this.#refit = undefined;
    this.#edit = undefined;
  }

  /** Live owner buffers remain valid until the next sync; async consumers fence that boundary. */
  sync(
    rows: ProjectedRows,
    worlds: readonly RenderResourceScope[],
    surfaces: VisibleSurfaceProjection,
  ): Projection {
    if (
      worlds.length !== this.#worlds.length ||
      worlds.some((world, index) => world !== this.#worlds[index])
    )
      this.reset();
    this.#worlds = worlds;
    try {
      const sync = this.#rows.sync(rows);
      const projected = this.#projection;
      if (projected === undefined || sync.cold || projected.surfaces.layout !== surfaces.layout)
        return this.#cold(rows, worlds, surfaces);
      const patches: RayTrianglePatch[] = [];
      for (let i = 0; i < sync.changed.length; i++) {
        const slot = sync.changed[i] as number;
        const record = sync.records[i];
        if (record === undefined) return this.#cold(rows, worlds, surfaces);
        const base = surfaces.slotBases.get(slot);
        const local = projectRayScene(
          [record],
          worlds,
          {
            records: new Uint32Array(0),
            slotBases: base === undefined ? new Map() : new Map([[slot, base]]),
            entityBases: new Map(),
            layout: surfaces.layout,
          },
          rows,
        );
        const materials = this.#materialIds(local);
        const patch =
          materials === undefined ? undefined : this.#refit?.patch(slot, local.scene, materials);
        if (patch === undefined) return this.#cold(rows, worlds, surfaces);
        patches.push(patch);
      }
      const geometry = this.#refit?.apply(patches);
      const records = this.#copyRecords(sync.records, surfaces);
      this.#edit = geometry === undefined ? undefined : { ...geometry, records };
      return projected;
    } catch (cause) {
      // A failed projection must retry from source, never accept a partially advanced row cursor.
      this.reset();
      throw cause;
    }
  }

  #cold(
    rows: ProjectedRows,
    worlds: readonly RenderResourceScope[],
    surfaces: VisibleSurfaceProjection,
  ): Projection {
    const projected = projectRayScene(rows.slots, worlds, surfaces, rows);
    this.#projection = projected;
    this.#edit = undefined;
    this.#refit = new RaySceneRefit(projected.scene, projected.surfaces.records);
    return projected;
  }

  #materialIds(local: Projection): number[] | undefined {
    const materials = this.#projection?.materials ?? [];
    const result: number[] = [];
    for (const material of local.materials) {
      const id = materials.findIndex(
        (accepted) =>
          accepted.worldId === material.worldId &&
          accepted.handle === material.handle &&
          accepted.snapshot === material.snapshot,
      );
      if (id < 0) return undefined;
      result.push(id);
    }
    return result;
  }

  #copyRecords(
    records: readonly (RenderSceneSlot | undefined)[],
    surfaces: VisibleSurfaceProjection,
  ): RaySceneEdit['records'] {
    const ranges: { first: number; count: number }[] = [];
    const target = this.#projection?.surfaces.records;
    if (target === undefined) return ranges;
    for (const record of records) {
      if (record === undefined) continue;
      const base = surfaces.slotBases.get(record.slot);
      if (base === undefined) continue;
      const source = record.snapshot;
      let draws = 0;
      for (const [index, draw] of (source.gpuDrivenDraws ?? []).entries())
        draws = Math.max(draws, (draw.drawItemIndex ?? index) + 1);
      const first = (base - 1) * 16;
      const end = first + draws * (source.instances?.instanceCount ?? 1) * 16;
      target.set(surfaces.records.subarray(first, end), first);
      ranges.push({ first, count: end - first });
    }
    return ranges;
  }
}
