import { err, ok, type Result } from '@forgeax/engine-types';
import type * as exact from './brep';
import type { SourceSite } from './capture';
import type { ComputeBackend, ComputePolicy } from './compute/job';
import type { SmoothOptions } from './deform';
import type { ImplicitSmoothOptions } from './deform-solve';
import type { Contour, Drawing, ResolvedDrawing } from './drawing';
import { resolveCurveSpec } from './drawing';
import { type ModelingError, type ModelingSite, modelingError } from './errors';
import type { ExportOptions, ExportSidecar, NormalMode } from './finish';
import { checkSnapshotOperand, decodeSnapshot } from './fxem';
import type { InvariantViolation } from './invariants';
import type { EditMesh, PartRole } from './mesh';
import type { KernelPolicy } from './mesh-store';
import { surfaceDomain, surfacePoint } from './nurbs';
import type { OpDiagnostic, RepairReport, RoleCounts } from './ops';
import type { Issue } from './report';
import type { PlanSeamsOptions } from './seams';
import { type FaceSelector, Selector, type SelectorUse, type VertSelector } from './selectors';
import type { FeatureLine, NamedSurface, SurfaceQualityCode } from './surface-quality';
import type { TrimRegion } from './trim';
import type { SeamSource } from './uv';
import type { ValidationReport } from './validate';

export type ExactStage = Pick<
  typeof exact,
  | 'box'
  | 'cylinder'
  | 'cone'
  | 'sphere'
  | 'torus'
  | 'extrude'
  | 'revolve'
  | 'tessellate'
  | 'quadrangulate'
  | 'brepError'
  | 'BREP_LIMITS'
>;

export type OpStatus = 'ok' | 'skipped' | 'failed';

/** What one operation call did; returned to the author and recorded in the journal. */
export interface OpReport {
  readonly op: string;
  readonly opIndex: number;
  readonly label?: string;
  readonly status: OpStatus;
  /** Faces produced or moved per role (for example { top: 1, side: 4 }). */
  readonly roles: Readonly<RoleCounts>;
  readonly faces: number;
  readonly vertices: number;
  readonly error?: ModelingError;
  /** Non-fatal facts (clamps, fallbacks, repairs) the operation reports. */
  readonly diagnostics?: readonly OpDiagnostic[];
  /** What a repair operation changed and its largest departures from the input. */
  readonly repair?: RepairReport;
}

export interface JournalEntry extends OpReport {
  readonly args: unknown;
  readonly topologyStamp: readonly [number, number];
  readonly durationMs: number;
  /** Author call site; recorded only in captured sessions. */
  readonly source?: SourceSite;
  /** Selector arguments the operation resolved, in call order; absent when it resolved none. */
  readonly selectors?: readonly SelectorUse[];
  /** True when more than the bounded number of selector uses were resolved. */
  readonly selectorsTruncated?: true;
}

export interface ModelOptions {
  /** Model-wide geometric tolerance in meters (default 1e-5). */
  readonly tolerance?: number;
  /**
   * Cooperative cancellation, checked before every operation: once aborted, the
   * next operation fails with `model-cancelled` and poisons the session.
   */
  readonly signal?: { readonly aborted: boolean };
  /**
   * Element budget: an operation that leaves more faces fails with `model-work-budget`;
   * `work` bounds each compute job (TS baseline work units, default DEFAULT_WORK_BUDGET).
   */
  readonly budget?: { readonly faces?: number; readonly work?: number };
  /** Compute-job backend policy (design 4.1, default 'auto'); operations can override it. */
  readonly compute?: ComputePolicy;
  /** Native compute backend injected by the Host (design X6); absent, `native` is unavailable. */
  readonly native?: ComputeBackend;
  /**
   * The exact (B-rep) stage, injected so the main bundle never reaches it:
   * `model({ exact: await import('@forgeax/engine-modeling/brep') })`. Absent, the `brep.*` ops and
   * `fromShape` fail with `model-capability-unavailable`.
   */
  readonly exact?: ExactStage;
  /** Session kernel execution policy ('auto' | 'rust' | 'ts', default 'auto'). */
  readonly backend?: KernelPolicy;
  /** Optional per-operation backend overrides for differential verification or fallback. */
  readonly opBackends?: Readonly<Record<string, 'rust' | 'ts'>>;
  /**
   * Snapshot the mesh before every operation so an unexpected kernel throw (`model-internal`)
   * restores the pre-operation state. Defaults to active only under diagnostic capture or
   * invariant checks, avoiding O(ops * mesh) clones on production builds (`m.try()` always
   * takes an explicit snapshot).
   */
  readonly rollbackOnInternal?: boolean;
}

export interface FinishOptions extends ExportOptions {
  /** Output source key becomes `mesh/<key>`. */
  readonly key: string;
}

export interface Checkpoint {
  readonly name: string;
  /** Number of journal entries before the checkpoint. */
  readonly opIndex: number;
  /** FXEM snapshot of the mesh at the checkpoint. */
  readonly snapshot: Uint8Array;
  readonly faces: number;
  readonly vertices: number;
  /** Author call site of `m.checkpoint()`, when it can be determined. */
  readonly source?: SourceSite;
}

/** FXEM snapshot of a session right after one operation (captured step replay). */
export interface StepSnapshot {
  readonly opIndex: number;
  readonly snapshot: Uint8Array;
}

export interface ThreeViewOptions {
  /** Overshoot of each view prism beyond the other views' extent, meters (default 2% of the largest extent). */
  readonly margin?: number;
  /**
   * Views share extremes by construction (nose, roof, floor lines), which makes their
   * prisms coplanar or tangent there. The first contour stays exact; contour i grows
   * outward by i x clearance meters (default 0.0005), so the result follows every
   * contour within 2 x clearance: an extent drawn only by later views grows by up to
   * 2 x clearance (contour order decides which), and a later view's slots narrower than
   * 2 x i x clearance close (the grown outline crosses itself). Draw thin features in the
   * first contour, or lower clearance.
   */
  readonly clearance?: number;
  readonly label?: string;
  readonly material?: string;
}

export interface ExtrudeContourOptions {
  /** View depths `[near, far]` (meters along the view's `toward` axis) the prism spans. */
  readonly depth: readonly [number, number];
  /** Offset the outline outward by this many meters before extruding (default 0). */
  readonly grow?: number;
}

/**
 * Build-only diagnostic companion of a captured session. `validation` (exact
 * self-intersection over every face pair) and `snapshot` are computed on first
 * read, so callers that only inspect never pay for them.
 */
export interface ModelDiagnostics {
  readonly inspection: ModelInspection;
  readonly validation: ValidationReport;
  /** FXEM snapshot of the final mesh. */
  readonly snapshot: Uint8Array;
  readonly checkpoints: readonly Checkpoint[];
  /** State after each successful operation, when the capture asked for steps (`captureModels(body, { steps: true })`). */
  readonly steps: readonly StepSnapshot[];
  /** True when step snapshots stopped at the capture byte budget. */
  readonly stepsTruncated: boolean;
  /** Design drawings attached with `m.drawing()`. */
  readonly drawings: readonly ResolvedDrawing[];
  /** Contours extruded by the session, in call order. */
  readonly contours: readonly Contour[];
  /**
   * NURBS patches tessellated by `surface()`, in call order, named by their patch `name`
   * (default `surface`; repeats get `.1`, `.2` ...). Views and checks evaluate them exactly.
   */
  readonly surfaces: readonly NamedSurface[];
  /** Feature lines declared with `m.featureLine()`. */
  readonly featureLines: readonly FeatureLine[];
  /** Sidecar of the last export: provenance maps and author tables (compacted ids). */
  readonly provenance?: ExportSidecar;
}

export interface ModelInspection {
  readonly faces: number;
  readonly edges: number;
  readonly vertices: number;
  readonly tags: readonly string[];
  readonly labels: readonly {
    readonly label: string;
    readonly roles: Readonly<Record<string, number>>;
  }[];
  readonly materials: readonly string[];
  /** Face counts per part role, and of floating detail shells (`float`). */
  readonly roles: Readonly<Record<PartRole, number>> & { readonly float: number };
  /** Source key of the last successful finish() (`mesh/<key>`); absent for helper sessions. */
  readonly output?: string;
  readonly normals?: NormalMode;
  readonly poisoned?: ModelingError;
  readonly journal: readonly JournalEntry[];
}

/** `m.smooth(...)` (Taubin) with its solved variant `m.smooth.implicit(...)`. */
export interface SmoothOperation {
  (target: FaceSelector | VertSelector, options: SmoothOptions): OpReport;
  /** Implicit fairing of the selection (default: the whole mesh). */
  implicit(
    target: FaceSelector | VertSelector | undefined,
    options: ImplicitSmoothOptions,
  ): OpReport;
}

export const EXACT_STAGE_FUNCTIONS = [
  'box',
  'cylinder',
  'cone',
  'sphere',
  'torus',
  'extrude',
  'revolve',
  'tessellate',
  'quadrangulate',
  'brepError',
] as const;

export const PRODUCING_OPS = new Set([
  'bevel',
  'extrude',
  'hole',
  'inset',
  'offset',
  'mirror',
  'duplicate',
  'bridge',
  'fillHoles',
  'shell',
  'layer',
  'strands',
  'panelLine',
  'fromShape',
  'sweep',
  'loft',
  'pipeNetwork',
  'array',
  'surface',
  'voxel.toMesh',
  'voxel.union',
  'voxel.offset',
  'voxel.fillHoles',
]);

/** Where a surface-quality issue is worst: the failing measure's point, or a patch center. */
export function qualityPoint(
  issue: Issue<SurfaceQualityCode>,
  surfaces: readonly NamedSurface[],
): readonly number[] | undefined {
  const d = issue.detail as Record<string, unknown>;
  const at = (value: unknown) => (value as { point?: readonly number[] } | undefined)?.point;
  switch (issue.code) {
    case 'surface-continuity':
      return at(d.achieved === 'none' ? d.gap : d.achieved === 'G0' ? d.angle : d.curvature);
    case 'surface-density': {
      const surface = surfaces.find((s) => s.name === issue.detail.subject)?.surface;
      if (surface === undefined) return undefined;
      const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
      return surfacePoint(surface, (u0 + u1) / 2, (v0 + v1) / 2);
    }
    case 'curve-inflection':
      return at((d.inflections as readonly unknown[] | undefined)?.[0]);
    case 'curve-spike':
      return at((d.spikes as readonly unknown[] | undefined)?.[0]);
    case 'curve-curvature-rate':
      return at(d.at);
    case 'surface-fairness':
    case 'highlight':
      return d.point as readonly number[] | undefined;
    case 'nothing-checked':
      return undefined;
  }
}

export function trimArgs(options: {
  readonly region: TrimRegion | readonly TrimRegion[];
  readonly faces: FaceSelector;
}): object {
  const { faces: _faces, region, ...rest } = options;
  const name = (r: TrimRegion | undefined) => `${r?.sheet}/${r?.id}`;
  return {
    ...rest,
    region: Array.isArray(region)
      ? (region as readonly TrimRegion[]).map(name)
      : name(region as TrimRegion),
  };
}

export function describeSeams(seams: SeamSource | undefined): string | undefined {
  return seams instanceof Selector ? seams.description : seams;
}

export function describePlan<T extends PlanSeamsOptions>(options: T): T {
  const out = { ...options } as Record<string, unknown>;
  for (const key of ['force', 'forbid', 'avoid'] as const) {
    const selector = options[key];
    if (selector !== undefined) out[key] = selector.description;
  }
  return out as T;
}

/** Decode an FXEM operand; a poisoned session's snapshot fails like the session itself. */
export function decodeOperand(bytes: Uint8Array): Result<EditMesh, ModelingError> {
  const poisoned = checkSnapshotOperand(bytes);
  if (!poisoned.ok) return poisoned;
  return decodeSnapshot(bytes);
}

function isPositiveFinite(x: unknown): boolean {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

/** A JS caller's partial, null or non-object stage poisons the session at injection. */
export function checkedStage(stage: unknown): ExactStage | ModelingError {
  const candidate = stage as Partial<Record<string, unknown>> | null | undefined;
  const complete =
    typeof candidate === 'object' &&
    candidate !== null &&
    EXACT_STAGE_FUNCTIONS.every((name) => typeof candidate[name] === 'function') &&
    isPositiveFinite((candidate.BREP_LIMITS as { faces?: unknown } | null | undefined)?.faces) &&
    isPositiveFinite((candidate.BREP_LIMITS as { edges?: unknown } | null | undefined)?.edges);
  return complete
    ? (stage as ExactStage)
    : modelingError(
        'model-invalid-argument',
        'model({ exact }) given the complete module namespace of @forgeax/engine-modeling/brep',
        { option: 'exact' },
      );
}

export function noExactStage(op: string): Result<never, ModelingError> {
  return err(
    modelingError(
      'model-capability-unavailable',
      'the exact stage injected as model({ exact })',
      { op },
      "pass exact: await import('@forgeax/engine-modeling/brep') to model()",
    ),
  );
}

export function shapeSize(shape: exact.Shape): { faces: number; edges: number } {
  return { faces: shape.faces.length, edges: shape.edges.length };
}

/** A thrown value that is not an InvariantError becomes a structured kernel-defect failure. */
export function internalError(site: ModelingSite, cause: unknown): ModelingError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return modelingError('model-internal', 'the operation completes without a kernel exception', {
    site,
    cause: message.slice(0, 500),
    ...(cause instanceof Error ? { name: cause.name } : {}),
  });
}

/** Thrown only while `checkInvariants(true)`: an operation broke a kernel invariant. */
export class InvariantError extends Error {
  readonly violations: readonly InvariantViolation[];
  constructor(op: string, violations: readonly InvariantViolation[]) {
    super(
      `[InvariantError] ${op} broke ${violations.map((v) => v.code).join(', ')}: ${JSON.stringify(violations)}`,
    );
    this.name = 'InvariantError';
    this.violations = violations;
  }
}

/** A drawing's closed curve item in an ortho view, resolved as a contour. */
export function contourItem(d: Drawing, id: string): Result<Contour, ModelingError> {
  const item = d?.items?.find((i) => i.id === id);
  const view = d?.views?.find((v) => v.id === item?.view);
  if (item?.kind !== 'curve' || item.closed !== true || view === undefined || !('ortho' in view)) {
    return err(
      modelingError(
        'model-invalid-argument',
        'a closed curve item of the drawing in an ortho view',
        {
          drawing: d?.name,
          item: id,
        },
      ),
    );
  }
  const curve = resolveCurveSpec(item.curve, {
    closed: true,
    ...(item.tolerance === undefined ? {} : { tolerance: item.tolerance }),
  });
  return curve.ok ? ok({ ...curve.value, id, view: view.ortho }) : curve;
}
