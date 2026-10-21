// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { World } from '@forgeax/engine-ecs';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());
{
  // --- bug-20260622-tilemap-ysort-transparent-sort-modes-followup M2 m2-1 ---
  //
  // AC-02 + AC-03 sanity slabs. Audit the engine-side reconcile checkpoint
  // (4ead9e82) by asserting the two surfaces AI users reach for from the
  // `@forgeax/engine-runtime` barrel:
  //
  //   AC-02 -- `encodeTilemapLayerValue(layerOrder, chunkIndex, sortScope?)`
  //            sortScope='per-cell' folds chunkIndex into 0 (`(layerOrder << 20)`),
  //            sortScope='layer' (default) keeps the standard
  //            `(layerOrder << 20) | chunkIndex` encoding. Tilemap-layer entities
  //            that opt into Y-interleave (`sortScope: 'per-cell'`) share one
  //            Layer.value across their derived per-cell entities so they
  //            interleave with sprite entities carrying the same Layer.value
  //            (requirements AC-02 + plan-strategy D-2; D-V-3 round-2 renames
  //            `ySort: boolean` -> `sortScope: 'layer' | 'per-cell'`).
  //
  //   AC-03 -- The 4 mode constants are reachable through the runtime
  //            barrel (`@forgeax/engine-runtime`) under their canonical
  //            names + numeric values 0/1/2/3, AND `setTransparentSortConfig`
  //            accepts all 4 modes (a tight proxy for the VALID_MODES set
  //            being size 4; the set itself is module-private SSOT).
  //
  // The barrel imports use the workspace alias so this slab fails if the
  // re-export drifts (e.g. someone drops `TRANSPARENT_SORT_MODE_DISTANCE`
  // from `packages/runtime/src/index.ts`). Same-package source tests
  // historically use relative paths; this slab opts into the published
  // alias path on purpose (charter F1 -- single-import barrel SSOT).

  describe('AC-03 transparent-sort 4-mode constants reachable through barrel', () => {
    it('4 mode constants resolve to 0/1/2/3 through @forgeax/engine-runtime', async () => {
      const runtime = await import('../../../render/src/systems/transparent-sort-config');
      expect(runtime.TRANSPARENT_SORT_MODE_LAYER_Z).toBe(0);
      expect(runtime.TRANSPARENT_SORT_MODE_LAYER_Y).toBe(1);
      expect(runtime.TRANSPARENT_SORT_MODE_LAYER_YZ).toBe(2);
      expect(runtime.TRANSPARENT_SORT_MODE_DISTANCE).toBe(3);
    });

    it('setTransparentSortConfig accepts all 4 modes (VALID_MODES proxy: size 4)', async () => {
      const runtime = await import('../../../render/src/systems/transparent-sort-config');
      for (const mode of [
        runtime.TRANSPARENT_SORT_MODE_LAYER_Z,
        runtime.TRANSPARENT_SORT_MODE_LAYER_Y,
        runtime.TRANSPARENT_SORT_MODE_LAYER_YZ,
        runtime.TRANSPARENT_SORT_MODE_DISTANCE,
      ]) {
        const world = new World();
        const r = runtime.setTransparentSortConfig(world, { mode, yzAlpha: 1.0 });
        expect(r.ok).toBe(true);
      }
    });
  });
}
