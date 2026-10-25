import type { Transparency } from '../components/camera';
import { isTransparentLaneMaterial } from '../record/main-pass';
import type { RenderPipelineTopology } from '../render-pipeline';
import type { DispatchList, RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import { dispatchPassWork, type MaterialFrame } from '../scene/material-dispatch';
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
/**
 * The classification is a pure function of its fixed inputs. Pose-only frames
 * keep the same culled dispatch, renderables and material frame; reuse it.
 */
const resolvedViews = new WeakMap<
  object,
  {
    readonly requested: Transparency;
    readonly rgba16floatRenderable: boolean;
    readonly renderables: object;
    readonly materialFrame: MaterialFrame;
    readonly value: TransparencyViewResolution;
    /**
     * The rows the classification read, flat in groups of four: renderable
     * index, materials, material and skinned.
     */
    readonly rows: readonly unknown[];
  }
>();

export function resolveTransparencyView(input: {
  readonly requested: Transparency;
  readonly rgba16floatRenderable: boolean;
  readonly renderables: FrameList<
    Pick<RenderableSnapshot, 'skinBinding' | 'materials' | 'material'>
  >;
  readonly materialFrame: MaterialFrame;
  readonly dispatch: DispatchList;
}): TransparencyViewResolution {
  const passWork = dispatchPassWork(input.dispatch);
  if (passWork !== undefined && input.renderables.length === passWork.slots)
    return resolveTransparencyPassWork(input, passWork.work);
  // Only an immutable list can stand for its entries across frames.
  const fixed = !Array.isArray(input.dispatch) || Object.isFrozen(input.dispatch);
  const retained = fixed ? resolvedViews.get(input.dispatch) : undefined;
  if (
    retained !== undefined &&
    retained.requested === input.requested &&
    retained.rgba16floatRenderable === input.rgba16floatRenderable &&
    retained.materialFrame === input.materialFrame &&
    (retained.renderables === input.renderables || sameRows(retained.rows, input.renderables))
  )
    return retained.value;
  const rows: unknown[] = [];
  const value = resolveTransparencyViewUncached(input, rows);
  if (fixed)
    resolvedViews.set(input.dispatch, {
      requested: input.requested,
      rgba16floatRenderable: input.rgba16floatRenderable,
      renderables: input.renderables,
      materialFrame: input.materialFrame,
      value,
      rows,
    });
  return value;
}

function sameRows(
  rows: readonly unknown[],
  renderables: FrameList<Pick<RenderableSnapshot, 'skinBinding' | 'materials' | 'material'>>,
): boolean {
  for (let index = 0; index < rows.length; index += 4) {
    const row = renderables.at(rows[index] as number);
    if (
      row === undefined ||
      row.materials !== rows[index + 1] ||
      row.material !== rows[index + 2] ||
      (row.skinBinding !== undefined) !== rows[index + 3]
    )
      return false;
  }
  return true;
}

/**
 * Transparency, Forward selection and OIT eligibility apart from skinning are
 * facts of one Pass and its resource, so a query result is classified per Pass:
 * opaque work is never visited and only transparent members are read, for the
 * skinned fact a weighted-blended view needs. Every entry addresses a row, as
 * the renderables cover the slot roster.
 */
function resolveTransparencyPassWork(
  input: Parameters<typeof resolveTransparencyView>[0],
  work: Iterable<import('../scene/material-dispatch').DispatchPassWork>,
): TransparencyViewResolution {
  const capabilityAbsent = input.requested === 'weighted-blended' && !input.rgba16floatRenderable;
  const resolved: Transparency = capabilityAbsent ? 'sorted' : input.requested;
  const counts = emptyCounts();
  for (const { pass, resource, count, entries } of work) {
    if (count === 0 || !matchPass(pass.tags, FORWARD_PASS_SELECTOR)) continue;
    const material = input.materialFrame.get(resource)?.snapshot;
    if (material === undefined)
      throw new Error('Transparency requires its accepted material frame');
    if (!isTransparentLaneMaterial(material)) continue;
    if (resolved === 'sorted') {
      counts.sorted += count;
      continue;
    }
    for (const entry of entries())
      countDraw(
        counts,
        entry,
        input.renderables.at(entry.renderableIndex)?.skinBinding !== undefined,
      );
  }
  return transparencyResolution(input.requested, resolved, capabilityAbsent, counts);
}

interface DrawCounts {
  accumulated: number;
  sorted: number;
  readonly ineligible: Record<OitIneligibleReason, number>;
}

function emptyCounts(): DrawCounts {
  return {
    accumulated: 0,
    sorted: 0,
    ineligible: {
      'blend-not-eligible': 0,
      'depth-write-enabled': 0,
      'program-without-oit-output': 0,
    },
  };
}

/** One transparent draw under a weighted-blended view. */
function countDraw(
  counts: DrawCounts,
  entry: Pick<
    import('../render-system-extract').DispatchEntry,
    'materialShaderId' | 'renderState' | 'fragmentEntry'
  >,
  skinned: boolean,
): void {
  const eligibility = classifyOitDraw({
    materialShaderId: entry.materialShaderId,
    skinned,
    renderState: entry.renderState,
    fragmentEntry: entry.fragmentEntry,
  });
  if (eligibility.eligible) counts.accumulated += 1;
  else {
    counts.sorted += 1;
    counts.ineligible[eligibility.reason] += 1;
  }
}

function transparencyResolution(
  requested: Transparency,
  resolved: Transparency,
  capabilityAbsent: boolean,
  { accumulated, sorted, ineligible }: DrawCounts,
): TransparencyViewResolution {
  const inspection: TransparencyInspection = Object.freeze({
    requested,
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

function resolveTransparencyViewUncached(
  input: Parameters<typeof resolveTransparencyView>[0],
  rows: unknown[],
): TransparencyViewResolution {
  const capabilityAbsent = input.requested === 'weighted-blended' && !input.rgba16floatRenderable;
  const resolved: Transparency = capabilityAbsent ? 'sorted' : input.requested;
  const counts = emptyCounts();
  if (input.dispatch.length > 0) {
    for (const entry of input.dispatch) {
      const row = input.renderables.at(entry.renderableIndex);
      if (row === undefined || !matchPass(entry.tags, FORWARD_PASS_SELECTOR)) continue;
      rows.push(entry.renderableIndex, row.materials, row.material, row.skinBinding !== undefined);
      let resource = row.material;
      for (const candidate of row.materials)
        if (
          (input.materialFrame.get(candidate)?.snapshot.materialHandle ?? 0) ===
          entry.materialHandle
        ) {
          resource = candidate;
          break;
        }
      const material = input.materialFrame.get(resource)?.snapshot;
      if (material === undefined)
        throw new Error('Transparency requires its accepted material frame');
      if (!isTransparentLaneMaterial(material)) continue;
      if (resolved === 'sorted') {
        counts.sorted += 1;
        continue;
      }
      countDraw(counts, entry, row.skinBinding !== undefined);
    }
  }
  return transparencyResolution(input.requested, resolved, capabilityAbsent, counts);
}
