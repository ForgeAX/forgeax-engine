import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { encodePng } from '@forgeax/engine-image/png';
import {
  BAKE_MAP_KINDS,
  type BakeSettings,
  bakeMaps,
  decodeSnapshot,
  type ValidationCode,
  validateMesh,
} from '@forgeax/engine-modeling';
import {
  defineCommand,
  type JsonValue,
  operationCommandPath,
  type ToolContribution,
  type ToolJsonSchema,
  toolJsonSchema,
} from '@forgeax/engine-tool-runtime';
import { pushAll } from '../arrays';
import type { BakeMapKind } from '../compute/job';
import type { Issue } from '../report';
import { confineToRoot } from './confine';
import { environmentOf, type ToolEnvironment } from './environment';
import {
  CAPTURE_HEAP_ARG,
  CAPTURE_TIMEOUT_ARG,
  type CaptureFailure,
  type CaptureRequest,
  type CaptureResponse,
} from './protocol';

/** Version tag of the `model.bake` report. */
export const MODEL_BAKE_REPORT = 'forgeax.model.bake/1';

/** One baked side: the captured session and the output it exported. */
export interface BakeSide {
  readonly session: number;
  readonly checkpoint?: string;
  readonly output?: string;
}

/**
 * Statistics of one map over every atlas texel, gutter included (channel 0..3 means, 0..1);
 * `covered` counts those texels. The chart-only count is `metrics.covered`.
 */
export interface BakeMapStats {
  readonly covered: number;
  readonly mean: readonly number[];
  readonly min: readonly number[];
  readonly max: readonly number[];
}

/** `model.render` arguments of one compare view (evidence only: the low side renders without maps). */
export interface BakeCompareView {
  readonly view: { readonly name: string; readonly yaw: number; readonly pitch: number };
  readonly high: {
    readonly source: string;
    readonly session: number;
    readonly values: Readonly<Record<string, unknown>>;
  };
  readonly low: {
    readonly source: string;
    readonly session: number;
    readonly values: Readonly<Record<string, unknown>>;
  };
}

export interface ModelBakeReport {
  readonly schema: typeof MODEL_BAKE_REPORT;
  readonly environment: ToolEnvironment;
  /** No warning or error issue. */
  readonly pass: boolean;
  readonly base: BakeSide;
  readonly detail: BakeSide;
  readonly settings: Readonly<Record<string, unknown>>;
  /** Bake job metrics (ray hit ratio, samples, ...), coverage and per-map statistics. */
  readonly metrics: Readonly<Record<string, unknown>>;
  readonly maps: Readonly<Partial<Record<BakeMapKind, BakeMapStats>>>;
  /** Bake findings: base checks (`validate({ bake })`) and the bake's own checks (`BakeResult.issues`), each a `bake` issue whose `detail.check` is the BakeCheck. */
  readonly issues: readonly Issue<ValidationCode>[];
  /** Project-relative PNG files written under `out`. */
  readonly artifacts: readonly string[];
  readonly compare?: readonly BakeCompareView[];
}

/** The camera matrix of `--compare`: front, three-quarter, top-down and grazing. */
export const BAKE_COMPARE_VIEWS = [
  { name: 'front', yaw: 0, pitch: 0 },
  { name: 'three-quarter', yaw: 35, pitch: 25 },
  { name: 'top', yaw: 0, pitch: 80 },
  { name: 'grazing', yaw: 80, pitch: 4 },
] as const;

const argsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'base', 'detail', 'resolution'],
  properties: {
    source: {
      type: 'string',
      description: 'Project-relative .pack.ts path whose build() uses model()',
    },
    values: {
      type: 'object',
      description: 'Parameter overrides; defaults come from the Pack declaration',
    },
    base: {
      type: 'integer',
      minimum: 0,
      description: 'Session index of the low-poly receiver (needs uv0)',
    },
    detail: { type: 'integer', minimum: 0, description: 'Session index of the high-poly detail' },
    maps: {
      type: 'array',
      items: { type: 'string', enum: BAKE_MAP_KINDS.filter((m) => m !== 'resample') },
      description: 'Maps to bake (default ["normal", "ao"])',
    },
    resolution: { type: 'integer', minimum: 4, maximum: 4096, description: 'Square texture size' },
    samples: { type: 'integer', enum: [1, 4, 9, 16], description: 'Samples per texel (default 1)' },
    cage: {
      type: 'object',
      description: "Cage { offset, maxRay }, meters or 'auto' (default auto)",
    },
    gutter: { type: 'integer', minimum: 0, description: "Gutter texels (default 'fill')" },
    filter: {
      type: 'string',
      enum: ['bspline', 'none'],
      description: 'Reconstruction (default bspline)',
    },
    normals: {
      type: 'object',
      description: 'Base export normal mode, as passed to toMesh (default smooth)',
    },
    detailNormals: {
      type: 'object',
      description: 'Detail shading normal mode (default autoSmooth 35 degrees)',
    },
    ao: { type: 'object', description: 'Occlusion rays: { rays, bias, distance }' },
    out: {
      type: 'string',
      description: 'Project-relative directory for <map>.png (level 0, as baked); default none',
    },
    compare: {
      type: 'boolean',
      description:
        'Add model.render argument pairs for the high and low sessions over the front, three-quarter, top and grazing views (evidence; the deterministic gate is the golden harness)',
    },
    timeoutMs: CAPTURE_TIMEOUT_ARG,
    heapMb: CAPTURE_HEAP_ARG,
  },
} as const;

type Execute = (request: CaptureRequest) => Promise<CaptureResponse>;

function fail(error: CaptureFailure) {
  return { ok: false, error: { ...error, detail: (error.detail ?? null) as JsonValue } } as never;
}

function stats(data: Uint8Array, size: number): BakeMapStats {
  if (data.length !== size * size * 4)
    throw new RangeError(`map holds ${data.length} bytes, ${size * size * 4} expected`);
  const sum = [0, 0, 0, 0];
  const min = [1, 1, 1, 1];
  const max = [0, 0, 0, 0];
  let n = 0;
  for (let i = 0; i < size * size; i++) {
    n++;
    for (let c = 0; c < 4; c++) {
      const v = (data[i * 4 + c] as number) / 255;
      sum[c] = (sum[c] as number) + v;
      min[c] = Math.min(min[c] as number, v);
      max[c] = Math.max(max[c] as number, v);
    }
  }
  return { covered: n, mean: sum.map((s) => s / n), min, max };
}

/**
 * `model.bake`: capture a Pack's base and detail sessions, bake them with
 * `bakeMaps`, and report the bake job metrics, per-map statistics, the base's
 * `validate({ bake })` findings and the bake's own checks; optionally write each map as a
 * PNG and return `model.render` pairs for a visual comparison.
 */
export function modelBakeTool(
  request: (
    args: Record<string, unknown>,
  ) => CaptureRequest | { readonly ok: false; readonly error: CaptureFailure },
  capture: Execute,
  projectRoot: string,
  relativeTo: <T>(value: T) => T,
): ToolContribution {
  return defineCommand(
    {
      id: 'model.bake',
      path: operationCommandPath('model.bake'),
      title: 'Modeling bake',
      summary:
        'Re-runs a modeling Pack build, bakes --detail onto --base (session indices) with bakeMaps and returns the forgeax.model.bake/1 report: ray hit ratio and coverage, per-map statistics, bake findings (validate({ bake }) on the base, the bake checks of the result) and pass; --out writes <map>.png, --compare adds model.render argument pairs over front, three-quarter, top and grazing views.',
      realm: 'build',
      argsSchema: toolJsonSchema(argsSchema as unknown as ToolJsonSchema),
      resultSchema: toolJsonSchema({ type: 'object' } as ToolJsonSchema),
      evidence: [],
      capabilities: [],
      errors: [
        'tool-invalid-args',
        'model-work-budget',
        'model-capture-failed',
        'model-invalid-argument',
        'model-precondition',
      ],
      inputSchema: argsSchema as unknown as JsonValue,
    },
    async (raw) => {
      const args = raw as Record<string, unknown>;
      const out = args.out;
      let outDir: string | undefined;
      if (typeof out === 'string') {
        outDir = confineToRoot(projectRoot, out);
        if (outDir === undefined) {
          return fail({
            code: 'tool-invalid-args',
            expected: 'out stays inside the project root',
            hint: 'pass a project-relative directory',
            detail: { out },
          });
        }
      }
      const sides: { side: BakeSide; snapshot: Uint8Array }[] = [];
      for (const key of ['base', 'detail'] as const) {
        const {
          base: _b,
          detail: _d,
          maps: _m,
          resolution: _r,
          out: _o,
          compare: _c,
          ...rest
        } = args;
        const built = request({ ...rest, session: args[key] });
        if ('ok' in built) return built as never;
        const response = await capture({ ...built, snapshot: true });
        if (!response.ok) return fail(response.error);
        const state = response.value.state;
        if (state === undefined) {
          return fail({
            code: 'model-capture-failed',
            expected: `the capture returns the ${key} state`,
            hint: 'inspect the capture',
          });
        }
        const output = response.value.sessions[state.session]?.output;
        sides.push({
          snapshot: state.snapshot,
          side: {
            session: state.session,
            ...(state.checkpoint === undefined ? {} : { checkpoint: state.checkpoint }),
            ...(output === undefined ? {} : { output }),
          },
        });
      }
      const [base, detail] = sides as [(typeof sides)[number], (typeof sides)[number]];
      const maps = (Array.isArray(args.maps) ? args.maps : ['normal', 'ao']) as BakeMapKind[];
      const resolution = args.resolution as number;
      const settings: BakeSettings = {
        maps,
        resolution,
        mips: false,
        ...(typeof args.samples === 'number' ? { samples: args.samples as 1 | 4 | 9 | 16 } : {}),
        ...(args.cage !== undefined
          ? { cage: args.cage as NonNullable<BakeSettings['cage']> }
          : {}),
        ...(typeof args.gutter === 'number' ? { gutter: args.gutter } : {}),
        ...(args.filter === 'bspline' || args.filter === 'none' ? { filter: args.filter } : {}),
        ...(args.normals !== undefined
          ? { normals: args.normals as NonNullable<BakeSettings['normals']> }
          : {}),
        ...(args.detailNormals !== undefined
          ? { detailNormals: args.detailNormals as NonNullable<BakeSettings['detailNormals']> }
          : {}),
        ...(args.ao !== undefined ? { ao: args.ao as NonNullable<BakeSettings['ao']> } : {}),
      };
      const baked = bakeMaps({ ...settings, base: base.snapshot, detail: detail.snapshot });
      if (!baked.ok) {
        return fail({
          code: baked.error.code,
          expected: baked.error.expected,
          hint: baked.error.hint,
          detail: baked.error.detail as JsonValue,
        });
      }
      const issues: Issue<ValidationCode>[] = [];
      const mesh = decodeSnapshot(base.snapshot);
      if (mesh.ok) {
        const checked = validateMesh(mesh.value, 1e-6, {
          bake: settings.normals === undefined ? true : { normals: settings.normals },
        });
        pushAll(
          issues,
          checked.issues.filter((i) => i.code === 'bake'),
        );
      }
      // The bake's own checks (V2, V3, V4, V5, V12): one `bake` issue each, `detail.check` the BakeCheck.
      for (const i of baked.value.issues) {
        issues.push({ code: 'bake', severity: i.severity, detail: { check: i.code, ...i.detail } });
      }
      const artifacts: string[] = [];
      const mapStats: Partial<Record<BakeMapKind, BakeMapStats>> = {};
      for (const map of maps) {
        const texture = baked.value.textures[map];
        if (texture === undefined) continue;
        const level0 = texture.data.subarray(0, resolution * resolution * 4);
        mapStats[map] = stats(level0, resolution);
        if (outDir !== undefined) {
          mkdirSync(outDir, { recursive: true });
          const file = join(outDir, `${map}.png`);
          writeFileSync(file, encodePng(resolution, resolution, level0));
          artifacts.push(relative(projectRoot, file));
        }
      }
      const values = (args.values ?? {}) as Record<string, unknown>;
      const source = String(args.source);
      const report: ModelBakeReport = {
        schema: MODEL_BAKE_REPORT,
        environment: environmentOf(),
        pass: issues.every((i) => i.severity === 'info'),
        base: base.side,
        detail: detail.side,
        settings: settings as unknown as Record<string, unknown>,
        metrics: {
          ...baked.value.report.metrics,
          covered: baked.value.provenance.covered,
          rayHits: baked.value.provenance.rayHits,
          nearest: baked.value.provenance.nearest,
          cacheKey: baked.value.report.cacheKey,
        },
        maps: mapStats,
        issues,
        artifacts,
        ...(args.compare === true
          ? {
              compare: BAKE_COMPARE_VIEWS.map((view) => ({
                view,
                high: { source, session: detail.side.session, values },
                low: { source, session: base.side.session, values },
              })),
            }
          : {}),
      };
      return { ok: true, value: relativeTo(report) as unknown as JsonValue } as never;
    },
  ) as ToolContribution;
}
