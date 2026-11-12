import { fork } from 'node:child_process';
import { totalmem } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import { OVERLAY_KINDS } from '@forgeax/engine-modeling';
import {
  defineCommand,
  type JsonValue,
  operationCommandPath,
  type ToolContribution,
  type ToolJsonSchema,
  toolJsonSchema,
} from '@forgeax/engine-tool-runtime';
import type { ValidateOptions } from '../validate';
import { modelBakeTool } from './bake-tool';
import { confineToRoot } from './confine';
import { modelDiffTool } from './diff-tool';
import {
  CAPTURE_HEAP_ARG,
  CAPTURE_HEAP_LIMIT_MB,
  CAPTURE_TIMEOUT_ARG,
  CAPTURE_TIMEOUT_LIMIT_MS,
  type CaptureFailure,
  type CaptureReport,
  type CaptureRequest,
  type CaptureResponse,
  captureHeapFailure,
} from './protocol';
import { MODEL_VALIDATE_REPORT_SCHEMA, validateReport } from './report';
import { modelSynthesizeTool } from './synthesize-tool';

export {
  BAKE_COMPARE_VIEWS,
  type BakeCompareView,
  type BakeMapStats,
  type BakeSide,
  MODEL_BAKE_REPORT,
  type ModelBakeReport,
} from './bake-tool';
export { type BakeWorkersOptions, bakeWorkers } from './bake-workers';
export { confineToRoot } from './confine';
export {
  type DiffRenderArgs,
  type DiffSide,
  MODEL_DIFF_REPORT,
  type ModelDiffReport,
} from './diff-tool';
export { FLIP_DEFAULT_PPD, type FlipOptions, type FlipResult, flip } from './flip';
export {
  type AnalyticSurface,
  GOLDEN_SURFACES,
  type GoldenAo,
  type GoldenCase,
  type GoldenReport,
  type GoldenSettings,
  type GoldenShape,
  type GoldenThresholds,
  goldenCase,
  goldenReport,
} from './golden';
export {
  type ColorImage,
  colorImage,
  deltaE2000,
  heatmapPng,
  imageDeltaE,
  type Lab,
  type PixelMask,
  readPng,
  shimmer,
  srgbToLab,
  ssim,
} from './image-metrics';
export { type EncodedKtx2, type EncodeKtx2Options, encodeKey, encodeKtx2 } from './ktx2';
export { type MeshJobWorkersOptions, meshJobWorkers } from './mesh-job-workers';
export type {
  CaptureFailure,
  CaptureReport,
  CaptureRequest,
  CheckpointSummary,
  HistoryStep,
  OverlayPayload,
  ParameterRange,
  RenderPayload,
  ReplayPayload,
  SectionRequest,
  SelectionReport,
  SessionHistory,
  SessionSummary,
  StatePayload,
  SynthesisPayload,
  ValidationFinding,
  VerifyPayload,
  VerifyRequest,
} from './protocol';
export {
  CAPTURE_HEAP_ARG,
  CAPTURE_HEAP_LIMIT_MB,
  CAPTURE_TIMEOUT_ARG,
  CAPTURE_TIMEOUT_LIMIT_MS,
  HIGHLIGHT_SLOT,
  REPLAY_LIMIT,
  XRAY_SLOT,
} from './protocol';
export {
  MODEL_VALIDATE_REPORT,
  MODEL_VALIDATE_REPORT_SCHEMA,
  type ModelValidateReport,
  type ValidateStatus,
  validateReport,
} from './report';
export {
  MODEL_SYNTHESIZE_REPORT,
  type ModelSynthesizeReport,
  type SelectorStability,
  type StabilityCheck,
} from './synthesize-tool';

export interface ModelingToolOptions {
  /** Project root that `source` paths are resolved against and confined to. */
  readonly projectRoot: string;
  /** Upper bound for one capture build unless a call passes `timeoutMs` (default 60 s). */
  readonly timeoutMs?: number;
}

/** Operations exposed by the modeling tools; CLI paths and MCP names derive from these ids. */
export const MODELING_OPERATION_IDS = [
  'model.inspect',
  'model.select',
  'model.validate',
  'model.overlay',
  'model.history',
  'model.diff',
  'model.pose',
  'model.interference',
  'model.synthesize',
  'model.bake',
] as const;

const common = {
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
      'Captured model() session index; default is the only session, else the one whose finish() produced the output',
  },
  checkpoint: {
    type: 'string',
    description: 'Name passed to m.checkpoint(); default is the final mesh',
  },
  timeoutMs: CAPTURE_TIMEOUT_ARG,
  heapMb: CAPTURE_HEAP_ARG,
  timingRuns: {
    type: 'object',
    description:
      'Add cold, hot, local and final build timings and the environment record (dist digest, kernel SHA) to timing; { local: { <parameter>: <value> } } sets the edit of the local run',
  },
} as const;

const TOLERANCE_ARG = {
  type: 'number',
  minimum: 0,
  description:
    "Penetration accepted between parts in meters (default 1e-4); the rig's designed contacts keep their own",
} as const;

/** `--step`: the state right after one operation, for tools that read a session state. */
export const STEP_ARG = {
  type: 'integer',
  minimum: 0,
  description: 'State right after this operation (opIndex from model.history); excludes checkpoint',
} as const;

/**
 * `--rig`, `--u`, `--pose`, `--limits`: pose a captured rig. Composers such as DevKit's
 * `model.render` spread these into their schema; captureRequest turns them into
 * `request.pose`.
 */
export const POSE_ARGS = {
  rig: {
    type: 'integer',
    minimum: 0,
    description:
      'Captured rig() index; default is the only rig, else the one whose finish() produced an output',
  },
  u: {
    type: 'number',
    description: "Pose of the rig's exported transformation path at u (0 = first key, 1 = last)",
  },
  pose: {
    type: 'object',
    description:
      'Explicit joint values: degrees (revolute), meters (prismatic) or { x, y, z } degrees (spherical); excludes u',
  },
  limits: {
    type: 'string',
    enum: ['clamp', 'reject'],
    description: 'Joint limits: clamp and report (default), or fail',
  },
} as const;

function schema(required: readonly string[], extra: Record<string, unknown> = {}): ToolJsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['source', ...required],
    properties: { ...common, ...extra },
  } as unknown as ToolJsonSchema;
}

type ToolValue =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: CaptureFailure };

function invalid(
  expected: string,
  detail: Record<string, unknown>,
  hint = 'pass a project-relative .pack.ts path',
): ToolValue {
  return {
    ok: false,
    error: {
      code: 'tool-invalid-args',
      expected,
      hint,
      detail,
    },
  };
}

/**
 * Default capture Worker heap: a quarter of admitted system memory, clamped to 1-8 GiB. Large
 * assemblies (C-100 S7, ~120k faces with a 185-part rig) exceed the old fixed 512 MiB.
 */
export function defaultCaptureHeapMb(): number {
  const constrained = process.constrainedMemory();
  const memory = constrained > 0 ? Math.min(totalmem(), constrained) : totalmem();
  return Math.min(8192, Math.max(1024, Math.floor(memory / 2 ** 20 / 4)));
}

/** Run one capture in a dedicated Worker so Pack code never executes in the tool process. */
export function runCapture(request: CaptureRequest, fallbackMs = 60_000): Promise<CaptureResponse> {
  const timeoutMs = request.timeoutMs ?? fallbackMs;
  const heapMb = request.heapMb ?? defaultCaptureHeapMb();
  return new Promise((done) => {
    // A fresh host gives its Worker an explicit heap flag; parent V8 flags override resourceLimits.
    const worker = fork(new URL('./capture-host.mjs', import.meta.url), {
      execArgv: [`--max-old-space-size=${heapMb}`],
      env: { ...process.env, NODE_OPTIONS: '' },
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
    });
    let diagnostics = '';
    let heapFailure = false;
    worker.stderr?.on('data', (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-8192);
      heapFailure ||= /heap out of memory|Reached heap limit/.test(diagnostics);
    });
    let settled = false;
    const finish = (response: CaptureResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.kill();
      done(response);
    };
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: {
            code: 'model-work-budget',
            expected: `the capture finishes within ${timeoutMs} ms`,
            hint: 'reduce the Pack work or pass a larger timeoutMs (--timeout-ms)',
          },
        }),
      timeoutMs,
    );
    let answered = false;
    worker.once('message', (response: CaptureResponse) => {
      answered = true;
      finish(response);
    });
    worker.once('exit', (code) => {
      if (answered) return;
      finish(
        heapFailure
          ? captureHeapFailure(heapMb)
          : {
              ok: false,
              error: {
                code: 'model-capture-failed',
                expected: 'the capture Worker reports a result before exiting',
                hint: 'the Pack or selector ended the Worker early (for example process.exit)',
                detail: { exitCode: code ?? 1 },
              },
            },
      );
    });
    const failed = (error: unknown) =>
      finish({
        ok: false,
        error: {
          code: 'model-capture-failed',
          expected: 'the capture Worker completes',
          hint: 'inspect detail',
          detail: String(error),
        },
      });
    worker.once('error', failed);
    try {
      worker.send({ request, heapMb });
    } catch (error) {
      failed(error);
    }
  });
}

/**
 * Validate the shared `source`/`values`/`session`/`checkpoint`/`selector` arguments
 * and confine `source` to the project. Composers such as DevKit's `model.render`
 * use it before adding their own request fields.
 */
export function captureRequest(
  projectRoot: string,
  args: Readonly<Record<string, unknown>>,
): CaptureRequest | { readonly ok: false; readonly error: CaptureFailure } {
  const source = args.source;
  if (typeof source !== 'string' || !source.endsWith('.pack.ts')) {
    return invalid('source is a .pack.ts path', { source: source as JsonValue }) as never;
  }
  const absolute = confineToRoot(projectRoot, source);
  if (absolute === undefined) {
    return invalid('source stays inside the project root', { source }) as never;
  }
  const timeoutMs = args.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) ||
      (timeoutMs as number) < 1000 ||
      (timeoutMs as number) > CAPTURE_TIMEOUT_LIMIT_MS)
  ) {
    return invalid(
      `timeoutMs is an integer in [1000, ${CAPTURE_TIMEOUT_LIMIT_MS}]`,
      {
        timeoutMs: timeoutMs as JsonValue,
      },
      'omit timeoutMs for the 60 s default',
    ) as never;
  }
  const heapMb = args.heapMb;
  if (
    heapMb !== undefined &&
    (!Number.isInteger(heapMb) ||
      (heapMb as number) < 256 ||
      (heapMb as number) > CAPTURE_HEAP_LIMIT_MB)
  ) {
    return invalid(
      `heapMb is an integer in [256, ${CAPTURE_HEAP_LIMIT_MB}]`,
      { heapMb: heapMb as JsonValue },
      'omit heapMb for the default (a quarter of admitted system memory, 1024-8192 MiB)',
    ) as never;
  }
  return {
    sourcePath: absolute,
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    ...(typeof heapMb === 'number' ? { heapMb } : {}),
    ...(typeof args.session === 'number' ? { session: args.session } : {}),
    ...(args.values !== null && typeof args.values === 'object'
      ? { values: args.values as Record<string, unknown> }
      : {}),
    ...(args.timingRuns !== null && typeof args.timingRuns === 'object'
      ? { timingRuns: args.timingRuns as NonNullable<CaptureRequest['timingRuns']> }
      : {}),
    ...(typeof args.checkpoint === 'string' ? { checkpoint: args.checkpoint } : {}),
    ...(typeof args.step === 'number' ? { step: args.step } : {}),
    ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
    ...(args.highlight === true ? { highlight: true } : {}),
    ...(typeof args.overlay === 'string'
      ? { overlays: [args.overlay as NonNullable<CaptureRequest['overlays']>[number]] }
      : {}),
    ...(typeof args.u === 'number' ||
    (args.pose !== null && typeof args.pose === 'object') ||
    typeof args.rig === 'number'
      ? {
          pose: {
            ...(typeof args.rig === 'number' ? { rig: args.rig } : {}),
            ...(typeof args.u === 'number' ? { u: args.u } : {}),
            ...(args.pose !== null && typeof args.pose === 'object'
              ? { values: args.pose as NonNullable<NonNullable<CaptureRequest['pose']>['values']> }
              : {}),
            ...(args.limits === 'clamp' || args.limits === 'reject' ? { limits: args.limits } : {}),
            ...(typeof args.tolerance === 'number' ? { tolerance: args.tolerance } : {}),
          },
        }
      : {}),
    ...(typeof args.minThickness === 'number' ||
    args.uniqueUv === true ||
    Array.isArray(args.contacts) ||
    (args.surfaceQuality !== undefined && args.surfaceQuality !== false) ||
    (args.edgeFlow !== undefined && args.edgeFlow !== false) ||
    (args.bake !== undefined && args.bake !== false)
      ? {
          validate: {
            ...(args.bake === true || (args.bake !== null && typeof args.bake === 'object')
              ? { bake: args.bake as NonNullable<ValidateOptions['bake']> }
              : {}),
            ...(typeof args.minThickness === 'number' ? { minThickness: args.minThickness } : {}),
            ...(args.uniqueUv === true ? { uniqueUv: true } : {}),
            ...(args.surfaceQuality === true ||
            (args.surfaceQuality !== null && typeof args.surfaceQuality === 'object')
              ? {
                  surfaceQuality: args.surfaceQuality as NonNullable<
                    ValidateOptions['surfaceQuality']
                  >,
                }
              : {}),
            ...(args.edgeFlow === true ||
            (args.edgeFlow !== null && typeof args.edgeFlow === 'object')
              ? { edgeFlow: args.edgeFlow as NonNullable<ValidateOptions['edgeFlow']> }
              : {}),
            ...(Array.isArray(args.contacts)
              ? { contacts: args.contacts as NonNullable<ValidateOptions['contacts']> }
              : {}),
          },
        }
      : {}),
  };
}

/** Rewrite every `source.path` / `path` of a SourceSite inside the project to a project-relative path. */
export function relativeSources<T>(value: T, projectRoot: string): T {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item === null || typeof item !== 'object' || ArrayBuffer.isView(item)) return item;
    const record = item as Record<string, unknown>;
    const isSite =
      typeof record.path === 'string' &&
      typeof record.line === 'number' &&
      typeof record.column === 'number';
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = visit(entry);
    if (isSite && isAbsolute(record.path as string)) {
      const inside = relative(projectRoot, record.path as string);
      if (!inside.startsWith('..') && !isAbsolute(inside)) out.path = inside.split('\\').join('/');
    }
    return out;
  };
  return visit(value) as T;
}

/**
 * ToolRuntime contributions for modeling inspection. Each call re-runs the Pack
 * build in a capture Worker, so reports always reflect the current source.
 */
export function createModelingTools(options: ModelingToolOptions): readonly ToolContribution[] {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const request = (args: Record<string, unknown>) => captureRequest(options.projectRoot, args);
  const tool = (
    id: Exclude<
      (typeof MODELING_OPERATION_IDS)[number],
      'model.diff' | 'model.synthesize' | 'model.bake'
    >,
    title: string,
    summary: string,
    argsSchema: ToolJsonSchema,
    project: (report: CaptureReport, args: Record<string, unknown>) => unknown,
    extra:
      | Partial<CaptureRequest>
      | ((built: CaptureRequest, args: Record<string, unknown>) => Partial<CaptureRequest>) = {},
    resultSchema: ToolJsonSchema = { type: 'object' } as ToolJsonSchema,
  ): ToolContribution =>
    defineCommand(
      {
        id,
        path: operationCommandPath(id),
        title,
        summary,
        realm: 'build',
        argsSchema: toolJsonSchema(argsSchema),
        resultSchema: toolJsonSchema(resultSchema),
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
      async (args) => {
        const built = request(args as Record<string, unknown>);
        if ('ok' in built) return built as never;
        const more =
          typeof extra === 'function' ? extra(built, args as Record<string, unknown>) : extra;
        const response = await runCapture({ ...built, ...more }, timeoutMs);
        if (!response.ok)
          return {
            ok: false,
            error: { ...response.error, detail: (response.error.detail ?? null) as JsonValue },
          } as never;
        const projected = project(response.value, args as Record<string, unknown>);
        return {
          ok: true,
          value: relativeSources(
            { ...(projected as Record<string, unknown>), timing: response.value.timing },
            options.projectRoot,
          ) as unknown as JsonValue,
        } as never;
      },
    ) as ToolContribution;
  return [
    tool(
      'model.inspect',
      'Modeling inspect',
      'Re-runs a modeling Pack build and reports outputs, sessions, tags, labeled roles, checkpoints and operation counts (model.history lists the operations).',
      schema([]),
      (report) => ({
        build: report.build,
        sessions: report.sessions.map(({ validation: _v, ...rest }) => rest),
      }),
    ),
    tool(
      'model.select',
      'Modeling select',
      'Evaluates a sel.* expression against a captured session (or checkpoint) and reports domain, count, ids and bounds. Without --session it targets the session whose finish() produced the output.',
      schema(['selector'], {
        step: STEP_ARG,
        selector: {
          type: 'string',
          description: "sel.* expression, for example sel.tag('shell').and(sel.facing('+y'))",
        },
        highlight: {
          type: 'boolean',
          description:
            'Also return the selected faces as overlay geometry (selected.highlight) for engine.preview.display.set',
        },
      }),
      (report) => ({ build: report.build, selected: report.selected }),
    ),
    tool(
      'model.validate',
      'Modeling validate',
      'Re-runs a modeling Pack build and returns the forgeax.model.validate/2 report: pass/warn/fail per session, issues located on faces (ids, centroid) and on the source line of the operation that created them, and operation diagnostics. --min-thickness and --unique-uv enable the asset-dependent thin-wall and UV-overlap checks; --contacts declares assembly fits by tag; --surface-quality checks NURBS patch continuity, control-net density and feature-line fairness; --edge-flow checks that feature lines lie on continuous edge loops, face aspect and size ratios, triangles and poles.',
      schema([], {
        minThickness: {
          type: 'number',
          minimum: 0,
          description: 'Report faces whose wall is thinner than this (meters): thin-wall',
        },
        uniqueUv: {
          type: 'boolean',
          description: 'The asset needs non-overlapping uv0 (lightmaps, baking): uv-overlap',
        },
        bake: {
          type: ['boolean', 'object'],
          description:
            'Bake pitfall checks (bake, detail.check: sharp-not-seam): true for every check, or {"checks":["sharp-not-seam"],"normals":{"mode":"autoSmooth","angle":30}} with the export normal mode',
        },
        edgeFlow: {
          type: ['boolean', 'object'],
          description:
            'Check the edge flow against the session feature lines (edge-flow, detail.check: feature-loop, aspect, size-ratio warnings; triangles, poles infos with locations): true for the defaults, or {"tolerance":5e-4,"coverage":0.98,"maxAspect":4,"maxSizeRatio":2,"limit":16}',
        },
        surfaceQuality: {
          type: ['boolean', 'object'],
          description:
            'Check the NURBS patches and feature lines of each session (surface-quality, detail.check: surface-continuity, surface-density, curve-inflection, curve-spike, curve-curvature-rate, highlight): true for the defaults, or thresholds {"position":1e-4,"angle":0.5,"curvature":0.05,"continuity":"G1","maxNet":[8,6],"fairness":{"maxInflections":0,"spike":0.5,"maxRateRatio":15}}; add "highlights":{"field":"reflection","eye":[x,y,z],"right":[1,0,0],"up":[0,1,0],"width":3} to judge highlight lines',
        },
        contacts: {
          type: 'array',
          description:
            'Assembly fits by face tag, for example [{"parts":["tube","bushing"],"tolerance":0.001}]: designed-contact within the tolerance (default 1e-3 m), confirmed crossing beyond it',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['parts'],
            properties: {
              parts: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
              tolerance: { type: 'number', exclusiveMinimum: 0 },
            },
          },
        },
      }),
      (report, args) =>
        validateReport(
          report,
          String(args.source),
          (args.values ?? {}) as Readonly<Record<string, unknown>>,
        ),
      (built) => ({ validate: built.validate ?? {} }),
      MODEL_VALIDATE_REPORT_SCHEMA,
    ),
    tool(
      'model.overlay',
      'Modeling overlay',
      'Projects tags, roles, element ids, sharp or seam edges, or normals of a captured session into overlay geometry for engine.preview.display.set.',
      schema(['overlay'], {
        step: STEP_ARG,
        overlay: { type: 'string', enum: [...OVERLAY_KINDS] },
      }),
      (report) => ({
        build: report.build,
        session: report.session,
        overlay: report.overlays?.[0],
      }),
    ),
    tool(
      'model.history',
      'Modeling history',
      'Re-runs a modeling Pack build and lists every session operation in call order: arguments, status, role counts, resulting size, duration, source line, diagnostics and the repair report of weld, resolveTJunctions, weldEdgeSequence, fillHoles and cleanup.slivers, plus checkpoints (render one with model.render --checkpoint).',
      schema([]),
      (report) => ({ build: report.build, sessions: report.history ?? [] }),
      { history: true },
    ),
    modelDiffTool(
      request,
      (captureArgs) => runCapture(captureArgs, timeoutMs),
      (value) => relativeSources(value, options.projectRoot),
    ),
    tool(
      'model.pose',
      'Modeling pose',
      "Poses a rig from a modeling Pack: joint values (--pose) or the rig's exported transformation path at --u, with joint limits clamped and reported, every joint frame, and part-vs-part interference at the pose (confirmed / candidate / designed). Render the same pose with model.render --u or --pose; parts in contact are highlighted.",
      schema([], { ...POSE_ARGS, tolerance: TOLERANCE_ARG }),
      (report) => ({ build: report.build, rigs: report.rigs ?? [], pose: report.pose }),
      (built) => ({ pose: built.pose ?? {} }),
    ),
    tool(
      'model.interference',
      'Modeling interference',
      "Scans a rig's exported transformation path for part-vs-part interference: samples every --step and every key, subdivides wherever parts could travel farther than --max-travel between samples, and reports each pair's first contact, first confirmation and deepest penetration (confirmed / candidate / designed); --clearance adds the DMU class clearance and each pair's minDistance. With --u or --pose it tests that one pose instead.",
      schema([], {
        ...POSE_ARGS,
        tolerance: TOLERANCE_ARG,
        step: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 1,
          description: 'Largest u spacing of the samples that test every pair (default 0.05)',
        },
        maxTravel: {
          type: 'number',
          exclusiveMinimum: 0,
          description:
            'Largest distance in meters a part may travel between samples (default 0.005)',
        },
        refine: {
          type: 'integer',
          minimum: 0,
          maximum: 32,
          description: 'Bisection steps for each first contact (default 6)',
        },
        clearance: {
          type: 'number',
          exclusiveMinimum: 0,
          description:
            "DMU clearance threshold in meters (CAD default 0.005): also reports pairs closer than it that never touch, with each pair's smallest distance",
        },
      }),
      (report) =>
        report.scan !== undefined
          ? { build: report.build, rigs: report.rigs ?? [], scan: report.scan }
          : { build: report.build, rigs: report.rigs ?? [], pose: report.pose },
      (built, args) =>
        built.pose?.u !== undefined || built.pose?.values !== undefined
          ? {}
          : {
              scan: {
                ...(typeof args.rig === 'number' ? { rig: args.rig } : {}),
                ...(typeof args.step === 'number' ? { step: args.step } : {}),
                ...(typeof args.maxTravel === 'number' ? { maxTravel: args.maxTravel } : {}),
                ...(typeof args.refine === 'number' ? { refine: args.refine } : {}),
                ...(typeof args.tolerance === 'number' ? { tolerance: args.tolerance } : {}),
                ...(typeof args.clearance === 'number' ? { clearance: args.clearance } : {}),
              },
            },
    ),
    modelSynthesizeTool(
      request,
      (captureArgs) => runCapture(captureArgs, timeoutMs),
      (value) => relativeSources(value, options.projectRoot),
    ),
    modelBakeTool(
      request,
      (captureArgs) => runCapture(captureArgs, timeoutMs),
      options.projectRoot,
      (value) => relativeSources(value, options.projectRoot),
    ),
  ];
}
