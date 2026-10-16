import type { EngineMetrics } from '@forgeax/engine-types';

// @forgeax/engine-runtime — owner-scoped EngineMetrics implementation
// (feat-20260527-sprite-nineslice M4 / w16). The counter map is injected into
// owning services such as AssetRegistry and the record stage; the Renderer
// facade does not expose it. AI-facing renderer observation stays on inspect()
// and observe().
//
// Surface — three methods:
//
//   | Method                         | Purpose                                     |
//   |:-------------------------------|:--------------------------------------------|
//   | `increment(name)`              | Bump the counter for `name` by 1.           |
//   | `snapshot()`                   | Read all counters as an immutable object.   |
//   | `reset()`                      | Drop every counter (test isolation hook).   |
//
// Naming convention (charter P5 consistent abstraction): counter keys use a
// dot-delimited namespace `<feature>.<event>`. Two features own keys today:
//
//   - `nineslice.scale-too-small`           — Transform.scale below the four
//     corner anchors at draw time (AC-16, w17 end-to-end test).
//   - `nineslice.tile-needs-repeat-sampler` — sliceMode=1 (tile) bound to a
//     sampler whose addressMode is not `'repeat'`; the visual silently
//     degrades to clamp-stretch (D-9, w18 register-time soft-warn).
//   - `render.instancing.foldedDraws`        — feat-20260622-chunk-gpu-
//     instancing-sprite-tilemap M3 / D-3. Count of instanced drawIndexed
//     calls the fold operator emits this frame; one increment per non-
//     singleton head bucket retained after the M2 / w11 cap-fallback
//     filter. NOT entity count, NOT pre-filter bucket count. AI users
//     read it via `ownerMetrics.snapshot()['render.instancing.foldedDraws']`
//     to verify fold actually reduced draw count under mode-0 (LAYER_Z)
//     transparent sort. The key is exported as `FOLDED_DRAWS_METRIC_KEY`
//     from the record mesh owner (single source of truth — engine
//     calls increment via the helper, never the literal string).
//
// Assembly isolation (D-5 candidate 1): each renderer assembly injects a fresh
// EngineMetrics instance; counters from one host never bleed into another.
// `createRenderer.ts` constructs a fresh instance per call.

// The EngineMetrics interface (3-method contract, zero type dependencies) sank
// into @forgeax/engine-types (feat-20260705-runtime-tier2-decomposition M1 / w2,
// D-3). Re-exported here so existing `import { EngineMetrics } from
// './engine-metrics'` consumers keep resolving; EngineMetricsImpl +
// createEngineMetrics remain runtime-owned.
export type { EngineMetrics };

/**
 * Default `EngineMetrics` implementation — a thin `Map<string, number>` with
 * the three-method surface bolted on. The map is private; readers consume
 * the snapshot accessor.
 *
 * @internal — instances are constructed by `createRenderer` and retained by
 * owner services; AI users do not import this class directly.
 */
export class EngineMetricsImpl implements EngineMetrics {
  private readonly counters = new Map<string, number>();

  increment(name: string): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }

  snapshot(): Readonly<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.counters) {
      out[k] = v;
    }
    return Object.freeze(out);
  }

  reset(): void {
    this.counters.clear();
  }
}

/**
 * Fresh `EngineMetrics` factory; the only construction path used by
 * `createRenderer`. Keeping the constructor private (via the factory) leaves
 * room to swap the backing store without touching call sites.
 */
export function createEngineMetrics(): EngineMetrics {
  return new EngineMetricsImpl();
}
