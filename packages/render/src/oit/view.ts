import type { Transparency } from '../components/camera';
import { isTransparentLaneMaterial } from '../record/main-pass';
import type { RenderPipelineTopology } from '../render-pipeline';
import type { DispatchEntry, RenderableSnapshot } from '../render-system-extract';
import { FORWARD_PASS_SELECTOR, matchPass } from '../systems/pass-selector';
import { classifyOitDraw, type OitIneligibleReason } from './eligibility';

/** Why a view that requested `weighted-blended` resolved to `sorted`. Closed. */
export type TransparencyViewReason = 'capability-absent';

/**
 * The display view's transparent composition, as `renderer.inspect().transparency`.
 *
 * Draw counts are transparent material-pass draws of visible renderables
 * (the Forward selector of the transparent set). Under a `sorted` view every
 * draw is `sortedDrawCount` and `ineligible` is all zero.
 */
export interface TransparencyInspection {
  readonly requested: Transparency;
  readonly resolved: Transparency;
  /** Present only when `resolved` differs from `requested`. */
  readonly reason?: TransparencyViewReason;
  /** The missing capability fact that produced `capability-absent`. */
  readonly capability?: 'rgba16floatRenderable';
  readonly accumulatedDrawCount: number;
  readonly sortedDrawCount: number;
  /** Per-reason count of draws kept sorted under a `weighted-blended` view. */
  readonly ineligible: Readonly<Record<OitIneligibleReason, number>>;
}

export interface TransparencyViewResolution {
  readonly inspection: TransparencyInspection;
  /** Graph fact: present only when OIT passes run for this view. */
  readonly topology: RenderPipelineTopology['transparency'];
}

/**
 * Resolve one view's transparency and classify its transparent draws with the
 * same classifier the recorder uses, so inspection and executed passes agree.
 *
 * Capability gate: both WBOIT targets (rgba16float accum, r16float weight)
 * need float render attachments with blending. WebGPU core makes both
 * renderable and blendable once `rgba16float` renders; WebGL2 enables both
 * with the same extension. `rgba16floatRenderable` is therefore the one fact.
 */
export function resolveTransparencyView(input: {
  readonly requested: Transparency;
  readonly rgba16floatRenderable: boolean;
  /** Validation and camera projection preserve ascending renderable indices; holes are valid. */
  readonly rows: readonly {
    readonly renderableIndex: number;
    readonly source: Pick<RenderableSnapshot, 'skin' | 'materials' | 'material'>;
  }[];
  readonly dispatch: readonly DispatchEntry[];
}): TransparencyViewResolution {
  const capabilityAbsent = input.requested === 'weighted-blended' && !input.rgba16floatRenderable;
  const resolved: Transparency = capabilityAbsent ? 'sorted' : input.requested;
  const ineligible: Record<OitIneligibleReason, number> = {
    'blend-not-eligible': 0,
    'depth-write-enabled': 0,
    'program-without-oit-output': 0,
  };
  let accumulated = 0;
  let sorted = 0;
  if (input.dispatch.length > 0) {
    for (const entry of input.dispatch) {
      if (!matchPass(entry.tags, FORWARD_PASS_SELECTOR)) continue;
      let row = input.rows[entry.renderableIndex];
      if (row?.renderableIndex !== entry.renderableIndex) {
        let low = 0;
        let high = input.rows.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          const candidate = input.rows[middle] as (typeof input.rows)[number];
          if (candidate.renderableIndex < entry.renderableIndex) low = middle + 1;
          else high = middle;
        }
        row = input.rows[low];
      }
      if (row?.renderableIndex !== entry.renderableIndex) continue;
      const material =
        row.source.materials.find(
          (candidate) => (candidate.materialHandle ?? 0) === entry.materialHandle,
        ) ?? row.source.material;
      if (!isTransparentLaneMaterial(material)) continue;
      if (resolved === 'sorted') {
        sorted += 1;
        continue;
      }
      const eligibility = classifyOitDraw({
        materialShaderId: entry.materialShaderId,
        skinned: row.source.skin !== undefined,
        renderState: entry.renderState,
        fragmentEntry: entry.fragmentEntry,
      });
      if (eligibility.eligible) accumulated += 1;
      else {
        sorted += 1;
        ineligible[eligibility.reason] += 1;
      }
    }
  }
  const inspection: TransparencyInspection = Object.freeze({
    requested: input.requested,
    resolved,
    ...(capabilityAbsent
      ? { reason: 'capability-absent' as const, capability: 'rgba16floatRenderable' as const }
      : {}),
    accumulatedDrawCount: accumulated,
    sortedDrawCount: sorted,
    ineligible: Object.freeze(ineligible),
  });
  return {
    inspection,
    topology: accumulated > 0 ? { weightedBlended: true, residual: sorted > 0 } : undefined,
  };
}
