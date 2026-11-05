import {
  createRhiDebugError,
  type FrameModel,
  type FrameSummary,
  type InspectField,
  type PassSummary,
  passLine,
  type ResourceSummary,
  summarizeFrame,
  summarizeResources,
  type WorkInspection,
} from '@forgeax/engine-rhi-debug';
import type { CommandResult } from '../types.js';

/** `rhi summary --passes`: one row per pass, without the per-work inventory. */
export interface RhiPassesSummary {
  readonly commandCount: number;
  readonly passCount: number;
  readonly resourceCount: number;
  readonly unseededResources: FrameSummary['unseededResources'];
  readonly passes: readonly PassSummary[];
  /** The same rows as `passes`, one scannable line each. */
  readonly passLines: readonly string[];
  /** Present with `label`: textures, buffers and views whose label matches. */
  readonly resources?: readonly ResourceSummary[];
  /** Absent here: the per-work inventory belongs to the default summary. */
  readonly works?: undefined;
}

export interface SummaryViewOptions {
  readonly passes?: boolean;
  readonly label?: string;
}

function passMatches(pass: PassSummary, pattern: RegExp): boolean {
  const labels = [
    pass.label,
    ...pass.pipelines.map(({ label }) => label),
    ...[...pass.colorTargets, ...(pass.depthTarget === null ? [] : [pass.depthTarget])].map(
      (target) => target.label,
    ),
  ];
  return labels.some((label) => label !== null && pattern.test(label));
}

function compilePattern(label: string): RegExp | undefined {
  try {
    return new RegExp(label);
  } catch {
    return undefined;
  }
}

/**
 * The summary the caller asked for. `--passes` (or `--label`) drops the work
 * list for a per-pass view; `--label REGEX` keeps passes whose own, pipeline or
 * target label matches and lists matching resources.
 */
export function projectSummary(
  model: FrameModel,
  options: SummaryViewOptions,
): CommandResult<FrameSummary | RhiPassesSummary> {
  const summary = summarizeFrame(model);
  if (options.passes !== true && options.label === undefined) return { ok: true, value: summary };
  const pattern = options.label === undefined ? undefined : compilePattern(options.label);
  if (options.label !== undefined && pattern === undefined)
    return {
      ok: false,
      error: {
        code: 'label-invalid',
        expected: 'label to be a valid regular expression',
        hint: 'Pass a JavaScript regular expression source such as "planar|reflection".',
        detail: { label: options.label },
      },
    };
  const passes =
    pattern === undefined ? summary.passes : summary.passes.filter((p) => passMatches(p, pattern));
  const { works: _works, passes: _passes, ...counts } = summary;
  return {
    ok: true,
    value: {
      ...counts,
      passes,
      passLines: passes.map(passLine),
      ...(pattern === undefined ? {} : { resources: summarizeResources(model, pattern) }),
    },
  };
}

/** Fields answerable from the tape alone; `pixels` and `outputs` need replayed GPU state. */
export function isStructuralInspect(fields: readonly InspectField[] | undefined): boolean {
  return (fields ?? ['pipeline', 'bindings']).every((f) => f === 'pipeline' || f === 'bindings');
}

/**
 * `rhi inspect` for `pipeline` and `bindings` only: both are recorded facts of the
 * frame model, so no Dawn device is created and no replay runs.
 */
export function inspectStructure(
  model: FrameModel,
  workIndex: number,
  fields: readonly InspectField[] | undefined,
): CommandResult<WorkInspection> {
  const work = model.works[workIndex];
  if (work === undefined) {
    const error = createRhiDebugError('replay-position-invalid', {
      requested: workIndex,
      available: model.works.length,
    });
    return {
      ok: false,
      error: {
        code: error.code,
        expected: error.expected,
        hint: `${error.hint}: requested ${workIndex}, available ${model.works.length}`,
        detail: { requested: workIndex, available: model.works.length },
      },
    };
  }
  const wanted = fields ?? ['pipeline', 'bindings'];
  return {
    ok: true,
    value: {
      workIndex: work.workIndex,
      eventIndex: work.eventIndex,
      passIndex: work.passIndex,
      attachment: undefined,
      ...(wanted.includes('pipeline') ? { pipeline: work.pipeline } : {}),
      ...(wanted.includes('bindings')
        ? {
            bindings: work.bindings,
            vertexBuffers: work.vertexBuffers,
            indexBuffer: work.indexBuffer,
            shaders: work.pipeline.shaders,
            resourceIds: work.bindings
              .map((binding) => binding.resourceId)
              .filter((resourceId): resourceId is string => resourceId !== null),
          }
        : {}),
    },
  };
}
