import type { Transparency } from '../components/camera';
import type { MaterialResource } from '../material-resource';
import { isTransparentLaneMaterial } from '../record/main-pass';
import type { RenderPipelineTopology } from '../render-pipeline';
import type { DispatchEntry, DispatchList, RenderableSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import {
  type DispatchPassWork,
  dispatchPassWork,
  type MaterialFrame,
} from '../scene/material-dispatch';
import { sceneSkinSlotsOf, sceneSurfaceRowsOf } from '../scene/render-scene-view';
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
  readonly renderables: FrameList<
    Pick<RenderableSnapshot, 'skinBinding' | 'materials' | 'material'>
  >;
  readonly materialFrame: MaterialFrame;
  readonly dispatch: DispatchList;
}): TransparencyViewResolution {
  const passWork = dispatchPassWork(input.dispatch);
  if (passWork !== undefined && input.renderables.length === passWork.slots) {
    const capabilityAbsent = input.requested === 'weighted-blended' && !input.rgba16floatRenderable;
    return capabilityAbsent || input.requested === 'sorted'
      ? transparencyResolution(input.requested, 'sorted', capabilityAbsent, {
          ...emptyCounts(),
          sorted: sortedTransparentDraws(input.materialFrame, passWork),
        })
      : resolveTransparencyPassWork(input, passWork);
  }
  return resolveTransparencyEntries(input);
}

interface SortedWork {
  readonly resource: MaterialResource;
  readonly count: number;
  transparent: boolean;
}

/** Forward Pass work of one dispatch owner, with its transparent draw count. */
interface SortedIndex {
  dispatch: DispatchList;
  materials: MaterialFrame;
  readonly works: Map<string, SortedWork>;
  readonly byResource: Map<MaterialResource, Set<string>>;
  sorted: number;
}

const sortedIndexes = new WeakMap<object, SortedIndex>();

/**
 * Transparent Forward draws of a sorted view. Successive frames of one owner
 * revisit only changed Pass work and the work of changed materials.
 */
function sortedTransparentDraws(
  materials: MaterialFrame,
  { dispatch, lineage }: NonNullable<ReturnType<typeof dispatchPassWork>>,
): number {
  const transparentIn = (frame: MaterialFrame, resource: MaterialResource) => {
    const material = frame.get(resource)?.snapshot;
    if (material === undefined)
      throw new Error('Transparency requires its accepted material frame');
    return isTransparentLaneMaterial(material);
  };
  const put = (target: SortedIndex, id: string, work: DispatchPassWork | undefined) => {
    const previous = target.works.get(id);
    if (previous !== undefined) {
      target.works.delete(id);
      if (previous.transparent) target.sorted -= previous.count;
      const ids = target.byResource.get(previous.resource);
      ids?.delete(id);
      if (ids?.size === 0) target.byResource.delete(previous.resource);
    }
    if (work === undefined || work.count === 0 || !matchPass(work.pass.tags, FORWARD_PASS_SELECTOR))
      return;
    const transparent = transparentIn(materials, work.resource);
    target.works.set(id, { resource: work.resource, count: work.count, transparent });
    if (transparent) target.sorted += work.count;
    let ids = target.byResource.get(work.resource);
    if (ids === undefined) {
      ids = new Set();
      target.byResource.set(work.resource, ids);
    }
    ids.add(id);
  };
  const index = sortedIndexes.get(lineage);
  if (
    index === undefined ||
    !dispatch.passWorkChangesSince(index.dispatch, (id, work) => put(index, id, work))
  ) {
    const built: SortedIndex = {
      dispatch,
      materials,
      works: new Map(),
      byResource: new Map(),
      sorted: 0,
    };
    for (const [id, work] of dispatch.identifiedPassWork()) put(built, id, work);
    sortedIndexes.set(lineage, built);
    return built.sorted;
  }
  if (index.materials !== materials)
    materials.changesSince(index.materials, (_before, after) => {
      if (after === undefined) return;
      for (const id of index.byResource.get(after.resource) ?? []) {
        const work = index.works.get(id);
        if (work === undefined) continue;
        const transparent = transparentIn(materials, work.resource);
        if (transparent === work.transparent) continue;
        index.sorted += transparent ? work.count : -work.count;
        work.transparent = transparent;
      }
    });
  index.dispatch = dispatch;
  index.materials = materials;
  return index.sorted;
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
  query: NonNullable<ReturnType<typeof dispatchPassWork>>,
): TransparencyViewResolution {
  const counts = emptyCounts();
  const skins = sceneSkinSlotsOf(input.renderables, query.source);
  for (const work of query.work) {
    const { pass, resource, count } = work;
    if (count === 0 || !matchPass(pass.tags, FORWARD_PASS_SELECTOR)) continue;
    const material = input.materialFrame.get(resource)?.snapshot;
    if (material === undefined)
      throw new Error('Transparency requires its accepted material frame');
    if (!isTransparentLaneMaterial(material)) continue;
    if (skins === undefined || work.visitSlots === undefined) {
      for (const entry of work.entries())
        countDraw(
          counts,
          entry,
          input.renderables.at(entry.renderableIndex)?.skinBinding !== undefined,
        );
      continue;
    }
    const rigid = classifyOitDraw({
      materialShaderId: pass.materialShaderId,
      renderState: pass.renderState,
      fragmentEntry: pass.fragmentEntry,
      skinned: false,
    });
    // A program without the accumulation ABI has the same outcome on every row.
    // Other reasons differ for skins, whose program is chosen before blend/depth tests.
    let skinned = 0;
    if (skins.size > 0 && (rigid.eligible || rigid.reason !== 'program-without-oit-output'))
      work.visitSlots((slot) => {
        if (skins.has(slot)) skinned++;
      });
    counts.ineligible['program-without-oit-output'] += skinned;
    counts.sorted += skinned;
    const ordinary = count - skinned;
    if (rigid.eligible) counts.accumulated += ordinary;
    else {
      counts.sorted += ordinary;
      counts.ineligible[rigid.reason] += ordinary;
    }
  }
  return transparencyResolution(input.requested, 'weighted-blended', false, counts);
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

function resolveTransparencyEntries(
  input: Parameters<typeof resolveTransparencyView>[0],
): TransparencyViewResolution {
  const capabilityAbsent = input.requested === 'weighted-blended' && !input.rgba16floatRenderable;
  const resolved: Transparency = capabilityAbsent ? 'sorted' : input.requested;
  const counts = emptyCounts();
  if (input.dispatch.length > 0) {
    const rows = input.renderables;
    const columns = sceneSurfaceRowsOf(rows, rows.at);
    const classify = (
      entry: DispatchEntry,
      bindings: Pick<RenderableSnapshot, 'material' | 'materials'>,
      content: Pick<RenderableSnapshot, 'skinBinding'>,
    ) => {
      const frame = input.materialFrame;
      let resource = bindings.material;
      for (const candidate of bindings.materials) {
        if ((frame.get(candidate)?.snapshot.materialHandle ?? 0) === entry.materialHandle) {
          resource = candidate;
          break;
        }
      }
      const material = frame.get(resource)?.snapshot;
      if (material === undefined)
        throw new Error('Transparency requires its accepted material frame');
      if (!isTransparentLaneMaterial(material)) return;
      if (resolved === 'sorted') counts.sorted++;
      else countDraw(counts, entry, content.skinBinding !== undefined);
    };
    let current: DispatchEntry;
    const readRow = (entry: DispatchEntry, selected: boolean) => {
      const row = rows.at(entry.renderableIndex);
      if (row !== undefined && (selected || matchPass(entry.tags, FORWARD_PASS_SELECTOR)))
        classify(entry, row, row);
    };
    // A culled or reordered dispatch still addresses this view by rank.
    // Its material and skin inputs require no public draw or temporal pose.
    const walk = columns?.surfaceWalk((_entity, content, bindings) => {
      if (bindings === undefined || content === undefined) readRow(current, true);
      else classify(current, bindings, content);
    });
    for (const entry of input.dispatch) {
      if (walk === undefined) readRow(entry, false);
      else if (matchPass(entry.tags, FORWARD_PASS_SELECTOR)) {
        current = entry;
        walk.readRank(entry.renderableIndex);
      }
    }
  }
  return transparencyResolution(input.requested, resolved, capabilityAbsent, counts);
}
