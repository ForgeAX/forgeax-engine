import {
  defineCommand,
  type JsonValue,
  operationCommandPath,
  type ToolContribution,
  type ToolJsonSchema,
  toolJsonSchema,
} from '@forgeax/engine-tool-runtime';
import type { SelectorSynthesis } from '../synthesize';
import { environmentOf, type ToolEnvironment } from './environment';
import {
  CAPTURE_HEAP_ARG,
  CAPTURE_TIMEOUT_ARG,
  type CaptureFailure,
  type CaptureReport,
  type CaptureRequest,
  type CaptureResponse,
  type OverlayPayload,
  type ParameterRange,
} from './protocol';

/** Version tag of the `model.synthesize` report. */
export const MODEL_SYNTHESIZE_REPORT = 'forgeax.model.synthesize/1';

/** One rebuild of the stability check: a ranged parameter at one end of its range. */
export interface StabilityCheck {
  readonly parameter: string;
  readonly value: number;
  /** J between the selector's result and the picks carried into this build (0 with `error`). */
  readonly jaccard: number;
  readonly expected: number;
  readonly matched: number;
  readonly lost: number;
  /** The rebuild could not be verified (capture error or timeout): it proves nothing. */
  readonly error?: CaptureFailure;
}

/**
 * `stable`: every rebuild at a ranged parameter's minimum and maximum verified J = 1;
 * `unstable`: a verified rebuild missed (J < 1), or the result is not exact or is the
 * positional `near` fallback; `unchecked`: no ranged parameter was rebuilt, or a rebuild
 * could not be verified (capture error or timeout, kept in its check's `error`) and no
 * verified one missed.
 */
export type SelectorStability = 'stable' | 'unstable' | 'unchecked';

/** @internal The stability label of a synthesis from its rebuild checks. */
export function stabilityOf(
  exact: boolean,
  fallback: boolean,
  checks: readonly StabilityCheck[],
): SelectorStability {
  if (!exact || fallback) return 'unstable';
  const verified = checks.filter((c) => c.error === undefined);
  if (verified.some((c) => c.jaccard < 1)) return 'unstable';
  return checks.length === 0 || verified.length < checks.length ? 'unchecked' : 'stable';
}

export interface ModelSynthesizeReport extends SelectorSynthesis {
  readonly schema: typeof MODEL_SYNTHESIZE_REPORT;
  readonly environment: ToolEnvironment;
  readonly source: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly session: number;
  readonly checkpoint?: string;
  readonly step?: number;
  /** Picked faces (session face ids); bounded, `picked` counts all. */
  readonly pickedIds: readonly number[];
  readonly stability: SelectorStability;
  readonly checks: readonly StabilityCheck[];
  readonly parameters: readonly ParameterRange[];
  /** The selected faces as engine.preview.display.set overlay geometry. */
  readonly highlight: OverlayPayload;
}

const PICKED_ID_LIMIT = 256;
const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 } as const;

const argsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'pick'],
  properties: {
    timeoutMs: CAPTURE_TIMEOUT_ARG,
    heapMb: CAPTURE_HEAP_ARG,
    source: {
      type: 'string',
      description: 'Project-relative .pack.ts path whose build() uses model()',
    },
    values: {
      type: 'object',
      description: 'Parameter overrides; defaults come from the Pack declaration',
    },
    session: {
      type: 'integer',
      minimum: 0,
      description:
        'Captured model() session index; default is the session that produced the output',
    },
    checkpoint: {
      type: 'string',
      description: 'Name passed to m.checkpoint(); default is the final mesh',
    },
    step: {
      type: 'integer',
      minimum: 0,
      description:
        'State right after this operation (opIndex from model.history); excludes checkpoint',
    },
    pick: {
      type: 'object',
      additionalProperties: false,
      description:
        'Human picks, united: face ids (model.select / elementIds ids), rays (the first face each hits; model.render reports view cameras and pixel mappings) and box selects',
      properties: {
        faces: { type: 'array', items: { type: 'integer', minimum: 0 } },
        rays: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['origin', 'direction'],
            properties: { origin: vec3, direction: vec3 },
          },
        },
        boxes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['center', 'right', 'up', 'halfWidth', 'halfHeight', 'direction'],
            properties: {
              center: vec3,
              right: vec3,
              up: vec3,
              halfWidth: { type: 'number', exclusiveMinimum: 0 },
              halfHeight: { type: 'number', exclusiveMinimum: 0 },
              direction: vec3,
              visible: {
                type: 'boolean',
                description:
                  'Only faces facing the viewer and unoccluded at their centroid (default true)',
              },
            },
          },
        },
      },
    },
    maxAtoms: {
      type: 'integer',
      minimum: 1,
      maximum: 4,
      description: 'Most atoms combined with and/or/minus (default 4)',
    },
    stability: {
      type: 'boolean',
      description:
        'Rebuild at every ranged parameter minimum and maximum and score the selector (default true)',
    },
    parameters: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ranged parameters the stability check rebuilds (default all)',
    },
  },
} as const;

function fail(error: CaptureFailure) {
  return { ok: false, error: { ...error, detail: (error.detail ?? null) as JsonValue } } as never;
}

/** Run `tasks` with at most `limit` in flight, preserving order. */
async function bounded<T>(tasks: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      out[index] = await (tasks[index] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

/**
 * `model.synthesize` (design 12): resolve human picks on a captured state, synthesize
 * the shortest selector with Jaccard J = 1, then rebuild the Pack at each ranged
 * parameter's minimum and maximum and label the selector `stable` or `unstable`.
 */
export function modelSynthesizeTool(
  request: (
    args: Record<string, unknown>,
  ) => CaptureRequest | { readonly ok: false; readonly error: CaptureFailure },
  capture: (request: CaptureRequest) => Promise<CaptureResponse>,
  relative: <T>(value: T) => T,
): ToolContribution {
  return defineCommand(
    {
      id: 'model.synthesize',
      path: operationCommandPath('model.synthesize'),
      title: 'Modeling selector synthesis',
      summary:
        "Turns human picks (face ids, rays or box selects) on a captured modeling state into the shortest sel.* expression with Jaccard J = 1: atoms from the picks' tags, createdBy roles, materials, direction extremes and sharp-bounded smooth regions, combined greedily with and/or/minus (at most 4); near(p, k) is the flagged positional fallback. It then rebuilds at each ranged parameter's minimum and maximum and labels the selector stable, unstable (a verified rebuild missed) or unchecked (no rebuild, or one that could not be verified). Returns forgeax.model.synthesize/1 with the expression, J, alternatives, per-rebuild checks and highlight overlay geometry.",
      realm: 'build',
      argsSchema: toolJsonSchema(argsSchema as unknown as ToolJsonSchema),
      resultSchema: toolJsonSchema({ type: 'object' } as ToolJsonSchema),
      evidence: [],
      capabilities: [],
      errors: [
        'tool-invalid-args',
        'model-invalid-argument',
        'model-selection-empty',
        'model-work-budget',
        'model-capture-failed',
      ],
      inputSchema: argsSchema as unknown as JsonValue,
    },
    async (raw) => {
      const args = raw as Record<string, unknown>;
      const built = request(args);
      if ('ok' in built) return built as never;
      const pick = (args.pick ?? {}) as NonNullable<CaptureRequest['synthesize']>['pick'];
      const base = await capture({
        ...built,
        synthesize: {
          pick,
          ...(typeof args.maxAtoms === 'number' ? { maxAtoms: args.maxAtoms } : {}),
        },
      });
      if (!base.ok) return fail(base.error);
      const payload = (base.value as CaptureReport).synthesis;
      if (payload === undefined) {
        return fail({
          code: 'model-capture-failed',
          expected: 'the capture returns the synthesis',
          hint: 'inspect the capture',
        });
      }
      const synthesis = payload.synthesis;
      const names = Array.isArray(args.parameters)
        ? new Set(args.parameters as string[])
        : undefined;
      const ranged = payload.parameters.filter((p) => names === undefined || names.has(p.name));
      const exact = synthesis.jaccard === 1;
      const tasks =
        args.stability === false || !exact
          ? []
          : ranged.flatMap((p) =>
              [p.minimum, p.maximum].map((value) => async (): Promise<StabilityCheck> => {
                const values = { ...(built.values ?? {}), [p.name]: value };
                const response = await capture({
                  ...built,
                  values,
                  verify: {
                    selector: synthesis.expression,
                    reference: payload.reference,
                    faces: payload.faces,
                  },
                });
                const verified = response.ok ? response.value.verified : undefined;
                if (!response.ok || verified === undefined) {
                  return {
                    parameter: p.name,
                    value,
                    jaccard: 0,
                    expected: 0,
                    matched: 0,
                    lost: payload.faces.length,
                    error: response.ok
                      ? {
                          code: 'model-capture-failed',
                          expected: 'the rebuild verifies the selector',
                          hint: 'inspect the capture',
                        }
                      : response.error,
                  };
                }
                return {
                  parameter: p.name,
                  value,
                  jaccard: Math.round(verified.jaccard * 1e6) / 1e6,
                  expected: verified.expected,
                  matched: verified.matched,
                  lost: verified.lost,
                };
              }),
            );
      const checks = await bounded(tasks, 2);
      const stability = stabilityOf(exact, synthesis.fallback, checks);
      const report: ModelSynthesizeReport = {
        schema: 'forgeax.model.synthesize/1',
        environment: environmentOf(),
        source: String(args.source),
        values: (args.values ?? {}) as Record<string, unknown>,
        session: payload.session,
        ...(payload.checkpoint === undefined ? {} : { checkpoint: payload.checkpoint }),
        ...(payload.step === undefined ? {} : { step: payload.step }),
        ...synthesis,
        pickedIds: payload.picked.slice(0, PICKED_ID_LIMIT),
        stability,
        checks,
        parameters: payload.parameters,
        highlight: payload.highlight,
      };
      return { ok: true, value: relative(report) as unknown as JsonValue } as never;
    },
  ) as ToolContribution;
}
