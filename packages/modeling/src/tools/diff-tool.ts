import { diffMeshes, type MeshDiff } from '@forgeax/engine-modeling';
import {
  defineCommand,
  type JsonValue,
  operationCommandPath,
  type ToolContribution,
  type ToolJsonSchema,
  toolJsonSchema,
} from '@forgeax/engine-tool-runtime';
import { environmentOf, type ToolEnvironment } from './environment';
import {
  CAPTURE_HEAP_ARG,
  CAPTURE_TIMEOUT_ARG,
  type CaptureFailure,
  type CaptureReport,
  type CaptureRequest,
  type CaptureResponse,
} from './protocol';

/** Version tag of the `model.diff` report. */
export const MODEL_DIFF_REPORT = 'forgeax.model.diff/1';

/** One compared side: the request that selected it and what its build produced. */
export interface DiffSide {
  readonly source: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly session: number;
  readonly checkpoint?: string;
  readonly output?: string;
  readonly build: CaptureReport['build'];
}

/** `model.render` arguments that draw one side inside the shared frame. */
export interface DiffRenderArgs {
  readonly source: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly session: number;
  readonly checkpoint?: string;
  readonly frame: readonly number[];
}

export interface ModelDiffReport {
  readonly schema: typeof MODEL_DIFF_REPORT;
  readonly environment: ToolEnvironment;
  readonly a: DiffSide;
  readonly b: DiffSide;
  readonly diff: MeshDiff;
  /** The V-diff pair: render both with these arguments so they share one camera. */
  readonly render: {
    readonly frame: readonly number[];
    readonly a: DiffRenderArgs;
    readonly b: DiffRenderArgs;
  };
}

const side = {
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
    description: 'Captured model() session index; default is the session that produced the output',
  },
  checkpoint: {
    type: 'string',
    description: 'Name passed to m.checkpoint(); default is the final mesh',
  },
} as const;

const argsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'against'],
  properties: {
    ...side,
    timeoutMs: CAPTURE_TIMEOUT_ARG,
    heapMb: CAPTURE_HEAP_ARG,
    against: {
      type: 'object',
      additionalProperties: false,
      properties: side,
      description:
        'Side B as overrides of side A: other values (two parameter sets), another checkpoint, session or .pack.ts revision',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 500,
      description: 'Differences listed (default 64); differencesTotal counts all',
    },
  },
} as const;

type Execute = (request: CaptureRequest) => Promise<CaptureResponse>;

function fail(error: CaptureFailure) {
  return { ok: false, error: { ...error, detail: (error.detail ?? null) as JsonValue } } as never;
}

/**
 * `model.diff`: capture two states (two parameter sets of a Pack, two checkpoints
 * or two source revisions) and report their structured difference plus the
 * `model.render` arguments of a shared-frame V-diff pair.
 */
export function modelDiffTool(
  request: (
    args: Record<string, unknown>,
  ) => CaptureRequest | { readonly ok: false; readonly error: CaptureFailure },
  capture: Execute,
  relative: <T>(value: T) => T,
): ToolContribution {
  return defineCommand(
    {
      id: 'model.diff',
      path: operationCommandPath('model.diff'),
      title: 'Modeling diff',
      summary:
        'Re-runs a modeling Pack build for two states (--against overrides of values, checkpoint, session or source) and returns the forgeax.model.diff/1 report: count, volume, area and bounds deltas, faces unchanged/moved/added/removed per label and role, tag and material counts, Hausdorff distance, and the shared --frame for a V-diff model.render pair.',
      realm: 'build',
      argsSchema: toolJsonSchema(argsSchema as unknown as ToolJsonSchema),
      resultSchema: toolJsonSchema({ type: 'object' } as ToolJsonSchema),
      evidence: [],
      capabilities: [],
      errors: [
        'tool-invalid-args',
        'model-selection-empty',
        'model-work-budget',
        'model-capture-failed',
      ],
      inputSchema: argsSchema as unknown as JsonValue,
    },
    async (raw) => {
      const args = raw as Record<string, unknown>;
      const against = (args.against ?? {}) as Record<string, unknown>;
      const { against: _against, limit: _limit, ...sideA } = args;
      const sideB = { ...sideA, ...against };
      const sides = [sideA, sideB].map((s) => ({ args: s, request: request(s) }));
      const reports: { report: CaptureReport; side: DiffSide; snapshot: Uint8Array }[] = [];
      for (const { args: s, request: built } of sides) {
        if ('ok' in built) return built as never;
        const response = await capture({ ...built, snapshot: true });
        if (!response.ok) return fail(response.error);
        const state = response.value.state;
        if (state === undefined) {
          return fail({
            code: 'model-capture-failed',
            expected: 'the capture returns the target state',
            hint: 'inspect the capture',
          });
        }
        const output = response.value.sessions[state.session]?.output;
        reports.push({
          report: response.value,
          snapshot: state.snapshot,
          side: {
            source: String(s.source),
            values: (s.values ?? {}) as Record<string, unknown>,
            session: state.session,
            ...(state.checkpoint === undefined ? {} : { checkpoint: state.checkpoint }),
            ...(output === undefined ? {} : { output }),
            build: response.value.build,
          },
        });
      }
      const [a, b] = reports as [(typeof reports)[number], (typeof reports)[number]];
      const diff = diffMeshes(a.snapshot, b.snapshot, {
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      });
      if (!diff.ok) {
        return fail({
          code: diff.error.code,
          expected: diff.error.expected,
          hint: diff.error.hint,
        });
      }
      const frame = diff.value.bounds.frame;
      const renderArgs = (s: DiffSide): DiffRenderArgs => ({
        source: s.source,
        values: s.values,
        session: s.session,
        ...(s.checkpoint === undefined ? {} : { checkpoint: s.checkpoint }),
        frame,
      });
      const report: ModelDiffReport = {
        schema: MODEL_DIFF_REPORT,
        environment: environmentOf(),
        a: a.side,
        b: b.side,
        diff: diff.value,
        render: { frame, a: renderArgs(a.side), b: renderArgs(b.side) },
      };
      return { ok: true, value: relative(report) as unknown as JsonValue } as never;
    },
  ) as ToolContribution;
}
