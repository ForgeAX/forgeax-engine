import type { RenderFeatureWorkPlan } from '@forgeax/engine-render';
import type { ParticleRendererSourceV3 } from '@forgeax/engine-vfx';
import type { VfxArenaRange } from './instance-arena.js';
import { ownVfxGraphicsProgram } from './shared-graphics-programs.js';

/**
 * Stable per-owner plan records of the stock particle producer. Each value is
 * frozen and replaced only when its inputs change, so the Host and arena can
 * prove a steady view unchanged by identity. Caches live on their owner
 * (a renderer view row or a retained resource owner) and die with it.
 */
export type BindingValues = Extract<
  RenderFeatureWorkPlan['resources'][number],
  { readonly kind: 'graphics-bindings' }
>['values'];
/**
 * Frozen graphics binding values. A steady view keeps one values object, so
 * the Host can prove it unchanged by identity instead of a structural walk.
 */
export function particleBindingValues(
  cache: Map<string, BindingValues>,
  key: string,
  runtime: string | undefined,
  instances: string,
  sceneDepthBinding: 0 | 1 | undefined,
): BindingValues {
  const prior = cache.get(key);
  if (
    prior !== undefined &&
    prior.runtime === runtime &&
    prior.instances === instances &&
    prior.sceneDepthBinding === sceneDepthBinding
  )
    return prior;
  const values = Object.freeze({
    group: 0,
    ...(runtime === undefined ? {} : { runtime }),
    instances,
    ...(sceneDepthBinding === undefined ? {} : { sceneDepthBinding }),
  });
  cache.set(key, values);
  return values;
}
/** Frozen material binding values for one source world and material handle. */
export function materialBindingValues(
  cache: Map<string, BindingValues>,
  world: number,
  handle: ParticleRendererSourceV3['material'],
): BindingValues {
  const key = `material:${world}`;
  const prior = cache.get(key);
  const material = prior?.material as
    | { readonly world: number; readonly handle: ParticleRendererSourceV3['material'] }
    | undefined;
  if (material !== undefined && material.world === world && material.handle === handle)
    return prior as BindingValues;
  const values = Object.freeze({ group: 1, material: Object.freeze({ world, handle }) });
  cache.set(key, values);
  return values;
}
/**
 * Direct job-table ranges are fixed by their retained owner: an emitter or view
 * owner keeps one range list (and its projection entry list) for its lifetime.
 */
export const directSimulationRanges = new WeakMap<object, readonly VfxArenaRange[]>();
export const directProjectionRows = new WeakMap<
  object,
  {
    readonly frame: object;
    readonly ranges: readonly VfxArenaRange[];
    readonly entries: readonly string[];
  }
>();
export function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

type PlanPass = RenderFeatureWorkPlan['passes'][number];
export type GraphicsProgramDescriptor = Extract<
  RenderFeatureWorkPlan['resources'][number],
  { readonly kind: 'graphics-program' }
>['program'];
/** Facts of one particle graphics program, compared before any descriptor is built. */
export interface GraphicsProgramFacts {
  readonly shader: GraphicsProgramDescriptor['shader'];
  readonly preparePipelines: true | undefined;
  readonly vertexLayout: GraphicsProgramDescriptor['vertexLayout'];
  readonly particleInputLanes: number | undefined;
  readonly colorFormat: GraphicsProgramDescriptor['colorFormats'][number];
  readonly depthFormat: GraphicsProgramDescriptor['depthFormat'];
  readonly sampleCount: NonNullable<GraphicsProgramDescriptor['sampleCount']>;
  readonly topology: NonNullable<GraphicsProgramDescriptor['topology']>;
  readonly indexFormat: GraphicsProgramDescriptor['indexFormat'];
  readonly renderState: GraphicsProgramDescriptor['renderState'];
}

/**
 * Reuse the previous immutable descriptor while every input is identical.
 * Render states are compared by identity: stock defaults are shared frozen
 * values, and any other state object yields a new descriptor when replaced.
 * No candidate descriptor is built for an unchanged view program.
 */
export function graphicsProgramDescriptor(
  previous: GraphicsProgramDescriptor | undefined,
  next: GraphicsProgramFacts,
): GraphicsProgramDescriptor {
  if (
    previous !== undefined &&
    previous.shader === next.shader &&
    previous.preparePipelines === next.preparePipelines &&
    previous.vertexLayout === next.vertexLayout &&
    previous.particleInputLanes === next.particleInputLanes &&
    previous.colorFormats.length === 1 &&
    previous.colorFormats[0] === next.colorFormat &&
    previous.depthFormat === next.depthFormat &&
    previous.sampleCount === next.sampleCount &&
    previous.topology === next.topology &&
    previous.indexFormat === next.indexFormat &&
    previous.renderState === next.renderState
  )
    return previous;
  return ownVfxGraphicsProgram({
    shader: next.shader,
    ...(next.preparePipelines === undefined ? {} : { preparePipelines: true }),
    vertexLayout: next.vertexLayout,
    ...(next.particleInputLanes === undefined
      ? {}
      : { particleInputLanes: next.particleInputLanes }),
    colorFormats: [next.colorFormat],
    ...(next.depthFormat === undefined ? {} : { depthFormat: next.depthFormat }),
    sampleCount: next.sampleCount,
    topology: next.topology,
    ...(next.indexFormat === undefined ? {} : { indexFormat: next.indexFormat }),
    ...(next.renderState === undefined ? {} : { renderState: next.renderState }),
  });
}

/**
 * Simulation entry points of one immutable emitter, derived once per stage plan
 * and prepared entry-point set. Spawn counts only change workgroups, never the
 * selected entries, so one frozen list serves every tick of that program.
 */
const simulationEntryCache = new WeakMap<
  object,
  {
    readonly stages: object;
    readonly entryPoints: ReadonlySet<string>;
    readonly entries: readonly string[];
  }
>();
export function simulationEntries<Stages extends object>(
  emitter: object,
  immutable: boolean,
  stages: Stages,
  entryPoints: ReadonlySet<string>,
  dispatches: () => readonly { readonly entryPoint: string }[],
): readonly string[] {
  const cached = immutable ? simulationEntryCache.get(emitter) : undefined;
  if (cached?.stages === stages && cached.entryPoints === entryPoints) return cached.entries;
  const entries: string[] = [];
  for (const dispatch of dispatches())
    if (entryPoints.has(dispatch.entryPoint)) entries.push(dispatch.entryPoint);
  Object.freeze(entries);
  if (immutable) simulationEntryCache.set(emitter, { stages, entryPoints, entries });
  return entries;
}

/** Enabled dispatches, indirect draws and drawn subjects, counted without copying pass lists. */
export function planObservation(
  frameNumber: number,
  lists: readonly (readonly PlanPass[])[],
): Readonly<{
  frameNumber: number;
  dispatches: number;
  indirectDraws: number;
  subjectOutputs: number;
}> {
  let dispatches = 0;
  let indirectDraws = 0;
  let subjectOutputs = 0;
  for (const list of lists)
    for (const pass of list) {
      if (pass.enabled === false) continue;
      if (pass.kind === 'compute') {
        for (const dispatch of pass.dispatches)
          if (dispatch.kind === 'indirect' || !dispatch.workgroups.includes(0)) dispatches += 1;
      } else if (pass.kind === 'raster') {
        for (const draw of pass.draws) {
          if (draw.enabled === false) continue;
          subjectOutputs += 1;
          if (draw.draw.kind === 'draw-indirect' || draw.draw.kind === 'draw-indexed-indirect')
            indirectDraws += 1;
        }
      }
    }
  return Object.freeze({ frameNumber, dispatches, indirectDraws, subjectOutputs });
}

/** Shared immutable arguments of per-group arena and reset checks. */
export const STORAGE_USAGE = Object.freeze(['storage'] as const);
export const NO_COPIES: readonly Extract<PlanPass, { kind: 'copy' }>['copies'][number][] =
  Object.freeze([]);
