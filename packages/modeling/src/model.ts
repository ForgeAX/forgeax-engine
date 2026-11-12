import { err, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import { type ArrayOptions, arrayCopies } from './array';
import { maxOf, replaceAll } from './arrays';
import { type BevelOptions, bevel } from './bevel';
import { resolveBlends } from './blend';
import { type BooleanOptions, booleanOp } from './boolean';
import {
  authorSite,
  type CaptureOptions,
  MAX_CHECKPOINTS,
  MAX_STEP_BYTES,
  registerCapturedSession,
  type SourceSite,
} from './capture';
import { dissolve, fillHoles, orient, split, triangulate } from './cleanup';
import type {
  BooleanOperation,
  ComputeBackend,
  ComputeOptions,
  ComputePolicy,
} from './compute/job';
import type { FlowGuide } from './compute/line-field';
import { append, bridge, disconnect, duplicate } from './connect';
import { growOutline } from './contour';
import { markCrease } from './crease';
import {
  bisect,
  type CutPlane,
  loopCut,
  type PlaneCutOptions,
  planeCut,
  type SupportLoopOptions,
  supportLoops,
} from './cut';
import {
  type BendOptions,
  bend,
  type CageOptions,
  type CurveDeformOptions,
  cage,
  curveDeform,
  type LatticeOptions,
  lattice,
  type SmoothOptions,
  smooth,
  type TaperOptions,
  type TwistOptions,
  taper,
  twist,
} from './deform';
import {
  type ArapOptions,
  arap,
  describeHandles,
  describePins,
  type ImplicitSmoothOptions,
  implicitSmooth,
  type SolveContext,
} from './deform-solve';
import {
  type Contour,
  type Drawing,
  type ResolvedDrawing,
  resolveCurveSpec,
  resolveDrawing,
} from './drawing';
import { checkDrawings } from './drawing-check';
import { checkEdgeFlow } from './edge-flow';
import { type ModelingError, type ModelingSite, modelingError } from './errors';
import { type ExportOptions, type ExportReport, exportMesh, MIRROR_SUFFIX } from './finish';
import { checkSnapshotOperand, decodeSnapshot, encodeSnapshot, notePoisonedSnapshot } from './fxem';
import { type Axis, axisIndex, type Tuple3 } from './geom';
import {
  debugValidate,
  type Generations,
  generationsOf,
  type InvariantViolation,
  invariantChecksEnabled,
} from './invariants';
import { type KnifeOptions, knife } from './knife';
import { type LayerOptions, layer } from './layer';
import {
  buildLayout,
  checkLayout,
  type LayoutFit,
  layoutPatches,
  type PatchLayoutSpec,
  type ResolvedLayout,
  resolveLayout,
} from './layout';
import { lift } from './lift';
import { type LowpolyOptions, lowpolyFaces } from './lowpoly';
import { EDGE_SEAM, EditMesh } from './mesh';
import {
  type MeshQualityLimits,
  type MeshQualityReport,
  meshQuality,
  resolveFlowGuides,
} from './mesh-quality';
import { checkCurve, type NurbsSurface, surfaceDomain, surfacePoint } from './nurbs';
import {
  type Attribution,
  deleteFaces,
  extrude,
  flipFaces,
  inset,
  markEdges,
  mirror,
  type OpDiagnostic,
  offset,
  type ProjectOptions,
  projectUv,
  type RegionMode,
  type RepairReport,
  type RepairSink,
  type RoleCounts,
  transformVertices,
  weld,
} from './ops';
import { type PanelLineOptions, panelLine } from './panel';
import { type PathExtrudeOptions, pathExtrude } from './path-extrude';
import { type PipeNetworkOptions, pipeNetwork } from './pipe-network';
import { cleanupPlanar, cleanupQuads, type QuadOptions } from './planar';
import type { Point2 } from './primitives';
import {
  appendBox,
  appendCone,
  appendCylinder,
  appendExtrudePolygon,
  appendPlane,
  appendPolygon,
  appendRevolve,
  appendSphere,
  appendTorus,
  type BoxOptions,
  type ConeOptions,
  type CylinderOptions,
  type ExtrudePolygonOptions,
  type PlaneOptions,
  type PolygonOptions,
  type RevolveOptions,
  type SphereOptions,
  type TorusOptions,
} from './primitives';
import {
  cleanupTiling,
  type RemeshOptions,
  remeshFaces,
  type SimplifyOptions,
  simplifyFaces,
  type TilingOptions,
} from './remesh';
import { cleanupSlivers, resolveTJunctions, weldEdgeSequence } from './repair';
import type { Issue } from './report';
import {
  type EdgeSelector,
  type FaceSelector,
  recordSelectors,
  Selector,
  type SelectorLog,
  type SelectorUse,
  sel,
  type VertSelector,
} from './selectors';
import { type ShellFlange, type ShellOptions, shell } from './shell';
import { type ShrinkwrapOptions, shrinkwrap } from './shrinkwrap';
import {
  measureShutLines,
  type ShutLineOptions,
  type ShutLineReport,
  shutLineChecks,
} from './shut-lines';
import {
  checkTransform,
  type SoftOptions,
  softTransform,
  type WeightedTransform,
  weighted,
} from './soft';
import { type SpherizeOptions, spherize } from './spherize';
import { type StrandsOptions, strands } from './strands';
import { type LimitOptions, type LimitSurface, subdivisionLimit } from './subd-limit';
import { type SubdivideOptions, subdivide } from './subdivide';
import { appendSurface, type SurfaceOptions, type SurfacePatch } from './surface';
import {
  checkSurfaceQuality,
  type FeatureLine,
  inflectionRanges,
  type NamedSurface,
  type SurfaceQualityCode,
  type SurfaceSeam,
} from './surface-quality';
import { type LoftOptions, loft, type SweepOptions, sweep } from './sweep';
import type { TrimRegion } from './trim';
import {
  type AutoUvOptions,
  autoUv,
  type PackOptions,
  packUv,
  type SeamSource,
  type SwatchUvOptions,
  seamSelection,
  swatchUv,
  type TrimUvOptions,
  trimUv,
  type UnwrapOptions,
  type UvContext,
  unwrapUv,
} from './uv';
import {
  CoverageLedger,
  mergeCoverage,
  type ValidateOptions,
  type ValidationCode,
  type ValidationReport,
  validateMesh,
} from './validate';
import { fromView, ORTHO_VIEWS } from './views';
import {
  gridToMesh,
  type ProcessContext,
  SdfGrid,
  type VoxelFillOptions,
  type VoxelizeOptions,
  type VoxelMeshOptions,
  type VoxelOffsetOptions,
  type VoxelUnionOptions,
  voxelize,
  voxelRebuild,
} from './voxel';

/** A shell flange; `at` limits it to the open boundary edges of those faces (default all). */
type SelectedFlange = ShellFlange & { readonly at?: FaceSelector };

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
}

interface Placement {
  readonly label?: string;
  readonly tag?: string;
  readonly material?: string;
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
  /** Provenance of the last export: render vertex -> corner, triangle -> face (compacted ids). */
  readonly provenance?: { readonly vertexCorner: Int32Array; readonly triangleFace: Int32Array };
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
  /** Source key of the last successful finish() (`mesh/<key>`); absent for helper sessions. */
  readonly output?: string;
  readonly poisoned?: ModelingError;
  readonly journal: readonly JournalEntry[];
}

/** Where a surface-quality issue is worst: the failing measure's point, or a patch center. */
function qualityPoint(
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

/** Operations whose effect assertion includes producing at least one face. */
const PRODUCING_OPS = new Set([
  'bevel',
  'extrude',
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

/** `m.smooth(...)` (Taubin) with its solved variant `m.smooth.implicit(...)`. */
export interface SmoothOperation {
  (target: FaceSelector | VertSelector, options: SmoothOptions): OpReport;
  /** Implicit fairing of the selection (default: the whole mesh). */
  implicit(
    target: FaceSelector | VertSelector | undefined,
    options: ImplicitSmoothOptions,
  ): OpReport;
}

/** Journal arguments of uv.trim / uv.swatch: the region by identity, not its whole record. */
function trimArgs(options: {
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

function describeSeams(seams: SeamSource | undefined): string | undefined {
  return seams instanceof Selector ? seams.description : seams;
}

function now(): number {
  return typeof performance === 'undefined' ? 0 : performance.now();
}

/** Decode an FXEM operand; a poisoned session's snapshot fails like the session itself. */
function decodeOperand(bytes: Uint8Array): Result<EditMesh, ModelingError> {
  const poisoned = checkSnapshotOperand(bytes);
  if (!poisoned.ok) return poisoned;
  return decodeSnapshot(bytes);
}

/**
 * Mutable modeling session that owns one editable mesh. The first failing
 * operation poisons the session: later operations are skipped and finish()
 * returns that first cause, so authors never stack geometry on a broken state.
 */
export class Model {
  readonly tolerance: number;
  private readonly signal: ModelOptions['signal'];
  private readonly faceBudget: number;
  private readonly workBudget: number | undefined;
  private readonly compute: ComputePolicy;
  private readonly native: ComputeBackend | undefined;
  private mesh = new EditMesh();
  private failure: ModelingError | undefined;
  private readonly entries: JournalEntry[] = [];
  private readonly capture: CaptureOptions | undefined;
  private readonly checkpoints: Checkpoint[] = [];
  private readonly steps: StepSnapshot[] = [];
  private stepBytes = 0;
  private readonly drawings: ResolvedDrawing[] = [];
  private readonly contours: Contour[] = [];
  private readonly surfaces: NamedSurface[] = [];
  private readonly featureLines: FeatureLine[] = [];
  /** Operation index that declared each surface and feature line, for located reports. */
  private readonly qualitySources = new Map<string, number>();
  /** Declared patch layouts, with their matched patches once `surface({ layout })` built them. */
  private readonly layouts: DeclaredLayout[] = [];
  private provenance: ModelDiagnostics['provenance'];
  private output: string | undefined;
  private selectorLog: SelectorLog | undefined;
  private generations: Generations | undefined;

  constructor(options: ModelOptions = {}) {
    this.tolerance = options.tolerance ?? 1e-5;
    this.signal = options.signal;
    this.faceBudget = options.budget?.faces ?? Infinity;
    this.workBudget = options.budget?.work;
    this.compute = options.compute ?? 'auto';
    this.native = options.native;
    this.capture = registerCapturedSession(this);
  }

  private get captured(): boolean {
    return this.capture !== undefined;
  }

  /**
   * Name an intermediate state for inspection tools. A no-op in ordinary builds;
   * inside a capture the first MAX_CHECKPOINTS checkpoints keep an FXEM snapshot.
   */
  checkpoint(name: string): void {
    if (!this.captured || this.checkpoints.length >= MAX_CHECKPOINTS) return;
    const source = authorSite();
    this.checkpoints.push({
      name,
      opIndex: this.entries.length,
      snapshot: encodeSnapshot(this.mesh),
      faces: this.mesh.faceCount,
      vertices: this.mesh.vertexCount,
      ...(source === undefined ? {} : { source }),
    });
  }

  /** Diagnostic companion; available on any session, retained data only when captured. */
  diagnostics(): ModelDiagnostics {
    let validation: ValidationReport | undefined;
    let snapshot: Uint8Array | undefined;
    const model = this;
    return {
      inspection: this.inspect(),
      get validation() {
        validation ??= model.validate();
        return validation;
      },
      get snapshot() {
        snapshot ??= model.snapshot();
        return snapshot;
      },
      checkpoints: [...this.checkpoints],
      steps: [...this.steps],
      stepsTruncated: this.stepBytes > MAX_STEP_BYTES,
      drawings: [...this.drawings],
      contours: [...this.contours],
      surfaces: [...this.surfaces],
      featureLines: [...this.featureLines],
      ...(this.provenance === undefined ? {} : { provenance: this.provenance }),
    };
  }

  /** The first failure, if any. */
  get poisoned(): ModelingError | undefined {
    return this.failure;
  }

  get journal(): readonly JournalEntry[] {
    return this.entries;
  }

  /** Read-only access to the underlying editable mesh. */
  get editMesh(): EditMesh {
    return this.mesh;
  }

  // ---- primitives ---------------------------------------------------------

  box(options: BoxOptions & Placement): OpReport {
    return this.run('box', options, options, (attribution) =>
      appendBox(this.mesh, options, attribution),
    );
  }

  plane(options: PlaneOptions & Placement): OpReport {
    return this.run('plane', options, options, (attribution) =>
      appendPlane(this.mesh, options, attribution),
    );
  }

  polygon(options: PolygonOptions & Placement): OpReport {
    return this.run('polygon', options, options, (attribution) =>
      appendPolygon(this.mesh, options, attribution),
    );
  }

  cylinder(options: CylinderOptions & Placement): OpReport {
    return this.run('cylinder', options, options, (attribution) =>
      appendCylinder(this.mesh, options, attribution),
    );
  }

  cone(options: ConeOptions & Placement): OpReport {
    return this.run('cone', options, options, (attribution) =>
      appendCone(this.mesh, options, attribution),
    );
  }

  sphere(options: SphereOptions & Placement): OpReport {
    return this.run('sphere', options, options, (attribution) =>
      appendSphere(this.mesh, options, attribution),
    );
  }

  torus(options: TorusOptions & Placement): OpReport {
    return this.run('torus', options, options, (attribution) =>
      appendTorus(this.mesh, options, attribution),
    );
  }

  /** Revolve a `[radius, y]` profile about +Y. */
  revolve(options: RevolveOptions & Placement): OpReport {
    return this.run('revolve', options, options, (attribution) =>
      appendRevolve(this.mesh, options, attribution),
    );
  }

  /** Extrude an `[x, y]` outline along +Z without holes or bevel. */
  extrudePolygon(options: ExtrudePolygonOptions & Placement): OpReport {
    return this.run('extrudePolygon', options, options, (attribution) =>
      appendExtrudePolygon(this.mesh, options, attribution),
    );
  }

  /**
   * Sweep a closed `[x, y]` section (or several, morphed by arc length) along a
   * path: polyline (optionally with bent corners), Catmull-Rom, arc or helix. Frames
   * are rotation-minimizing ('rmf', default) or keep `up` ('up'); twist and scale
   * ramp linearly with arc length; `closed` joins the ends into a ring. Roles `side`,
   * `start` and `end`; section corners and path joints sharper than `sharpAngle` get
   * sharp edges; uv0 runs along the section (u) and the path (v) in meters.
   */
  sweep(options: SweepOptions & Placement): OpReport {
    return this.run('sweep', options, options, (attribution, diagnostics) =>
      sweep(this.mesh, options, attribution, this.tolerance, diagnostics),
    );
  }

  /**
   * Pipe network from a skeleton graph (`nodes`, `edges`, one `radius`): a convex-hull
   * polyhedron per branching node, an equal-ring quad band per strut, a cap per leaf, one
   * Catmull-Clark round into an all-quad mesh. Faces carry label `node:<i>` (role `node`,
   * `cap` on a leaf) or `strut:<i>` (role `strut`). Branches closer than 15 degrees and
   * struts too short or too close are `model-precondition` (`detail.reason`).
   */
  pipeNetwork(options: PipeNetworkOptions): OpReport {
    return this.run('pipeNetwork', options, {}, (_attribution, diagnostics) =>
      pipeNetwork(
        this.mesh,
        options,
        {
          tolerance: this.tolerance,
          policy: this.compute,
          faceBudget: this.faceBudget,
          ...(this.native === undefined ? {} : { native: this.native }),
          ...(this.signal === undefined ? {} : { signal: this.signal }),
          ...(this.workBudget === undefined ? {} : { budget: this.workBudget }),
        },
        diagnostics,
      ),
    );
  }

  /**
   * Loft through two or more closed planar 3D sections; vertex counts may differ
   * (match 'arclength' resamples them, keeping every corner). Roles `side`, `start`
   * and `end`; `segments` > 1 interpolates rows on a Catmull-Rom curve.
   */
  loft(options: LoftOptions & Placement): OpReport {
    return this.run('loft', options, options, (attribution, diagnostics) =>
      loft(this.mesh, options, attribution, this.tolerance, diagnostics),
    );
  }

  /**
   * Tessellate NURBS patches (see `nurbs`) adaptively within `chord` meters and
   * `angle` degrees. Trims cut holes and imprints split faces off, both as regions of
   * the normalized parameter domain or as view outlines projected onto the patch;
   * patches that share a boundary weld watertight. Roles: the patch `name` (default
   * 'surface') and each imprint's role; uv0 in meters, uv1 the normalized domain. The
   * journal records a summary of each control net, not its points.
   */
  /**
   * Declare a patch layout: roles, planned degrees and nets, and per
   * side a shared edge with its continuity, a feature line, a mirror plane or a free
   * edge. It leaves the mesh unchanged; `surface({ layout })` builds it and
   * `validate({ layout })` checks the plan and the built patches.
   */
  patchLayout(spec: PatchLayoutSpec): OpReport {
    const summary = {
      name: spec?.name ?? 'layout',
      patches: spec?.patches?.map((p) => ({
        id: p?.id,
        role: p?.role,
        ...(p?.net === undefined ? {} : { net: p.net }),
      })),
      featureLines: spec?.featureLines ?? [],
    };
    return this.run('patchLayout', summary, {}, () => {
      const resolved = resolveLayout(spec);
      if (!resolved.ok) return resolved;
      if (this.layouts.some((l) => l.resolved.name === resolved.value.name))
        return err(
          modelingError('model-invalid-argument', 'layout names are unique', {
            name: resolved.value.name,
          }),
        );
      this.layouts.push({ resolved: resolved.value, opIndex: this.entries.length });
      return ok({});
    });
  }

  /**
   * Tessellate NURBS patches; with `layout`, first build that layout's patches (fit,
   * mirror, match each shared side to the patch built before it) and add its blends.
   */
  surface(
    options: Omit<SurfaceOptions, 'patches'> & {
      readonly patches?: readonly SurfacePatch[];
      /** Name of a declared `patchLayout` to build. */
      readonly layout?: string;
    } & Placement,
  ): OpReport {
    const summary = {
      ...options,
      patches: options.patches?.map((p) => ({
        ...(p.name === undefined ? {} : { name: p.name }),
        degree: [p.surface?.degreeU, p.surface?.degreeV],
        net: [p.surface?.points?.length, p.surface?.points?.[0]?.length],
        rational: p.surface?.weights !== undefined,
        trims: p.trims?.length ?? 0,
        imprints: p.imprints?.map((i) => i.role ?? 'imprint') ?? [],
        ...(p.flip === true ? { flip: true } : {}),
        ...(p.support === undefined ? {} : { support: p.support }),
      })),
    };
    return this.run('surface', summary, options, (attribution, diagnostics) => {
      let patches = options.patches ?? [];
      let blends = options.blends ?? [];
      let corners = options.corners ?? [];
      let layout: (typeof this.layouts)[number] | undefined;
      if (options.layout !== undefined) {
        layout = this.layouts.find((l) => l.resolved.name === options.layout);
        if (layout === undefined)
          return err(
            modelingError('model-invalid-argument', 'layout names a declared patchLayout', {
              layout: options.layout,
              declared: this.layouts.map((l) => l.resolved.name),
            }),
          );
        if (layout.built !== undefined)
          return err(
            modelingError('model-invalid-argument', 'a layout is built once', {
              layout: options.layout,
            }),
          );
        const built = buildLayout(layout.resolved);
        if (!built.ok) return built;
        patches = [...layoutPatches(layout.resolved, built.value.surfaces), ...patches];
        blends = [...(layout.resolved.spec.blends ?? []), ...blends];
        corners = [...(layout.resolved.spec.corners ?? []), ...corners];
        layout.built = built.value.surfaces;
        layout.fits = built.value.fits;
        if (built.value.fits.size > 0)
          diagnostics.push({
            severity: 'info',
            message: `${built.value.fits.size} layout patch(es) fit to points: residual per patch`,
            detail: { fits: Object.fromEntries(built.value.fits) },
          });
      }
      if (blends.length > 0) {
        const resolved = resolveBlends(patches, blends, corners, diagnostics);
        if (!resolved.ok) return resolved;
        patches = resolved.value.patches;
        if (layout !== undefined) {
          const quads = new Map<string, NurbsSurface[]>();
          for (const p of patches)
            if (p.transition?.kind === 'corner') {
              const group = (p.name ?? 'corner').replace(/-\d+$/, '');
              quads.set(group, [...(quads.get(group) ?? []), p.surface]);
            }
          layout.corners = quads;
        }
        diagnostics.push({
          severity: 'info',
          message: `${resolved.value.reports.length} blend(s) and corner(s): setback and gap per blend, setback, kink and fill residual per corner`,
          detail: { blends: resolved.value.reports },
        });
      }
      const taken = new Set(this.surfaces.map((s) => s.name));
      const names = patches.map((patch) => {
        const name = patch.name ?? 'surface';
        let id = name;
        for (let k = 1; taken.has(id); k++) id = `${name}.${k}`;
        taken.add(id);
        return id;
      });
      const index = new Map<string, number>();
      for (const [k, patch] of patches.entries())
        if (patch.name !== undefined && !index.has(patch.name)) index.set(patch.name, k);
      const declared = (layout?.resolved.edges ?? []).flatMap((e) => {
        const a = index.get(e.a);
        const b = index.get(e.b);
        return a === undefined || b === undefined ? [] : [{ a, sideA: e.sideA, b, sideB: e.sideB }];
      });
      const trimLoops: Point2[][][] = [];
      const seams: { owner: number; seam: SurfaceSeam }[] = [];
      const appended = appendSurface(
        this.mesh,
        { ...options, patches, blends },
        attribution,
        this.tolerance,
        this.computeOptions(),
        diagnostics,
        { names, declared, trimLoops, seams },
      );
      if (appended.ok)
        for (const [k, patch] of patches.entries()) {
          const owned = seams.filter((s) => s.owner === k).map((s) => s.seam);
          this.recordSurface(names[k] as string, patch.surface, {
            ...(patch.inflections === undefined ? {} : { inflections: patch.inflections }),
            ...(patch.transition === undefined ? {} : { transition: patch.transition }),
            ...((trimLoops[k]?.length ?? 0) > 0 ? { trims: trimLoops[k] } : {}),
            ...(owned.length > 0 ? { seams: owned } : {}),
          });
        }
      return appended;
    });
  }

  private recordSurface(
    name: string,
    surface: NurbsSurface,
    facts: Omit<NamedSurface, 'name' | 'surface'>,
  ): string {
    let id = name;
    for (let k = 1; this.surfaces.some((s) => s.name === id); k++) id = `${name}.${k}`;
    this.surfaces.push({ name: id, surface, ...facts });
    this.qualitySources.set(id, this.entries.length);
    return id;
  }

  /**
   * Declare a styling feature line (shoulder, waist, sill, wheel-arch line) as a NURBS
   * curve. It leaves the mesh unchanged: renders draw its curvature comb, and
   * `validate({ surfaceQuality })` checks its fairness and requires its `continuity`
   * (G0 marks a designed break) of the patch edges that run along it.
   */
  featureLine(line: FeatureLine): OpReport {
    const summary = {
      name: line?.name,
      ...(line?.continuity === undefined ? {} : { continuity: line.continuity }),
      ...(line?.inflections === undefined ? {} : { inflections: line.inflections }),
      degree: line?.curve?.degree,
      points: line?.curve?.points?.length,
    };
    return this.run('featureLine', summary, {}, () => {
      if (typeof line?.name !== 'string' || line.name.length === 0)
        return err(modelingError('model-invalid-argument', 'a feature line has a name', {}));
      if (this.featureLines.some((f) => f.name === line.name))
        return err(
          modelingError('model-invalid-argument', 'feature line names are unique', {
            name: line.name,
          }),
        );
      if (line.continuity !== undefined && !['G0', 'G1', 'G2', 'G3'].includes(line.continuity))
        return err(
          modelingError('model-invalid-argument', 'continuity is G0, G1, G2 or G3', {
            continuity: line.continuity,
          }),
        );
      const checked = checkCurve(line.curve);
      if (!checked.ok) return checked;
      const ranges = inflectionRanges(line);
      if (!ranges.ok) return ranges;
      this.featureLines.push(line);
      this.qualitySources.set(line.name, this.entries.length);
      return ok({});
    });
  }

  /**
   * Extrude a drawing's closed curve item (in an ortho view) along that view's axis between
   * the two view depths: side `side` walls, `top` toward the viewer. The item's tolerance is
   * the curve's sampling and fit tolerance.
   */
  extrudeContour(d: Drawing, id: string, options: ExtrudeContourOptions & Placement): OpReport {
    return this.run(
      'extrudeContour',
      { drawing: d?.name, item: id, ...options },
      options,
      (attribution) => {
        const contour = contourItem(d, id);
        if (!contour.ok) return contour;
        const [near, far] = options.depth ?? [];
        if (
          !Number.isFinite(near) ||
          !Number.isFinite(far) ||
          (far as number) <= (near as number)
        ) {
          return err(
            modelingError('model-invalid-argument', 'depth is [near, far] with near < far', {
              depth: options.depth,
            }),
          );
        }
        const grow = options.grow ?? 0;
        if (!Number.isFinite(grow) || grow < 0) {
          return err(
            modelingError('model-invalid-argument', 'grow is a finite length >= 0', { grow }),
          );
        }
        const points = grow === 0 ? contour.value.points : growOutline(contour.value.points, grow);
        const appended = appendExtrudePolygon(
          this.mesh,
          { points, depth: (far as number) - (near as number) },
          attribution,
          (u, v, w) => fromView(contour.value.view, [u, v], (near as number) + w),
        );
        if (appended.ok) this.contours.push(contour.value);
        return appended;
      },
    );
  }

  /**
   * Three-view intersection: the solid whose silhouette in each view is that view's
   * contour (two or three closed curve items of a drawing, on distinct view axes, e.g.
   * side, top, front).
   * Each contour is extruded through the extent of the others (tag `view-<view>`)
   * and intersected with the result so far, so history and replay show every prism
   * and cut. Faces keep the tag of the view that shaped them.
   */
  threeView(d: Drawing, ids: readonly string[], options: ThreeViewOptions = {}): OpReport {
    const resolved: Contour[] = [];
    const axes = new Set<number>();
    for (const id of ids) {
      const contour = contourItem(d, id);
      if (!contour.ok)
        return this.run('threeView', { drawing: d?.name, items: ids }, options, () => contour);
      axes.add(ORTHO_VIEWS[contour.value.view].toward.findIndex((c) => c !== 0));
      resolved.push(contour.value);
    }
    if (resolved.length < 2 || resolved.length > 3 || axes.size !== resolved.length) {
      return this.run('threeView', { views: resolved.map((c) => c.view) }, options, () =>
        err(
          modelingError(
            'model-invalid-argument',
            'two or three contours on distinct view axes (front/back, right/left, top/bottom)',
            { views: resolved.map((c) => c.view) },
          ),
        ),
      );
    }
    // World extent per axis from the views that draw it.
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const contour of resolved) {
      const frame = ORTHO_VIEWS[contour.view];
      const [u0, v0, u1, v1] = contour.bounds;
      for (const [direction, a, b] of [
        [frame.right, u0, u1],
        [frame.up, v0, v1],
      ] as const) {
        const k = direction.findIndex((c) => c !== 0);
        const sign = direction[k] as number;
        lo[k] = Math.min(lo[k] as number, Math.min(a * sign, b * sign));
        hi[k] = Math.max(hi[k] as number, Math.max(a * sign, b * sign));
      }
    }
    const margin =
      options.margin ?? 0.02 * maxOf([0, 1, 2].map((k) => (hi[k] as number) - (lo[k] as number)));
    const clearance = options.clearance ?? 0.0005;
    let report: OpReport | undefined;
    for (const [i, contour] of resolved.entries()) {
      const toward = ORTHO_VIEWS[contour.view].toward;
      const k = toward.findIndex((c) => c !== 0);
      const sign = toward[k] as number;
      const [a, b] = [(lo[k] as number) * sign, (hi[k] as number) * sign];
      const tag = `view-${contour.view}`;
      report = this.extrudeContour(d, contour.id, {
        depth: [Math.min(a, b) - margin, Math.max(a, b) + margin],
        grow: i * clearance,
        tag,
        ...(options.material === undefined ? {} : { material: options.material }),
      });
      // The first failure poisons the session; later operations would only report `skipped`.
      if (report.status !== 'ok') return report;
      if (i > 0) {
        report = this.intersection(sel.tag(tag), {
          ...(options.label === undefined ? {} : { label: options.label }),
        });
        if (report.status !== 'ok') return report;
      }
    }
    return report as OpReport;
  }

  /**
   * Attach a design drawing (views, hard points, lines, sections, breaks, dimensions, as
   * data; no images). It leaves the mesh unchanged; ortho renders draw it under the subject.
   */
  drawing(d: Drawing): OpReport {
    return this.run('drawing', { name: d?.name }, {}, () => {
      const resolved = resolveDrawing(d);
      if (!resolved.ok) return resolved;
      this.drawings.push(resolved.value);
      return ok({});
    });
  }

  // ---- editing ----------------------------------------------------------------

  /**
   * Extrude faces along their region normal by `distance`, or, with `path`, grow the
   * region along a path: its boundary ring is placed at every path station in that
   * station's (rotation-minimizing) frame with the station's `scale` and `twist`; walls
   * get role `side`, the moved region `top`.
   */
  extrude(
    faces: FaceSelector,
    options:
      | { readonly distance: number; readonly region: RegionMode; readonly label?: string }
      | (PathExtrudeOptions & { readonly label?: string }),
  ): OpReport {
    if ('path' in options) {
      return this.runOn('extrude', faces, options, (ids, attribution, diagnostics) =>
        pathExtrude(this.mesh, ids, options, attribution.label, this.tolerance, diagnostics),
      );
    }
    return this.runOn('extrude', faces, options, (ids, attribution, diagnostics) =>
      extrude(this.mesh, ids, options, attribution.label, this.tolerance, diagnostics),
    );
  }

  inset(
    faces: FaceSelector,
    options: { readonly thickness: number; readonly region: RegionMode; readonly label?: string },
  ): OpReport {
    return this.runOn('inset', faces, options, (ids, attribution) =>
      inset(this.mesh, ids, options, attribution.label),
    );
  }

  /** Move faces along their vertex normals so each face plane moves by `distance`. */
  offset(
    faces: FaceSelector,
    options: { readonly distance: number; readonly region: RegionMode; readonly label?: string },
  ): OpReport {
    return this.runOn('offset', faces, options, (ids, attribution, diagnostics) =>
      offset(this.mesh, ids, options, attribution.label, this.tolerance, diagnostics),
    );
  }

  /**
   * Thicken whole parts into walls of `thickness` (roles `inner`, `rim`; the outer
   * surface keeps its identity); `open` faces among them are removed first and
   * become rimmed openings. Known limit: a band tighter than the thickness is mitered
   * between the two planes that bound it, so a corner where three such bands meet (a box
   * with every edge bevelled or rounded below the thickness) still collapses and fails with
   * `limitedBy: 'collapse'`; give those corners a radius of at least the thickness.
   */
  shell(
    faces: FaceSelector,
    options: Omit<ShellOptions, 'flange'> & {
      readonly open?: FaceSelector;
      readonly label?: string;
      /**
       * A return flange, or several with their own settings; `at` limits one to the open
       * boundary edges of those faces (default all).
       */
      readonly flange?: SelectedFlange | readonly SelectedFlange[];
    },
  ): OpReport {
    const { open, flange, ...rest } = options;
    const list = (
      flange === undefined ? [] : Array.isArray(flange) ? flange : [flange]
    ) as readonly SelectedFlange[];
    const flanges = list.map(
      ({ reach, depth, radius, round }): ShellFlange => ({
        reach,
        depth,
        ...(radius === undefined ? {} : { radius }),
        ...(round === undefined ? {} : { round }),
      }),
    );
    const describe = (
      { at }: SelectedFlange,
      i: number,
    ): ShellFlange & { readonly at?: string } => ({
      ...(flanges[i] as ShellFlange),
      ...(at === undefined ? {} : { at: at.description }),
    });
    const args = {
      ...rest,
      ...(open === undefined ? {} : { open: open.description }),
      ...(flange === undefined
        ? {}
        : {
            flange: Array.isArray(flange)
              ? list.map(describe)
              : describe(list[0] as SelectedFlange, 0),
          }),
    };
    return this.runOn('shell', faces, args, (ids, attribution, diagnostics) => {
      let opened: number[] = [];
      if (open !== undefined) {
        const resolved = open.resolve(this.mesh);
        if (!resolved.ok) return resolved;
        opened = resolved.value;
      }
      const at: (number[] | undefined)[] = [];
      for (const { at: selector } of list) {
        if (selector === undefined) {
          at.push(undefined);
          continue;
        }
        const resolved = selector.resolve(this.mesh);
        if (!resolved.ok) return resolved;
        at.push(resolved.value);
      }
      return shell(
        this.mesh,
        ids,
        opened,
        {
          ...rest,
          ...(flange === undefined
            ? {}
            : { flange: Array.isArray(flange) ? flanges : (flanges[0] as ShellFlange) }),
        },
        attribution.label,
        this.tolerance,
        diagnostics,
        undefined,
        at,
      );
    });
  }

  /** Copy faces as a separate island; the copies get role `copy`. */
  duplicate(faces: FaceSelector, options: { readonly label?: string } = {}): OpReport {
    return this.runOn('duplicate', faces, options, (ids, attribution) =>
      duplicate(this.mesh, ids, attribution.label),
    );
  }

  /** Detach faces from the rest of the mesh in place (shared vertices are duplicated). */
  disconnect(faces: FaceSelector): OpReport {
    return this.runOn('disconnect', faces, {}, (ids) => disconnect(this.mesh, ids));
  }

  /**
   * Copy another session or an FXEM snapshot into this one. The operand is read
   * only; tags, labels and material slots merge by name. With `label`, the copied
   * faces get role `part` instead of their own origins.
   */
  append(
    part: Model | Uint8Array,
    options: {
      readonly translate?: Tuple3;
      readonly label?: string;
      readonly tag?: string;
    } = {},
  ): OpReport {
    return this.run('append', options, options, (attribution) => {
      const source = this.operand(part);
      if (!source.ok) return source;
      return append(this.mesh, source.value, options, attribution);
    });
  }

  /**
   * Join two closed boundary loops with a quad strip (role `side`); the shorter loop's
   * longest edges split until the counts match (a limb end into a body opening). Pass
   * `material` when the loops border different material slots.
   */
  bridge(
    edges: EdgeSelector,
    options: {
      readonly segments?: number;
      readonly label?: string;
      readonly tag?: string;
      readonly material?: string;
    } = {},
  ): OpReport {
    return this.runEdges('bridge', edges, options, (ids, attribution, diagnostics) =>
      bridge(
        this.mesh,
        ids,
        {
          ...(options.segments === undefined ? {} : { segments: options.segments }),
          ...(options.material === undefined ? {} : { material: attribution.material }),
        },
        attribution,
        diagnostics,
      ),
    );
  }

  /**
   * Cut edge rings through the selected edges with `cuts` evenly spaced loops.
   * Rings cross even-sided n-gons by their opposite edge and stop at odd-sided
   * faces and boundaries.
   */
  loopCut(edges: EdgeSelector, options: { readonly cuts: number }): OpReport {
    return this.runEdges('loopCut', edges, options, (ids) => loopCut(this.mesh, ids, options));
  }

  /**
   * Subdivision support loops: one or two edge loops at `offset` meters on both sides of
   * the selected edges (measured along the rungs that leave them), so `subdivide` keeps
   * those edges crisp; the thin strips get the tag `support`.
   */
  supportLoops(edges: EdgeSelector, options: SupportLoopOptions): OpReport {
    return this.runEdges('supportLoops', edges, options, (ids) =>
      supportLoops(this.mesh, ids, options),
    );
  }

  /**
   * Replace interior edges by bevel strips (role `bevel`) `width` from the edge in
   * each adjacent face, with `segments` faces across (1 = flat chamfer, more = round).
   * Corners where three or more bevels meet get role `corner`. Widths that would
   * invert a face are clamped and reported; boundary edges are `model-precondition`.
   * Pass `material` when the faces around a bevel use several slots.
   */
  bevel(
    edges: EdgeSelector,
    options: BevelOptions & {
      readonly label?: string;
      readonly tag?: string;
      readonly material?: string;
    },
  ): OpReport {
    return this.runEdges('bevel', edges, options, (ids, attribution, diagnostics) =>
      bevel(
        this.mesh,
        ids,
        options,
        attribution,
        options.material === undefined ? undefined : attribution.material,
        this.tolerance,
        diagnostics,
      ),
    );
  }

  /**
   * Cut a groove `width` wide and `depth` deep along an interior edge path, or where a
   * plane crosses the selected faces (`{ faces, point, normal }`; faces outside the
   * selection only gain the cut vertices). `square` (default) sinks a floor (role
   * `groove`) between walls (role `lip`); `v` and `u` sink the strip interior and keep
   * its rim. Rim edges become sharp; `material` assigns the groove faces a slot.
   */
  panelLine(
    path:
      | EdgeSelector
      | { readonly faces: FaceSelector; readonly point: Tuple3; readonly normal: Tuple3 },
    options: PanelLineOptions & {
      readonly label?: string;
      readonly tag?: string;
      readonly material?: string;
    },
  ): OpReport {
    const material = (attribution: Attribution) =>
      options.material === undefined ? undefined : attribution.material;
    if (path instanceof Selector) {
      return this.runEdges('panelLine', path, options, (ids, attribution, diagnostics) =>
        panelLine(
          this.mesh,
          { kind: 'edges', edges: ids },
          options,
          attribution,
          material(attribution),
          this.tolerance,
          diagnostics,
        ),
      );
    }
    const { faces, point, normal } = path;
    return this.runOn(
      'panelLine',
      faces,
      { point, normal, ...options },
      (ids, attribution, diagnostics) =>
        panelLine(
          this.mesh,
          { kind: 'plane', faces: ids, plane: { point, normal } },
          options,
          attribution,
          material(attribution),
          this.tolerance,
          diagnostics,
        ),
    );
  }

  /** Split the faces a plane crosses, keeping both sides. */
  bisect(options: CutPlane): OpReport {
    return this.run('bisect', options, {}, () => bisect(this.mesh, options, this.tolerance));
  }

  /**
   * Cut the mesh with a plane and keep one side (`positive` = the side `normal`
   * points to). Openings stay open unless `fillHoles` is set; pass `material` when
   * an opening's rim uses several slots.
   */
  planeCut(
    options: PlaneCutOptions & {
      readonly label?: string;
      readonly tag?: string;
      readonly material?: string;
    },
  ): OpReport {
    return this.run('planeCut', options, options, (attribution, diagnostics) =>
      planeCut(
        this.mesh,
        options,
        this.tolerance,
        attribution,
        options.material === undefined ? undefined : attribution.material,
        diagnostics,
      ),
    );
  }

  /** Remove interior edges, merging the faces on both sides into one n-gon per group. */
  dissolve(edges: EdgeSelector): OpReport {
    return this.runEdges('dissolve', edges, {}, (ids, _attribution, diagnostics) =>
      dissolve(this.mesh, ids, this.tolerance, diagnostics),
    );
  }

  /** Split the mesh open along interior edges whose cut reaches a boundary or closes a loop. */
  split(edges: EdgeSelector): OpReport {
    return this.runEdges('split', edges, {}, (ids, _attribution, diagnostics) =>
      split(this.mesh, ids, diagnostics),
    );
  }

  /** Flip inside-out closed components touched by the selection so they face outward. */
  orient(faces: FaceSelector): OpReport {
    return this.runOn('orient', faces, {}, (ids) => orient(this.mesh, ids));
  }

  /** Triangulate n-gons exactly as export would; a self-overlapping face is `model-degenerate` in both. */
  triangulate(faces: FaceSelector): OpReport {
    return this.runOn('triangulate', faces, {}, (ids) => triangulate(this.mesh, ids));
  }

  /**
   * Close the boundary loops that contain a selected boundary edge with n-gon caps
   * (role `cap`, sharp rim). Pass `material` when a rim uses several slots.
   */
  fillHoles(
    edges: EdgeSelector,
    options: { readonly material?: string; readonly label?: string; readonly tag?: string } = {},
  ): OpReport {
    return this.runEdges('fillHoles', edges, options, (ids, attribution, _diagnostics, repair) =>
      fillHoles(
        this.mesh,
        ids,
        options.material === undefined ? undefined : attribution.material,
        this.tolerance,
        attribution,
        repair,
      ),
    );
  }

  /**
   * Lift a triangle-list MeshAsset into the session: positions weld by exact value,
   * UV and color splits become corner values and normal discontinuities become
   * sharp edges. Non-manifold triangles are detached and reported. Merge the
   * triangles back into n-gons with dissolve(sel.edges.dihedral('<', deg)).
   */
  lift(
    mesh: MeshAsset,
    options: { readonly label?: string; readonly tag?: string } = {},
  ): OpReport {
    return this.run('lift', options, options, (attribution, diagnostics) =>
      lift(this.mesh, mesh, attribution, diagnostics),
    );
  }

  /**
   * Merge rigid copies of the selected faces, or of another session or FXEM snapshot:
   * `linear` (count, offset), `radial` (count, axis, angle, center) or `onCurve`
   * (count, path, align). Copy `i` gets tag `<label or 'copy'>:<i>`; with a label the
   * new copies get role `copy`, otherwise they keep their sources' origins. Geometry
   * only: instancing belongs to Scene placement.
   */
  array(
    target: FaceSelector | Model | Uint8Array,
    options: ArrayOptions & { readonly label?: string; readonly tag?: string },
  ): OpReport {
    const prefix = options.label ?? 'copy';
    if (target instanceof Model || target instanceof Uint8Array) {
      return this.run('array', options, options, (attribution) => {
        const source = this.operand(target);
        if (!source.ok) return source;
        return arrayCopies(
          this.mesh,
          { source: source.value },
          options,
          attribution,
          prefix,
          this.tolerance,
        );
      });
    }
    return this.runOn('array', target, options, (ids, attribution) =>
      arrayCopies(this.mesh, { faces: ids }, options, attribution, prefix, this.tolerance),
    );
  }

  /**
   * Mirror the whole mesh across the axis plane through the origin and weld the seam. Each
   * recorded patch gains its reflection, named `${name}.mirror` (`.k` appended if taken), so
   * the mirrored faces keep exact surface normals and surface checks tell the halves apart.
   * The reflection reverses the parameter orientation (su x sv points inward); exact normals
   * take their side from the face, so they still point outward.
   */
  mirror(options: { readonly axis: Axis; readonly weldDistance?: number }): OpReport {
    return this.run('mirror', options, {}, () => {
      const mirrored = mirror(this.mesh, {
        axis: options.axis,
        weldDistance: options.weldDistance ?? this.tolerance,
      });
      if (!mirrored.ok) return mirrored;
      const k = axisIndex(options.axis);
      const reflect = (p: Tuple3): Tuple3 => {
        const q: Tuple3 = [p[0], p[1], p[2]];
        q[k] = -q[k];
        return q;
      };
      const renamed = new Map<string, string>();
      const owners: [number, readonly SurfaceSeam[]][] = [];
      for (const { name, surface, seams, ...facts } of [...this.surfaces]) {
        const points = surface.points.map((row) => row.map(reflect));
        const id = this.recordSurface(`${name}${MIRROR_SUFFIX}`, { ...surface, points }, facts);
        renamed.set(name, id);
        if (seams !== undefined) owners.push([this.surfaces.length - 1, seams]);
      }
      for (const [index, seams] of owners) {
        const named = this.surfaces[index] as NamedSurface;
        this.surfaces[index] = {
          ...named,
          seams: seams.map(({ weldAt, ...seam }) => ({
            ...seam,
            a: renamed.get(seam.a) ?? seam.a,
            b: renamed.get(seam.b) ?? seam.b,
            ...(weldAt === undefined ? {} : { weldAt: reflect(weldAt) }),
          })),
        };
      }
      return mirrored;
    });
  }

  /**
   * Move the selected vertices. With `falloff` the edit is proportional (soft
   * selection): nearby unselected vertices move by their weight. `symmetry: 'x'` mirrors
   * the selection and the move across x = 0.
   */
  translate(target: FaceSelector | VertSelector, offset: Tuple3, options?: SoftOptions): OpReport {
    if (options !== undefined) {
      return this.soft('translate', target, { kind: 'translate', offset }, options);
    }
    return this.runVertices('translate', target, { offset }, (ids) =>
      transformVertices(this.mesh, ids, (p) => [
        p[0] + offset[0],
        p[1] + offset[1],
        p[2] + offset[2],
      ]),
    );
  }

  /** Scale vertices about a pivot; factors must be positive. Soft options as for translate. */
  scale(
    target: FaceSelector | VertSelector,
    factor: Tuple3,
    pivot: Tuple3 = [0, 0, 0],
    options?: SoftOptions,
  ): OpReport {
    const positive = () =>
      factor.every((s) => Number.isFinite(s) && s > 0)
        ? undefined
        : modelingError(
            'model-invalid-argument',
            'scale factors are positive; use mirror() to reflect',
            { factor },
          );
    if (options !== undefined) {
      return this.soft('scale', target, { kind: 'scale', factor, pivot }, options, positive);
    }
    return this.runVertices('scale', target, { factor, pivot }, (ids) => {
      const invalid = positive();
      if (invalid !== undefined) return err(invalid);
      return transformVertices(this.mesh, ids, (p) => [
        pivot[0] + (p[0] - pivot[0]) * factor[0],
        pivot[1] + (p[1] - pivot[1]) * factor[1],
        pivot[2] + (p[2] - pivot[2]) * factor[2],
      ]);
    });
  }

  /**
   * Rotate vertices about an axis through a pivot (degrees, right-handed). Soft options
   * as for translate: falloff vertices turn by their weight times the angle.
   */
  rotate(
    target: FaceSelector | VertSelector,
    axis: Axis,
    degrees: number,
    pivot: Tuple3 = [0, 0, 0],
    options?: SoftOptions,
  ): OpReport {
    const transform: WeightedTransform = { kind: 'rotate', axis, degrees, pivot };
    if (options !== undefined) return this.soft('rotate', target, transform, options);
    return this.runVertices('rotate', target, { axis, degrees, pivot }, (ids) =>
      transformVertices(this.mesh, ids, (p) => weighted(transform, p, 1)),
    );
  }

  /**
   * Hair cards / strand array: `count` strands grow from the face region (a scalp) along
   * one authored path placed in each root's frame (surface normal, `comb` direction), with
   * seeded per-strand length and comb-turn variation. Roles `strand` and `tip`; tag
   * `strand:<i>` per strand.
   */
  strands(faces: FaceSelector, options: StrandsOptions & { readonly label?: string }): OpReport {
    return this.runOn('strands', faces, options, (ids, attribution, diagnostics) =>
      strands(this.mesh, ids, options, attribution.label, this.tolerance, diagnostics),
    );
  }

  /**
   * Cast toward a sphere or ellipsoid: each vertex moves along its
   * direction from `center` toward the surface by `factor` (times its falloff weight).
   * A spherized subdivided box is a pole-free quad-cage head.
   */
  spherize(target: FaceSelector | VertSelector, options: SpherizeOptions): OpReport {
    return this.runVertices('spherize', target, options, (ids, diagnostics) =>
      spherize(this.mesh, ids, options, this.tolerance, diagnostics),
    );
  }

  /**
   * Catmull-Clark limit positions and normals of the selected vertices (default all): the
   * closed-form surface `subdivide` converges to, without refining. See `LimitSurface`.
   */
  limit(
    target?: FaceSelector | VertSelector,
    options: Omit<LimitOptions, 'vertices'> = {},
  ): Result<LimitSurface, ModelingError> {
    if (this.failure !== undefined) return err(this.failure);
    if (target === undefined) return subdivisionLimit(this.mesh, options);
    const ids = (target as Selector<'face' | 'vert'>).resolve(this.mesh);
    if (!ids.ok) return ids;
    const vertices = target.domain === 'vert' ? ids.value : this.verticesOf(ids.value);
    return subdivisionLimit(this.mesh, { ...options, vertices });
  }

  /**
   * Move the selected vertices onto the limit surface of the current cage. All limit points
   * are evaluated before any vertex moves, so the result does not depend on vertex order.
   */
  snapToLimit(
    target: FaceSelector | VertSelector,
    options: Omit<LimitOptions, 'vertices'> = {},
  ): OpReport {
    return this.runVertices('snapToLimit', target, options, (ids) => {
      const surface = subdivisionLimit(this.mesh, { ...options, vertices: ids });
      if (!surface.ok) return surface;
      const at = surface.value;
      for (const [i, v] of at.vertices.entries()) {
        this.mesh.setPosition(
          v,
          at.position[i * 3] as number,
          at.position[i * 3 + 1] as number,
          at.position[i * 3 + 2] as number,
        );
      }
      return ok({});
    });
  }

  private soft(
    op: string,
    target: FaceSelector | VertSelector,
    transform: WeightedTransform,
    options: SoftOptions,
    check: () => ModelingError | undefined = () => undefined,
  ): OpReport {
    const { kind: _kind, ...parameters } = transform;
    return this.runVertices(op, target, { ...parameters, ...options }, (ids, diagnostics) => {
      const invalid = check();
      if (invalid !== undefined) return err(invalid);
      const checked = checkTransform(transform);
      if (!checked.ok) return checked;
      return softTransform(this.mesh, op, ids, transform, options, this.tolerance, diagnostics);
    });
  }

  /**
   * Cut a polyline into the faces (default all; `faces` limits and guides the cut):
   * a knife project along `direction` (the visible layer, or every layer with
   * `through`), or a path on the surface. Crossed faces split into valid n-gons,
   * crossings near a vertex go through it (`snap`), `sharp`/`seam` mark the new edges,
   * and a `closed` path gives the enclosed faces role `inside` and the placement tag.
   */
  knife(
    options: KnifeOptions & {
      readonly faces?: FaceSelector;
      readonly label?: string;
      readonly tag?: string;
    },
  ): OpReport {
    const { faces, ...rest } = options ?? ({} as typeof options);
    const body = (ids: number[], attribution: Attribution, diagnostics: OpDiagnostic[]) =>
      knife(this.mesh, ids, rest, attribution.label, attribution.tag, this.tolerance, diagnostics);
    if (faces === undefined) {
      return this.run('knife', rest, rest, (attribution, diagnostics) =>
        body(this.mesh.faces(), attribution, diagnostics),
      );
    }
    return this.runOn('knife', faces, rest, body);
  }

  flip(faces: FaceSelector): OpReport {
    return this.runOn('flip', faces, {}, (ids) => flipFaces(this.mesh, ids));
  }

  delete(faces: FaceSelector): OpReport {
    return this.runOn('delete', faces, {}, (ids) => deleteFaces(this.mesh, ids));
  }

  /** Merge vertices closer than `distance` (meters). */
  weld(options: { readonly distance: number }): OpReport {
    return this.run('weld', options, {}, (_attribution, _diagnostics, repair) =>
      weld(this.mesh, options.distance, repair),
    );
  }

  // ---- subdivision and deformation (design 8: subdiv, deform) ----------------------

  /**
   * Subdivide faces (default all) as a compute job: Catmull-Clark (sharp edges stay
   * infinitely sharp creases) or Simple. Children keep their face's material, label,
   * role and tags; corner values interpolate linearly. Vertices next to unselected
   * faces stay put, so the neighbours only gain edge points.
   */
  subdivide(faces: FaceSelector | undefined, options: SubdivideOptions): OpReport {
    const body = (ids: readonly number[], diagnostics: OpDiagnostic[]) =>
      subdivide(
        this.mesh,
        ids,
        options,
        {
          tolerance: this.tolerance,
          policy: this.compute,
          faceBudget: this.faceBudget,
          ...(this.native === undefined ? {} : { native: this.native }),
          ...(this.signal === undefined ? {} : { signal: this.signal }),
          ...(this.workBudget === undefined ? {} : { budget: this.workBudget }),
        },
        diagnostics,
      );
    if (faces === undefined) {
      return this.run('subdivide', options, {}, (_attribution, diagnostics) =>
        body(this.mesh.faces(), diagnostics),
      );
    }
    return this.runOn('subdivide', faces, options, (ids, _attribution, diagnostics) =>
      body(ids, diagnostics),
    );
  }

  /** Free-form deformation: move lattice control points; Bernstein weights move the vertices. */
  lattice(target: FaceSelector | VertSelector, options: LatticeOptions): OpReport {
    return this.runVertices('lattice', target, options, (ids, diagnostics) =>
      lattice(this.mesh, ids, options, this.tolerance, diagnostics),
    );
  }

  /** Cage deformation by mean value coordinates of a closed rest cage and its moved points. */
  cage(target: FaceSelector | VertSelector, options: CageOptions): OpReport {
    return this.runVertices('cage', target, options, (ids, diagnostics) =>
      cage(this.mesh, ids, options, this.tolerance, diagnostics),
    );
  }

  /** Bend the `range` along `axis` into a circular arc of `angle` degrees curling `toward`. */
  bend(target: FaceSelector | VertSelector, options: BendOptions): OpReport {
    return this.runVertices('bend', target, options, (ids, diagnostics) =>
      bend(this.mesh, ids, options, this.tolerance, diagnostics),
    );
  }

  /** Twist about `axis`, ramping from 0 to `angle` degrees over `range`. */
  twist(target: FaceSelector | VertSelector, options: TwistOptions): OpReport {
    return this.runVertices('twist', target, options, (ids, diagnostics) =>
      twist(this.mesh, ids, options, this.tolerance, diagnostics),
    );
  }

  /** Scale cross sections of `axis`, ramping from 1 to `factor` over `range`. */
  taper(target: FaceSelector | VertSelector, options: TaperOptions): OpReport {
    return this.runVertices('taper', target, options, (ids, diagnostics) =>
      taper(this.mesh, ids, options, this.tolerance, diagnostics),
    );
  }

  /** Lay the mesh along a path: distance along `axis` becomes arc length. */
  curveDeform(target: FaceSelector | VertSelector, options: CurveDeformOptions): OpReport {
    return this.runVertices('curveDeform', target, options, (ids, diagnostics) =>
      curveDeform(this.mesh, ids, options, this.tolerance, diagnostics),
    );
  }

  /**
   * Taubin lambda/mu smoothing; mesh-boundary and sharp-edge vertices stay pinned by
   * default. `smooth.implicit` is backward-Euler cotangent-Laplacian fairing solved by
   * solve.sparse jobs.
   */
  readonly smooth: SmoothOperation = Object.assign(
    (target: FaceSelector | VertSelector, options: SmoothOptions): OpReport =>
      this.runVertices('smooth', target, options, (ids, diagnostics) =>
        smooth(this.mesh, ids, options, this.tolerance, diagnostics),
      ),
    {
      implicit: (
        target: FaceSelector | VertSelector | undefined,
        options: ImplicitSmoothOptions,
      ): OpReport => {
        const args = { ...options, pin: describePins(options?.pin) };
        const body = (ids: number[], diagnostics: OpDiagnostic[]) =>
          implicitSmooth(this.mesh, ids, options, this.solveContext(), diagnostics);
        if (target === undefined) {
          return this.run('smooth.implicit', args, {}, (_attribution, diagnostics) =>
            body(this.mesh.vertices(), diagnostics),
          );
        }
        return this.runVertices('smooth.implicit', target, args, body);
      },
    },
  );

  /**
   * As-rigid-as-possible deformation of the selected region: handles move rigidly to
   * their targets, pins stay, the rest follows as rigidly as possible (local/global
   * iterations, each global step a solve.sparse job per coordinate). Reports the energy
   * after every iteration and warns on faces turned against their fitted rotation.
   */
  arap(target: FaceSelector | VertSelector, options: ArapOptions): OpReport {
    const args = {
      ...options,
      handles: describeHandles(options?.handles),
      pin: describePins(options?.pin),
    };
    return this.runVertices('arap', target, args, (ids, diagnostics) =>
      arap(this.mesh, ids, options, this.solveContext(), diagnostics),
    );
  }

  /**
   * Move the selected vertices onto another surface (garments onto a body, a hair cap
   * onto the scalp, armor onto a limb): `onto` is another session, an FXEM snapshot or
   * faces of this session that the wrapped vertices do not touch. `nearest` (default)
   * takes the closest surface point, `project` the nearest hit along `direction` (or each
   * vertex normal) both ways; `offset` is signed along the surface's interpolated normal.
   * Vertices without a surface point within `maxDistance` stay and are reported; a
   * `falloff` blends nearby unselected vertices.
   */
  shrinkwrap(
    target: FaceSelector | VertSelector,
    options: ShrinkwrapOptions & { readonly onto: Model | Uint8Array | FaceSelector },
  ): OpReport {
    const { onto, ...rest } = options ?? ({} as typeof options);
    const args = { onto: this.describeOperand(onto), ...rest };
    return this.runVertices('shrinkwrap', target, args, (ids, diagnostics) => {
      const surface = this.surfaceOperand(onto);
      if (!surface.ok) return surface;
      return shrinkwrap(this.mesh, ids, surface.value, rest, this.tolerance, diagnostics);
    });
  }

  /**
   * Region offset shell: a copy of the faces `offset` from them along their normals
   * (role `layer`), with a `thickness` grown outward into a wall (roles `inner`, `rim`;
   * `rim: 'open'` leaves the two sheets apart); `conform` wraps the copy to a constant gap
   * over curved regions. The source faces stay; the copies drop their tags and get the
   * placement `tag` and `material`.
   */
  layer(
    faces: FaceSelector,
    options: LayerOptions & {
      readonly label?: string;
      readonly tag?: string;
      readonly material?: string;
    },
  ): OpReport {
    return this.runOn('layer', faces, options, (ids, attribution, diagnostics) => {
      const before = new Set(this.mesh.faces());
      const done = layer(
        this.mesh,
        ids,
        options,
        attribution.label,
        attribution.tag,
        this.tolerance,
        diagnostics,
      );
      if (done.ok && options.material !== undefined) {
        for (const f of this.mesh.faces()) {
          if (!before.has(f)) this.mesh.fMaterial[f] = attribution.material;
        }
      }
      return done;
    });
  }

  private solveContext(): SolveContext {
    return { tolerance: this.tolerance, ...this.computeOptions() };
  }

  // ---- booleans and repair (compute jobs, design 4.1 / 8.1) ------------------------

  /**
   * Add the operand's volume. The operand is another session, an FXEM snapshot, or a
   * selection of closed components of this session (then the rest is the target).
   * With `label`, operand faces get role `cutB`; target faces keep their label and role.
   */
  union(operand: Model | Uint8Array | FaceSelector, options: BooleanOptions = {}): OpReport {
    return this.boolean('union', operand, options);
  }

  /** Remove the operand's volume (role `cutB` as for union). */
  difference(operand: Model | Uint8Array | FaceSelector, options: BooleanOptions = {}): OpReport {
    return this.boolean('difference', operand, options);
  }

  /** Keep only the shared volume (role `cutB` as for union). */
  intersection(operand: Model | Uint8Array | FaceSelector, options: BooleanOptions = {}): OpReport {
    return this.boolean('intersection', operand, options);
  }

  /**
   * Split the target by the operand into two closed pieces: the difference, and the
   * shared volume as a separate shell whose faces get role `piece` when labeled.
   */
  splitBy(operand: Model | Uint8Array | FaceSelector, options: BooleanOptions = {}): OpReport {
    return this.boolean('split', operand, options);
  }

  // ---- voxels, simplification and remeshing (compute jobs voxel / remesh) -------------

  /**
   * QEM simplification of faces (default all) to `targetFaces` triangles or until a
   * collapse would exceed `maxError`. Triangles keep their face's label, role, tags,
   * material and flags; `preserve` keeps boundaries, sharp edges, label and material
   * borders and UV seams as curves (default all true). Hausdorff distance and volume
   * change are in the info diagnostic.
   */
  simplify(faces: FaceSelector | undefined, options: SimplifyOptions): OpReport {
    return this.processOn('simplify', faces, options, (ids, diagnostics) =>
      simplifyFaces(this.mesh, ids, options, this.processContext(), diagnostics),
    );
  }

  /**
   * One low-poly shell from faces (default all): their parts (vertex-connected
   * components) unioned (exact boolean, the voxel hard union when it fails in mode
   * 'auto'), edges above `hardAngle` marked sharp, simplified to `targetFaces` export
   * triangles (a quad counts 2) keeping sharp edges and the silhouette views, triangle
   * pairs merged by cleanup.quads, optionally unwrapped by uv.auto with sharp seams, and
   * each output component tagged `tags.groupPrefix + k`. The info diagnostic carries the
   * verdict (`pass`, `issues`) and the measured facts.
   */
  lowpoly(faces: FaceSelector | undefined, options: LowpolyOptions): OpReport {
    return this.processOn('lowpoly', faces, options, (ids, diagnostics) =>
      lowpolyFaces(
        this.mesh,
        ids,
        options,
        {
          remesh: this.processContext(),
          uv: this.uvContext(),
          boolean: { tolerance: this.tolerance, ...this.computeOptions() },
        },
        diagnostics,
      ),
    );
  }

  /**
   * Isotropic remeshing of faces (default all) toward `targetEdgeLength` (Botsch-Kobbelt
   * split / collapse / valence flip / tangential smoothing, reprojected onto the input),
   * with the same `preserve` constraints as simplify.
   */
  remesh(faces: FaceSelector | undefined, options: RemeshOptions): OpReport {
    return this.processOn('remesh', faces, options, (ids, diagnostics) =>
      remeshFaces(this.mesh, ids, options, this.processContext(), diagnostics),
    );
  }

  /**
   * Voxel operations (compute job `voxel`). Their surfaces are new geometry: faces
   * get the operation's label with role `surface`, and the tags and material slot of
   * their nearest source face; corner values, edge intent and source labels are lost.
   */
  readonly voxel = {
    /** Narrow-band signed distance grid of faces (default all); the mesh is unchanged. */
    fromMesh: (faces: FaceSelector | undefined, options: VoxelizeOptions): SdfGrid => {
      let grid = SdfGrid.empty;
      this.processOn('voxel.fromMesh', faces, options, (ids, diagnostics) => {
        const built = voxelize(this.mesh, ids, options, this.processContext(), diagnostics);
        if (!built.ok) return built;
        grid = built.value;
        return ok({});
      });
      return grid;
    },
    /** Append the iso surface of a grid (Surface Nets), role `surface`. */
    toMesh: (grid: SdfGrid, options: VoxelMeshOptions & Placement = {}): OpReport => {
      const summary = { grid: { dims: grid?.dims, voxelSize: grid?.voxelSize }, ...options };
      return this.run('voxel.toMesh', summary, options, (attribution, diagnostics) =>
        gridToMesh(
          this.mesh,
          grid,
          options,
          attribution,
          options.material !== undefined,
          this.processContext(),
          diagnostics,
        ),
      );
    },
    /** Replace faces (default all) by the smooth union of their parts (blend `radius`, 0 is hard). */
    union: (faces: FaceSelector | undefined, options: VoxelUnionOptions & Placement): OpReport =>
      this.rebuild('voxel.union', 'union', faces, options),
    /** Replace faces (default all) by their offset surface at `distance` (outward > 0). */
    offset: (faces: FaceSelector | undefined, options: VoxelOffsetOptions & Placement): OpReport =>
      this.rebuild('voxel.offset', 'offset', faces, options),
    /** Replace open faces (default all) by the closed voxel surface their winding number bounds. */
    fillHoles: (faces: FaceSelector | undefined, options: VoxelFillOptions & Placement): OpReport =>
      this.rebuild('voxel.fillHoles', 'fill', faces, options),
  };

  private rebuild(
    op: string,
    operation: 'union' | 'offset' | 'fill',
    faces: FaceSelector | undefined,
    options: (VoxelUnionOptions | VoxelOffsetOptions | VoxelFillOptions) & Placement,
  ): OpReport {
    const body = (ids: number[], attribution: Attribution, diagnostics: OpDiagnostic[]) =>
      voxelRebuild(
        this.mesh,
        ids,
        operation,
        options,
        attribution,
        options.material !== undefined,
        this.processContext(),
        diagnostics,
      );
    if (faces === undefined) {
      return this.run(op, options, options, (attribution, diagnostics) =>
        body(this.mesh.faces(), attribution, diagnostics),
      );
    }
    return this.runOn(op, faces, options, body);
  }

  private processOn(
    op: string,
    faces: FaceSelector | undefined,
    options: object,
    body: (ids: number[], diagnostics: OpDiagnostic[]) => Result<RoleCounts, ModelingError>,
  ): OpReport {
    if (faces === undefined) {
      return this.run(op, options, {}, (_attribution, diagnostics) =>
        body(this.mesh.faces(), diagnostics),
      );
    }
    return this.runOn(op, faces, options, (ids, _attribution, diagnostics) =>
      body(ids, diagnostics),
    );
  }

  private processContext(): ProcessContext {
    return { tolerance: this.tolerance, faceBudget: this.faceBudget, ...this.computeOptions() };
  }

  readonly cleanup = {
    /**
     * Merge coplanar adjacent faces with identical attributes into hole-free n-gons and
     * drop collinear vertices (design 8, the boolean's return to face regions).
     */
    planar: (faces?: FaceSelector): OpReport => {
      if (faces === undefined) {
        return this.run('cleanup.planar', {}, {}, () =>
          cleanupPlanar(this.mesh, this.mesh.faces(), this.tolerance),
        );
      }
      return this.runOn('cleanup.planar', faces, {}, (ids) =>
        cleanupPlanar(this.mesh, ids, this.tolerance),
      );
    },
    /**
     * Pair adjacent triangles (default all faces) into quads: an edge without intent
     * (sharp, seam) between triangles of equal attributes and continuous corner values
     * joins when their normals are within `maxAngle` (default 15 degrees), the quad is
     * convex with every corner under 170 degrees, and its diagonals lie within
     * `maxPlanarity` (default 0.02) of the longer diagonal of each other; triangles with
     * the fewest candidates pair first. The info reports the quad area ratio, planarity
     * p99 and valence.
     */
    quads: (faces?: FaceSelector, options: QuadOptions = {}): OpReport => {
      if (faces === undefined) {
        return this.run('cleanup.quads', options, {}, (_attribution, diagnostics) =>
          cleanupQuads(this.mesh, this.mesh.faces(), options, diagnostics),
        );
      }
      return this.runOn('cleanup.quads', faces, options, (ids, _attribution, diagnostics) =>
        cleanupQuads(this.mesh, ids, options, diagnostics),
      );
    },
    /**
     * Collapse sliver faces (default all) narrower than `width` meters: each sliver goes
     * whole or not at all, its short edges merging at the least-squares meet of the
     * planes around them, only where every neighbour stays planar, oriented, simple and
     * manifold, and needles only into a neighbour whose plane holds their apex. Local: no
     * other face is retriangulated. Reports removed and kept slivers; `quiet` turns
     * finding none into an info instead of `model-op-no-effect`.
     */
    slivers: (
      faces: FaceSelector | undefined,
      options: { readonly width: number; readonly quiet?: boolean },
    ): OpReport => {
      const body = (ids: number[], diagnostics: OpDiagnostic[], repair: RepairSink) =>
        cleanupSlivers(this.mesh, ids, options, this.tolerance, diagnostics, repair);
      if (faces === undefined) {
        return this.run('cleanup.slivers', options, {}, (_attribution, diagnostics, repair) =>
          body(this.mesh.faces(), diagnostics, repair),
        );
      }
      return this.runOn(
        'cleanup.slivers',
        faces,
        options,
        (ids, _attribution, diagnostics, repair) => body(ids, diagnostics, repair),
      );
    },
    /**
     * Even out a triangle tiling (default all faces): flips toward
     * Delaunay that raise the smallest angle (caps first) and collapses of the shortest edge
     * of triangles above `maxAspect`, within `maxError` of the input and, with `clearance`,
     * off other surfaces (`TilingOptions`); a remesh job like simplify.
     */
    tiling: (faces: FaceSelector | undefined, options: TilingOptions): OpReport =>
      this.processOn('cleanup.tiling', faces, options, (ids, diagnostics) =>
        cleanupTiling(this.mesh, ids, options, this.processContext(), diagnostics),
      ),
  };

  /** Insert boundary vertices that lie on other boundary edges (default distance: tolerance). */
  resolveTJunctions(options: { readonly distance?: number } = {}): OpReport {
    return this.run('resolveTJunctions', options, {}, (_attribution, _diagnostics, repair) =>
      resolveTJunctions(this.mesh, options.distance ?? this.tolerance, repair),
    );
  }

  /**
   * Stitch two facing boundary edge sequences: vertices are matched by arc length
   * (missing ones are inserted) and merged at their midpoints.
   */
  weldEdgeSequence(edges: EdgeSelector, options: { readonly maxDistance?: number } = {}): OpReport {
    return this.runEdges(
      'weldEdgeSequence',
      edges,
      options,
      (ids, _attribution, _diagnostics, repair) =>
        weldEdgeSequence(this.mesh, ids, options.maxDistance ?? Infinity, repair),
    );
  }

  // ---- intent and attributes ------------------------------------------------------

  tag(faces: FaceSelector, name: string): OpReport {
    return this.runOn('tag', faces, { name }, (ids) => {
      const t = this.mesh.tagIndex(name, true);
      for (const f of ids) this.mesh.addTag(f, t);
      return ok({ tagged: ids.length });
    });
  }

  /** Assign a material slot by name; slot order follows first use. */
  assign(faces: FaceSelector, slot: string): OpReport {
    return this.runOn('assign', faces, { slot }, (ids) => {
      const m = this.mesh.nameIndex(this.mesh.materialNames, slot);
      for (const f of ids) this.mesh.fMaterial[f] = m;
      return ok({ assigned: ids.length });
    });
  }

  markSharp(edges: EdgeSelector, sharp = true): OpReport {
    return this.runEdges('markSharp', edges, { sharp }, (ids, _attribution, diagnostics) =>
      markCrease(this.mesh, ids, sharp ? Infinity : 0, diagnostics),
    );
  }

  /**
   * Set the crease strength of edges for Catmull-Clark `subdivide`, `limit` and `snapToLimit`:
   * a finite value is a half-sharp crease (DeRose: full crease for sharpness - 1 levels, a
   * blend on the last, steps of 1/4 below 10); `Infinity` equals `markSharp`; 0 clears it. The
   * journal records an infinite sharpness as the string `'Infinity'` (JSON has no infinity).
   */
  markCrease(edges: EdgeSelector, sharpness: number): OpReport {
    const recorded = sharpness === Infinity ? 'Infinity' : sharpness;
    return this.runEdges(
      'markCrease',
      edges,
      { sharpness: recorded },
      (ids, _attribution, diagnostics) => markCrease(this.mesh, ids, sharpness, diagnostics),
    );
  }

  markSeam(edges: EdgeSelector, seam = true): OpReport {
    return this.runEdges('markSeam', edges, { seam }, (ids) =>
      markEdges(this.mesh, ids, EDGE_SEAM, seam),
    );
  }

  readonly uv = {
    project: (options: ProjectOptions & { readonly faces?: FaceSelector }): OpReport => {
      const faces = options.faces;
      if (faces === undefined) {
        return this.run('uv.project', options, {}, (_attribution, diagnostics) =>
          projectUv(this.mesh, this.mesh.faces(), options, this.tolerance, diagnostics),
        );
      }
      return this.runOn('uv.project', faces, options, (ids, _attribution, diagnostics) =>
        projectUv(this.mesh, ids, options, this.tolerance, diagnostics),
      );
    },
    /**
     * Unwrap faces (default all) per seam-cut island with LSCM (pins substituted,
     * solved by the solve.sparse compute job) or ExpMap; islands are normalized to
     * their 3D area, oriented and laid out side by side. Metrics (Sander stretch,
     * area distortion, texel density dispersion) are in the info diagnostic.
     */
    unwrap: (options: UnwrapOptions & { readonly faces?: FaceSelector } = {}): OpReport => {
      const args =
        options.seams === undefined ? options : { ...options, seams: describeSeams(options.seams) };
      const body = (ids: number[], diagnostics: OpDiagnostic[]) => {
        const seams = seamSelection(this.mesh, options.seams);
        if (!seams.ok) return seams;
        return unwrapUv(this.mesh, ids, options, seams.value, this.uvContext(), diagnostics);
      };
      const faces = options.faces;
      if (faces === undefined) {
        return this.run('uv.unwrap', args, {}, (_attribution, diagnostics) =>
          body(this.mesh.faces(), diagnostics),
        );
      }
      return this.runOn('uv.unwrap', faces, args, (ids, _attribution, diagnostics) =>
        body(ids, diagnostics),
      );
    },
    /** Pack the UV islands of faces (default all) into one square atlas (skyline, scale search). */
    pack: (options: PackOptions & { readonly faces?: FaceSelector }): OpReport => {
      const faces = options.faces;
      if (faces === undefined) {
        return this.run('uv.pack', options, {}, (_attribution, diagnostics) =>
          packUv(this.mesh, this.mesh.faces(), options, this.uvContext(), diagnostics),
        );
      }
      return this.runOn('uv.pack', faces, options, (ids, _attribution, diagnostics) =>
        packUv(this.mesh, ids, options, this.uvContext(), diagnostics),
      );
    },
    /**
     * Automatic seams, unwrap and pack of faces (default all): uv.chart patches merged
     * under distortion / normal limits, sharp edges as hard boundaries, per-chart
     * unwrap and one atlas. Chart count and metrics are in the info diagnostic.
     */
    auto: (options: AutoUvOptions & { readonly faces?: FaceSelector }): OpReport => {
      const faces = options.faces;
      if (faces === undefined) {
        return this.run('uv.auto', options, {}, (_attribution, diagnostics) =>
          autoUv(this.mesh, this.mesh.faces(), options, this.uvContext(), diagnostics),
        );
      }
      return this.runOn('uv.auto', faces, options, (ids, _attribution, diagnostics) =>
        autoUv(this.mesh, ids, options, this.uvContext(), diagnostics),
      );
    },
    /**
     * Map faces (each connected instance on its own plane frame) into a trim-sheet
     * region: metric, fit or tile per region axis. Instances and texel density
     * against the region are in the info diagnostic.
     */
    trim: (options: TrimUvOptions & { readonly faces: FaceSelector }): OpReport =>
      this.runOn('uv.trim', options.faces, trimArgs(options), (ids, _attribution, diagnostics) =>
        trimUv(this.mesh, ids, options, diagnostics),
      ),
    /** Map every face on its own into a region's interior (U24 swatch UVs). */
    swatch: (options: SwatchUvOptions & { readonly faces: FaceSelector }): OpReport =>
      this.runOn('uv.swatch', options.faces, trimArgs(options), (ids, _attribution, diagnostics) =>
        swatchUv(this.mesh, ids, options, diagnostics),
      ),
  };

  private uvContext(): UvContext {
    return {
      tolerance: this.tolerance,
      policy: this.compute,
      ...(this.native === undefined ? {} : { native: this.native }),
      ...(this.signal === undefined ? {} : { signal: this.signal }),
      ...(this.workBudget === undefined ? {} : { budget: this.workBudget }),
    };
  }

  // ---- queries ---------------------------------------------------------------------

  /** Number of elements the selector matches now; 0 once the session is poisoned. */
  count(selector: FaceSelector | EdgeSelector | VertSelector): number {
    if (this.failure !== undefined) return 0;
    return selector.evaluate(this.mesh).length;
  }

  /**
   * Triangle tiling quality of faces (default all): aspect, smallest angle, interior valence
   * and neighbour size ratio against `limits` (default the R5 faceting thresholds); see
   * `MeshQualityReport`. `validate({ quality })` gates named parts with it. With `flow` it also
   * measures how the triangles' long edges follow the guides (`flowP75`, `flowSkipped`; with a
   * guide's `border`, the border rows apart and `flowBorderShare`).
   */
  meshQuality(
    faces?: FaceSelector,
    limits?: Partial<MeshQualityLimits>,
    options: { readonly flow?: readonly FlowGuide[] } = {},
  ): Result<MeshQualityReport, ModelingError> {
    if (this.failure !== undefined) return err(this.failure);
    const ids = (faces ?? sel.all()).resolve(this.mesh);
    if (!ids.ok) return ids;
    const flow = resolveFlowGuides(this.mesh, options.flow);
    if (!flow.ok) return flow;
    return meshQuality(this.mesh, ids.value, limits, flow.value);
  }

  /**
   * Axis-aligned bounds of the vertices the selector touches. A poisoned session
   * returns its first failure instead of stale numbers; an empty selection is
   * `model-selection-empty`.
   */
  bounds(
    selector: FaceSelector | EdgeSelector | VertSelector,
  ): Result<{ readonly min: Tuple3; readonly max: Tuple3 }, ModelingError> {
    if (this.failure !== undefined) return err(this.failure);
    const ids = selector.resolve(this.mesh);
    if (!ids.ok) return ids;
    const vertices = new Set<number>();
    for (const id of ids.value) {
      if (selector.domain === 'face') for (const v of this.mesh.faceVertices(id)) vertices.add(v);
      else if (selector.domain === 'edge')
        for (const v of this.mesh.edgeVertices(id)) vertices.add(v);
      else vertices.add(id);
    }
    const min: Tuple3 = [Infinity, Infinity, Infinity];
    const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
    for (const v of vertices) {
      const p = this.mesh.position(v);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] as number, p[k] as number);
        max[k] = Math.max(max[k] as number, p[k] as number);
      }
    }
    return ok({ min, max });
  }

  /** Kernel invariants and asset-quality facts; `options` enables thickness and unique-UV checks. */
  validate(options: ValidateOptions = {}): ValidationReport {
    const report = this.validateShellClearance(
      this.validateDrawings(
        this.validateShutLines(
          this.validateLayouts(
            this.validateEdgeFlow(validateMesh(this.mesh, this.tolerance, options), options),
            options,
          ),
          options,
        ),
        options,
      ),
    );
    if (options.surfaceQuality === undefined || options.surfaceQuality === false)
      return this.withCoverage(report, (ledger) => ledger.off('surface-quality', 'not-requested'));
    const quality = checkSurfaceQuality(
      { surfaces: this.surfaces, curves: this.featureLines },
      options.surfaceQuality === true ? {} : options.surfaceQuality,
    );
    const issues: Issue<ValidationCode>[] = quality.ok
      ? quality.value.issues.map((issue) => {
          const owner = (issue.detail.subject as string).split(':')[0] as string;
          const opIndex = this.qualitySources.get(owner);
          const point = qualityPoint(issue, this.surfaces);
          return {
            code: 'surface-quality',
            severity: 'warn',
            detail: {
              check: issue.code,
              ...(point === undefined ? {} : { point }),
              ...(opIndex === undefined ? {} : { opIndex }),
              ...issue.detail,
            },
          };
        })
      : [
          {
            code: 'surface-quality',
            severity: 'error',
            detail: { check: 'options', error: quality.error },
          },
        ];
    return this.withCoverage(
      { ...report, pass: report.pass && quality.ok, issues: [...report.issues, ...issues] },
      (ledger) => {
        const subjects = [...this.surfaces, ...this.featureLines].map((x) => x.name);
        if (quality.ok) ledger.run('surface-quality', subjects.length === 0 ? ['mesh'] : subjects);
        else {
          ledger.enumerated['surface-quality'] = ['mesh'];
          ledger.skip('surface-quality', 'mesh', 'missing-input');
        }
      },
    );
  }

  /** The report with one stage's subjects added to its coverage; the stage fills the ledger. */
  private withCoverage(
    report: ValidationReport,
    fill: (ledger: CoverageLedger) => void,
  ): ValidationReport {
    const ledger = new CoverageLedger();
    fill(ledger);
    const coverage = mergeCoverage(report.coverage, ledger.coverage());
    return { ...report, coverage, pass: report.pass && coverage.checked.length > 0 };
  }

  /**
   * Measure shut lines against a DTS table (gap on the theoretical line, visual gap,
   * flush, parallelism, symmetry; see `measureShutLines`). Does not change the session.
   */
  shutLines(options: ShutLineOptions): Result<ShutLineReport, ModelingError> {
    return measureShutLines(this.mesh, options, this.drawings);
  }

  /**
   * Append `shut-line` issues for a DTS table when requested: errors for failing and
   * unmeasured rows, warnings for excepted rows and for exception limits whose check passes.
   */
  private validateShutLines(report: ValidationReport, options: ValidateOptions): ValidationReport {
    if (options.shutLines === undefined)
      return this.withCoverage(report, (ledger) => ledger.off('shut-line', 'not-requested'));
    const measured = measureShutLines(this.mesh, options.shutLines, this.drawings);
    const issues: Issue<ValidationCode>[] = measured.ok
      ? measured.value.rows.flatMap((r): Issue<ValidationCode>[] => {
          const out: Issue<ValidationCode>[] = [];
          if (r.status === 'fail' || r.status === 'unmeasured')
            out.push({ code: 'shut-line', severity: 'error', detail: { ...r } });
          if (r.status === 'excepted')
            out.push({ code: 'shut-line', severity: 'warn', detail: { check: 'excepted', ...r } });
          const unused =
            r.exception === undefined || r.status === 'unmeasured'
              ? []
              : shutLineChecks(r.exception.limits).filter(
                  (c) => !r.excepted.includes(c) && !r.failures.includes(c),
                );
          if (unused.length > 0)
            out.push({
              code: 'shut-line',
              severity: 'warn',
              detail: { check: 'exception-unused', id: r.id, unused, exception: r.exception },
            });
          return out;
        })
      : [
          {
            code: 'shut-line',
            severity: 'error',
            detail: { check: 'options', error: measured.error },
          },
        ];
    const rows = options.shutLines.table.map((r) => r.id);
    return this.withCoverage(
      {
        ...report,
        pass: report.pass && measured.ok && measured.value.pass,
        issues: [...report.issues, ...issues],
      },
      (ledger) => {
        ledger.enumerated['shut-line'] = rows;
        if (!measured.ok) {
          for (const id of rows) ledger.skip('shut-line', id, 'missing-input');
          return;
        }
        const done = new Set<string>();
        for (const r of measured.value.rows) {
          if (r.status === 'unmeasured') ledger.skip('shut-line', r.id, 'missing-input');
          else done.add(r.id);
        }
        ledger.evaluated['shut-line'] = done;
      },
    );
  }

  /** Append `drawing` issues (`detail.check`: the drawing check) when requested. */
  private validateDrawings(report: ValidationReport, options: ValidateOptions): ValidationReport {
    if (options.drawing === undefined || options.drawing === false)
      return this.withCoverage(report, (ledger) => ledger.off('drawing', 'not-requested'));
    const findings = checkDrawings(
      this.mesh,
      this.tolerance,
      this.drawings,
      this.featureLines,
      options.drawing === true ? {} : options.drawing,
    );
    const issues: Issue<ValidationCode>[] = findings.map((f) => ({
      code: 'drawing',
      severity: 'warn',
      detail: { ...f },
    }));
    return this.withCoverage({ ...report, issues: [...report.issues, ...issues] }, (ledger) =>
      this.declared(
        ledger,
        'drawing',
        this.drawings.map((d) => d.name),
      ),
    );
  }

  /** The declared subjects of a requested check, all evaluated; none declared is a missing input. */
  private declared(ledger: CoverageLedger, code: ValidationCode, names: readonly string[]): void {
    if (names.length > 0) ledger.run(code, names);
    else {
      ledger.enumerated[code] = ['mesh'];
      ledger.skip(code, 'mesh', 'missing-input');
    }
  }

  /**
   * Append a `thin-wall` issue (`detail.check: 'shell-clearance'`) for every shell in the
   * journal whose walls came within a third of the thickness of another part's, relieved or
   * not: the shell's own thickness warning, so a gate can fail on it.
   */
  private validateShellClearance(report: ValidationReport): ValidationReport {
    const issues: Issue<ValidationCode>[] = this.entries.flatMap((entry) =>
      (entry.diagnostics ?? []).flatMap((d) =>
        d.detail?.nearWalls === undefined
          ? []
          : [
              {
                code: 'thin-wall' as const,
                severity: 'warn' as const,
                detail: {
                  check: 'shell-clearance',
                  opIndex: entry.opIndex,
                  thickness: d.detail.thickness,
                  clearance: d.detail.clearance,
                  relieved: d.detail.relieved,
                  count: d.detail.nearCount,
                  walls: d.detail.nearWalls,
                  point: d.detail.point,
                },
              },
            ],
      ),
    );
    const shells = this.entries
      .filter((entry) => entry.op === 'shell' && entry.status === 'ok')
      .map((entry) => `op${entry.opIndex}`);
    return this.withCoverage(
      issues.length === 0 ? report : { ...report, issues: [...report.issues, ...issues] },
      (ledger) => {
        if (shells.length > 0) ledger.run('thin-wall', shells);
      },
    );
  }

  /** Append `patch-layout` issues (`detail.check`: the layout check) when requested. */
  private validateLayouts(report: ValidationReport, options: ValidateOptions): ValidationReport {
    if (options.layout === undefined || options.layout === false)
      return this.withCoverage(report, (ledger) => ledger.off('patch-layout', 'not-requested'));
    const layoutOptions = options.layout === true ? {} : options.layout;
    const issues: Issue<ValidationCode>[] = this.layouts.flatMap((l) =>
      checkLayout(l.resolved, this.featureLines, layoutOptions, {
        ...(l.built === undefined ? {} : { built: l.built }),
        ...(l.corners === undefined ? {} : { corners: l.corners }),
        ...(l.fits === undefined ? {} : { fits: l.fits }),
      }).map((issue) => ({
        code: 'patch-layout' as const,
        severity: 'warn' as const,
        detail: {
          check: issue.code,
          layout: l.resolved.name,
          opIndex: l.opIndex,
          ...issue.detail,
        },
      })),
    );
    return this.withCoverage({ ...report, issues: [...report.issues, ...issues] }, (ledger) =>
      this.declared(
        ledger,
        'patch-layout',
        this.layouts.map((l) => l.resolved.name),
      ),
    );
  }

  /** Append `edge-flow` issues (`detail.check`: the edge-flow code) when requested. */
  private validateEdgeFlow(report: ValidationReport, options: ValidateOptions): ValidationReport {
    if (options.edgeFlow === undefined || options.edgeFlow === false)
      return this.withCoverage(report, (ledger) => ledger.off('edge-flow', 'not-requested'));
    const flow = checkEdgeFlow(
      this.mesh,
      this.featureLines,
      options.edgeFlow === true ? {} : options.edgeFlow,
    );
    const issues: Issue<ValidationCode>[] = flow.ok
      ? flow.value.issues.map((issue) => ({
          code: 'edge-flow',
          severity: issue.severity,
          detail: {
            check: issue.code,
            ...issue.detail,
            ...(issue.code === 'feature-loop'
              ? { opIndex: this.qualitySources.get(issue.detail.line as string) }
              : {}),
          },
        }))
      : [{ code: 'edge-flow', severity: 'error', detail: { check: 'options', error: flow.error } }];
    return this.withCoverage(
      { ...report, pass: report.pass && flow.ok, issues: [...report.issues, ...issues] },
      (ledger) => {
        const lines = this.featureLines.map((l) => l.name);
        const subjects = ['mesh', ...lines];
        if (flow.ok) ledger.run('edge-flow', subjects);
        else {
          ledger.enumerated['edge-flow'] = subjects;
          for (const subject of subjects) ledger.skip('edge-flow', subject, 'missing-input');
        }
      },
    );
  }

  inspect(): ModelInspection {
    const labels = this.mesh.labelNames.slice(1).map((label) => ({
      label,
      roles: {} as Record<string, number>,
    }));
    if (labels.length > 0) {
      for (const f of this.mesh.faces()) {
        const label = labels[(this.mesh.fLabel[f] as number) - 1];
        if (label === undefined) continue;
        const role = this.mesh.roleNames[this.mesh.fRole[f] as number] ?? '';
        label.roles[role] = (label.roles[role] ?? 0) + 1;
      }
    }
    return {
      faces: this.mesh.faceCount,
      edges: this.mesh.edgeCount,
      vertices: this.mesh.vertexCount,
      tags: [...this.mesh.tagNames],
      labels,
      materials: [...this.mesh.materialNames],
      ...(this.output === undefined ? {} : { output: this.output }),
      ...(this.failure === undefined ? {} : { poisoned: this.failure }),
      journal: this.entries,
    };
  }

  /** Canonical FXEM bytes of the current mesh. */
  /**
   * Canonical FXEM bytes of the current mesh. A poisoned session's bytes are its partial
   * state: used as an operand (append, array, booleans, shrinkwrap), they fail with the
   * session's first failure instead of adding partial geometry.
   */
  snapshot(): Uint8Array {
    const bytes = encodeSnapshot(this.mesh);
    if (this.failure !== undefined) notePoisonedSnapshot(bytes, this.failure);
    return bytes;
  }

  /**
   * Run `body` and roll the mesh back when it fails. Costs one full copy of the
   * mesh; use it only where a failure should choose another construction path.
   * Cancellation and an exceeded budget end the build instead (design 7.2): they
   * stay poisoned, with no rollback.
   */
  try(body: (model: Model) => void): Result<void, ModelingError> {
    if (this.failure !== undefined) return err(this.failure);
    const saved = this.captureState();
    let thrown: ModelingError | undefined;
    try {
      body(this);
    } catch (cause) {
      if (cause instanceof InvariantError) throw cause;
      thrown = internalError({ op: 'try', opIndex: this.entries.length }, cause);
    }
    const cause = thrown ?? this.poisoned;
    if (cause === undefined) return ok(undefined);
    if (
      thrown === undefined &&
      (cause.code === 'model-cancelled' || cause.code === 'model-work-budget')
    )
      return err(cause);
    this.restoreState(saved);
    return err(cause);
  }

  /** Everything an operation can change, for rollback by `try()` and the operation boundary. */
  private captureState(): SessionState {
    return {
      mesh: this.mesh.clone(),
      generations: this.generations,
      failure: this.failure,
      entries: this.entries.length,
      checkpoints: this.checkpoints.length,
      steps: this.steps.length,
      stepBytes: this.stepBytes,
      drawings: [...this.drawings],
      contours: [...this.contours],
      surfaces: [...this.surfaces],
      featureLines: [...this.featureLines],
      qualitySources: new Map(this.qualitySources),
      layouts: this.layouts.map((layout) => ({ layout, fields: { ...layout } })),
      provenance: this.provenance,
      output: this.output,
    };
  }

  private restoreState(state: SessionState): void {
    this.mesh.assign(state.mesh);
    this.generations = state.generations;
    this.failure = state.failure;
    this.entries.splice(state.entries);
    this.checkpoints.splice(state.checkpoints);
    this.steps.splice(state.steps);
    this.stepBytes = state.stepBytes;
    replaceAll(this.drawings, state.drawings);
    replaceAll(this.contours, state.contours);
    replaceAll(this.surfaces, state.surfaces);
    replaceAll(this.featureLines, state.featureLines);
    this.qualitySources.clear();
    for (const [key, value] of state.qualitySources) this.qualitySources.set(key, value);
    this.layouts.length = 0;
    for (const { layout, fields } of state.layouts) {
      delete layout.built;
      delete layout.corners;
      delete layout.fits;
      Object.assign(layout, fields);
      this.layouts.push(layout);
    }
    this.provenance = state.provenance;
    this.output = state.output;
  }

  // ---- output -----------------------------------------------------------------------

  /** Export the compacted mesh with its report. */
  toMesh(
    options: ExportOptions = {},
  ): Result<{ readonly mesh: MeshAsset; readonly report: ExportReport }, ModelingError> {
    if (this.failure !== undefined) return err(this.failure);
    const { mesh: compacted, faceMap } = this.mesh.compact();
    const exported = exportMesh(
      compacted,
      options.normals?.mode === 'surface' ? { ...options, surfaces: this.surfaces } : options,
    );
    if (!exported.ok) {
      // Report the session's face id, as operations do, not the compacted one.
      const face = exported.error.detail?.face;
      const session = typeof face === 'number' ? faceMap.indexOf(face) : -1;
      if (session < 0) return exported;
      const cause = exported.error;
      return err(
        modelingError(cause.code, cause.expected, { ...cause.detail, face: session }, cause.hint),
      );
    }
    if (this.captured) {
      this.provenance = {
        vertexCorner: exported.value.vertexCorner,
        triangleFace: exported.value.triangleFace,
      };
    }
    return ok({ mesh: exported.value.mesh, report: exported.value.report });
  }

  /** Pack build output: `{ 'mesh/<key>': MeshAsset }`. */
  finish(options: FinishOptions): Result<Readonly<Record<string, MeshAsset>>, ModelingError> {
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(options.key)) {
      return err(
        modelingError('model-invalid-argument', 'key is a lowercase source key segment', {
          key: options.key,
        }),
      );
    }
    const exported = this.toMesh(options);
    if (!exported.ok) {
      const cause = exported.error;
      if (cause === this.failure) return exported;
      return err(
        modelingError(
          cause.code,
          cause.expected,
          { output: `mesh/${options.key}`, ...cause.detail },
          cause.hint,
        ),
      );
    }
    this.output = `mesh/${options.key}`;
    return ok({ [this.output]: exported.value.mesh });
  }

  // ---- internals ----------------------------------------------------------------------

  private operand(part: Model | Uint8Array): Result<EditMesh, ModelingError> {
    if (part === this) {
      return err(modelingError('model-invalid-argument', 'the operand is another session', {}));
    }
    if (part instanceof Model) {
      if (part.poisoned !== undefined) {
        return err(
          modelingError(
            'model-precondition',
            'the operand session is not poisoned',
            { cause: part.poisoned.code },
            'fix the operand session first; its first failure is in detail.cause',
          ),
        );
      }
      return ok(part.editMesh);
    }
    return decodeOperand(part);
  }

  private describeOperand(operand: Model | Uint8Array | FaceSelector | undefined): unknown {
    return operand instanceof Selector
      ? { selector: operand.description }
      : operand instanceof Model
        ? 'session'
        : operand instanceof Uint8Array
          ? `fxem(${operand.length} bytes)`
          : operand;
  }

  /** A surface operand: another session, an FXEM snapshot, or faces of this session. */
  private surfaceOperand(
    operand: Model | Uint8Array | FaceSelector | undefined,
  ): Result<{ readonly mesh: EditMesh; readonly faces: readonly number[] }, ModelingError> {
    if (operand instanceof Selector) {
      if (operand.domain !== 'face') {
        return err(
          modelingError(
            'model-invalid-argument',
            'onto is a session, an FXEM snapshot or a face selector',
            {
              onto: operand.description,
            },
          ),
        );
      }
      const ids = (operand as FaceSelector).resolve(this.mesh);
      if (!ids.ok) return ids;
      return ok({ mesh: this.mesh, faces: ids.value });
    }
    if (!(operand instanceof Model) && !(operand instanceof Uint8Array)) {
      return err(
        modelingError(
          'model-invalid-argument',
          'onto is a session, an FXEM snapshot or a face selector',
          {
            onto: operand,
          },
        ),
      );
    }
    const source = this.operand(operand);
    if (!source.ok) return source;
    return ok({ mesh: source.value, faces: source.value.faces() });
  }

  private boolean(
    operation: BooleanOperation,
    operand: Model | Uint8Array | FaceSelector,
    options: BooleanOptions,
  ): OpReport {
    const op = operation === 'split' ? 'splitBy' : operation;
    const described =
      operand instanceof Selector
        ? { selector: operand.description }
        : operand instanceof Model
          ? { operand: 'session' }
          : { operand: `fxem(${operand.length} bytes)` };
    return this.run(op, { ...described, ...options }, options, (attribution, diagnostics) => {
      let target: { readonly mesh: EditMesh } | { readonly faces: readonly number[] };
      if (operand instanceof Selector) {
        const ids = (operand as FaceSelector).resolve(this.mesh);
        if (!ids.ok) return ids;
        target = { faces: ids.value };
      } else if (operand instanceof Model) {
        if (operand === this) {
          return err(
            modelingError(
              'model-invalid-argument',
              'the operand is another session, an FXEM snapshot or a selection',
              {},
            ),
          );
        }
        if (operand.poisoned !== undefined) {
          return err(
            modelingError(
              'model-precondition',
              'the operand session is not poisoned',
              { cause: operand.poisoned.code },
              'fix the operand session first; its first failure is in detail.cause',
            ),
          );
        }
        target = { mesh: operand.editMesh };
      } else {
        const decoded = decodeOperand(operand);
        if (!decoded.ok) return decoded;
        target = { mesh: decoded.value };
      }
      return booleanOp(
        this.mesh,
        operation,
        target,
        options,
        attribution,
        { tolerance: this.tolerance, ...this.computeOptions() },
        diagnostics,
      );
    });
  }

  /** @internal Policy, native backend, signal and budget of this session's compute jobs. */
  get computeContext(): ComputeOptions & { readonly policy: ComputePolicy } {
    return this.computeOptions();
  }

  private computeOptions(): ComputeOptions & { readonly policy: ComputePolicy } {
    return {
      policy: this.compute,
      ...(this.native === undefined ? {} : { native: this.native }),
      ...(this.signal === undefined ? {} : { signal: this.signal }),
      ...(this.workBudget === undefined ? {} : { budget: this.workBudget }),
    };
  }

  private verticesOf(faces: readonly number[]): number[] {
    const set = new Set<number>();
    for (const f of faces) for (const v of this.mesh.faceVertices(f)) set.add(v);
    return [...set].sort((a, b) => a - b);
  }

  private attribution(placement: Placement): Attribution {
    return {
      label:
        placement.label === undefined
          ? 0
          : this.mesh.nameIndex(this.mesh.labelNames, placement.label),
      material:
        placement.material === undefined
          ? 0
          : this.mesh.nameIndex(this.mesh.materialNames, placement.material),
      tag: placement.tag === undefined ? -1 : this.mesh.tagIndex(placement.tag, true),
    };
  }

  private runOn(
    op: string,
    faces: FaceSelector,
    args: object,
    body: (
      ids: number[],
      attribution: Attribution,
      diagnostics: OpDiagnostic[],
      repair: RepairSink,
    ) => Result<RoleCounts, ModelingError>,
  ): OpReport {
    return this.run(
      op,
      { selector: faces.description, ...args },
      args as Placement,
      (attribution, diagnostics, repair) => {
        const ids = faces.resolve(this.mesh);
        if (!ids.ok) return ids;
        return body(ids.value, attribution, diagnostics, repair);
      },
    );
  }

  private runEdges(
    op: string,
    edges: EdgeSelector,
    args: object,
    body: (
      ids: number[],
      attribution: Attribution,
      diagnostics: OpDiagnostic[],
      repair: RepairSink,
    ) => Result<RoleCounts, ModelingError>,
  ): OpReport {
    return this.run(
      op,
      { selector: edges.description, ...args },
      args as Placement,
      (attribution, diagnostics, repair) => {
        const ids = edges.resolve(this.mesh);
        if (!ids.ok) return ids;
        return body(ids.value, attribution, diagnostics, repair);
      },
    );
  }

  private runVertices(
    op: string,
    target: FaceSelector | VertSelector,
    args: object,
    body: (ids: number[], diagnostics: OpDiagnostic[]) => Result<RoleCounts, ModelingError>,
  ): OpReport {
    return this.run(
      op,
      { selector: target.description, ...args },
      {},
      (_attribution, diagnostics) => {
        const ids = (target as Selector<'face' | 'vert'>).resolve(this.mesh);
        if (!ids.ok) return ids;
        return body(target.domain === 'vert' ? ids.value : this.verticesOf(ids.value), diagnostics);
      },
    );
  }

  private run(
    op: string,
    args: unknown,
    placement: Placement,
    body: (
      attribution: Attribution,
      diagnostics: OpDiagnostic[],
      repair: RepairSink,
    ) => Result<RoleCounts, ModelingError>,
  ): OpReport {
    const opIndex = this.entries.length;
    const label = placement.label;
    const before = this.mesh.topologyStamp;
    const started = now();
    const base = { op, opIndex, ...(label === undefined ? {} : { label }) };
    if (this.failure !== undefined) {
      return this.record(base, args, 'skipped', {}, before, started);
    }
    if (this.signal?.aborted === true) {
      const failure = modelingError('model-cancelled', 'the build is not cancelled', {
        site: base,
      });
      this.failure = failure;
      return this.record(base, args, 'failed', {}, before, started, failure);
    }
    const diagnostics: OpDiagnostic[] = [];
    let repair: RepairReport | undefined;
    const log: SelectorLog = { uses: [], truncated: false };
    this.selectorLog = log;
    const saved = this.captureState();
    let outcome: Result<RoleCounts, ModelingError>;
    try {
      outcome = recordSelectors(log, () =>
        body(this.attribution(placement), diagnostics, (report) => {
          repair = report;
        }),
      );
    } catch (cause) {
      if (cause instanceof InvariantError) throw cause;
      outcome = err(internalError(base, cause));
    }
    if (!outcome.ok && outcome.error.code === 'model-internal') this.restoreState(saved);
    if (!outcome.ok) {
      const cause = outcome.error;
      const failure = modelingError(
        cause.code,
        cause.expected,
        { ...cause.detail, site: base },
        cause.hint,
      );
      this.failure = failure;
      return this.record(base, args, 'failed', {}, before, started, failure, diagnostics);
    }
    const roles = outcome.value;
    if (this.mesh.faceCount > this.faceBudget) {
      const failure = modelingError(
        'model-work-budget',
        `the mesh stays within ${this.faceBudget} faces`,
        {
          site: base,
          faces: this.mesh.faceCount,
        },
      );
      this.failure = failure;
      return this.record(base, args, 'failed', roles, before, started, failure, diagnostics);
    }
    if (PRODUCING_OPS.has(op)) {
      const produced = Object.values(roles).reduce((sum, n) => sum + n, 0);
      if (produced === 0) {
        const failure = modelingError('model-op-no-effect', `${op} produces at least one face`, {
          site: base,
        });
        this.failure = failure;
        return this.record(base, args, 'failed', roles, before, started, failure, diagnostics);
      }
    }
    return this.record(base, args, 'ok', roles, before, started, undefined, diagnostics, repair);
  }

  private assertInvariants(op: string): void {
    const violations = debugValidate(this.mesh, this.generations);
    if (violations.length > 0) throw new InvariantError(op, violations);
    this.generations = generationsOf(this.mesh);
  }

  private record(
    base: { op: string; opIndex: number; label?: string },
    args: unknown,
    status: OpStatus,
    roles: RoleCounts,
    before: number,
    started: number,
    error?: ModelingError,
    diagnostics: readonly OpDiagnostic[] = [],
    repair?: RepairReport,
  ): OpReport {
    const log = this.selectorLog;
    this.selectorLog = undefined;
    if (status === 'ok' && invariantChecksEnabled()) this.assertInvariants(base.op);
    const report: OpReport = {
      ...base,
      status,
      roles,
      faces: this.mesh.faceCount,
      vertices: this.mesh.vertexCount,
      ...(error === undefined ? {} : { error }),
      ...(diagnostics.length === 0 ? {} : { diagnostics }),
      ...(repair === undefined ? {} : { repair }),
    };
    const source = this.captured ? authorSite() : undefined;
    if (status === 'ok' && this.capture?.steps === true && this.stepBytes <= MAX_STEP_BYTES) {
      const snapshot = encodeSnapshot(this.mesh);
      this.stepBytes += snapshot.byteLength;
      if (this.stepBytes <= MAX_STEP_BYTES) this.steps.push({ opIndex: base.opIndex, snapshot });
    }
    this.entries.push({
      ...report,
      args,
      topologyStamp: [before, this.mesh.topologyStamp],
      durationMs: now() - started,
      ...(source === undefined ? {} : { source }),
      ...(log === undefined || log.uses.length === 0 ? {} : { selectors: log.uses }),
      ...(log?.truncated === true ? { selectorsTruncated: true as const } : {}),
    });
    return report;
  }
}

/** A declared patch layout, with its matched patches once `surface({ layout })` built them. */
interface DeclaredLayout {
  resolved: ResolvedLayout;
  opIndex: number;
  built?: Map<string, NurbsSurface>;
  /** Quads of the layout's setback corners, by corner name. */
  corners?: Map<string, NurbsSurface[]>;
  fits?: Map<string, LayoutFit>;
}

interface SessionState {
  readonly mesh: EditMesh;
  readonly generations: Generations | undefined;
  readonly failure: ModelingError | undefined;
  readonly entries: number;
  readonly checkpoints: number;
  readonly steps: number;
  readonly stepBytes: number;
  readonly drawings: ResolvedDrawing[];
  readonly contours: Contour[];
  readonly surfaces: NamedSurface[];
  readonly featureLines: FeatureLine[];
  readonly qualitySources: Map<string, number>;
  readonly layouts: { readonly layout: DeclaredLayout; readonly fields: DeclaredLayout }[];
  readonly provenance: ModelDiagnostics['provenance'];
  readonly output: string | undefined;
}

/** A thrown value that is not an InvariantError becomes a structured kernel-defect failure. */
function internalError(site: ModelingSite, cause: unknown): ModelingError {
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

/** Start a modeling session. */
/** A drawing's closed curve item in an ortho view, resolved as a contour. */
function contourItem(d: Drawing, id: string): Result<Contour, ModelingError> {
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

export function model(options: ModelOptions = {}): Model {
  return new Model(options);
}
