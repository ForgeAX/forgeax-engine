import { err, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import { getModelingKernelWasm } from '@forgeax/modeling-kernel';
import { type ArrayOptions, arrayCopies } from './array';
import { maxOf, replaceAll } from './arrays';
import { type BevelOptions, bevel, resolveWidths } from './bevel';
import { resolveBlends } from './blend';
import { type BooleanOptions, booleanOp } from './boolean';
import type * as exact from './brep';
import {
  authorSite,
  type CaptureOptions,
  MAX_CHECKPOINTS,
  MAX_STEP_BYTES,
  registerCapturedSession,
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
import { type ApplyDraftOptions, applyDraft } from './draft';
import { type Contour, type Drawing, type ResolvedDrawing, resolveDrawing } from './drawing';
import { ModelingError, modelingError } from './errors';
import {
  type ExportOptions,
  type ExportReport,
  type ExportSidecar,
  exportMesh,
  MIRROR_SUFFIX,
  type NormalMode,
} from './finish';
import { encodeSnapshot, notePoisonedSnapshot } from './fxem';
import { type Axis, axisIndex, type Tuple3 } from './geom';
import { type HoleCutOptions, hole } from './hole';
import {
  debugValidate,
  type Generations,
  generationsOf,
  invariantChecksEnabled,
} from './invariants';
import { type KnifeOptions, knife } from './knife';
import { type LayerOptions, layer } from './layer';
import { buildLayout, layoutPatches, type PatchLayoutSpec, resolveLayout } from './layout';
import { lift } from './lift';
import { type LowpolyOptions, lowpolyFaces } from './lowpoly';
import {
  type CornerChannelName,
  EDGE_SEAM,
  EDGE_SHARP,
  EditMesh,
  FACE_FLOAT,
  PART_ROLES,
  type PartRole,
  partRole,
  setPartRole,
} from './mesh';
import {
  type MeshQualityLimits,
  type MeshQualityReport,
  meshQuality,
  resolveFlowGuides,
} from './mesh-quality';
import { type EditMeshStore, type KernelPolicy, TsEditMeshStore } from './mesh-store';
import {
  createEditMeshStore,
  kernelErrorToModelingError,
  type RustEditMeshStore,
  syncRustToTs,
  syncTsToRust,
} from './mesh-store-rust';
import {
  type Checkpoint,
  checkedStage,
  contourItem,
  decodeOperand,
  type ExactStage,
  type ExtrudeContourOptions,
  type FinishOptions,
  InvariantError,
  internalError,
  type JournalEntry,
  type ModelDiagnostics,
  type ModelInspection,
  type ModelOptions,
  noExactStage,
  type OpReport,
  type OpStatus,
  PRODUCING_OPS,
  type SmoothOperation,
  type StepSnapshot,
  shapeSize,
  type ThreeViewOptions,
} from './model-helpers';
import {
  type RustPeerMesh,
  resolveRustMipPadding,
  rustAppend,
  rustArray,
  rustBevel,
  rustBoolean,
  rustBox,
  rustCylinder,
  rustExtrude,
  rustFillHoles,
  rustInset,
  rustMarkEdges,
  rustOffset,
  rustPanelLine,
  rustPlane,
  rustRevolve,
  rustSphere,
  rustSubdivide,
  rustSweep,
  rustTaper,
  rustTorus,
} from './model-rust';
import {
  rustApplyDraft,
  rustArap,
  rustBend,
  rustBridge,
  rustCleanupPlanar,
  rustCleanupQuads,
  rustCleanupSlivers,
  rustCleanupTiling,
  rustCone,
  rustCurveDeform,
  rustDisconnect,
  rustDissolve,
  rustDuplicate,
  rustExtrudePolygon,
  rustHole,
  rustImplicitSmooth,
  rustLattice,
  rustLift,
  rustLoft,
  rustLoopCut,
  rustLowpoly,
  rustMarkCrease,
  rustMarkFloat,
  rustMarkRole,
  rustOrient,
  rustPipeNetwork,
  rustPlaneCut,
  rustPolygon,
  rustRemesh,
  rustResolveTJunctions,
  rustShell,
  rustShrinkwrap,
  rustSimplify,
  rustSmooth,
  rustSpherize,
  rustSplit,
  rustTriangulate,
  rustTwist,
  rustVoxelRemesh,
  rustWeld,
  triangulateEditMeshFaces,
  triangulateRustStoreFaces,
} from './model-rust-ext';
import { createModelUvOps } from './model-uv-ops';
import {
  type DeclaredLayout,
  finishSurfaceQualityValidation,
  type ValidationInputs,
  validateDrawings,
  validateEdgeFlow,
  validateLayouts,
  validateShellClearance,
  validateShutLines,
} from './model-validation';

export {
  type Checkpoint,
  type ExactStage,
  type ExtrudeContourOptions,
  type FinishOptions,
  InvariantError,
  type JournalEntry,
  type ModelDiagnostics,
  type ModelInspection,
  type ModelOptions,
  type OpReport,
  type OpStatus,
  type SmoothOperation,
  type StepSnapshot,
  type ThreeViewOptions,
} from './model-helpers';

import { checkCurve, type NurbsSurface } from './nurbs';
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
  type RegionMode,
  type RepairReport,
  type RepairSink,
  type RoleCounts,
  transformVertices,
  weld,
} from './ops';
import { type PanelLineOptions, panelLine } from './panel';
import { assignBakeGroups, type BakeGroupsOptions } from './part-groups';
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
import {
  measureSeamVisibility,
  type SeamVisibilityOptions,
  type SeamVisibilityReport,
} from './seam-visibility';
import {
  type EdgeSelector,
  type FaceSelector,
  recordSelectors,
  Selector,
  type SelectorLog,
  sel,
  type VertSelector,
} from './selectors';
import { appendSheet, type SheetMetalSpec } from './sheet';
import { type ShellFlange, type ShellOptions, shell } from './shell';
import { type ShrinkwrapOptions, shrinkwrap } from './shrinkwrap';
import { measureShutLines, type ShutLineOptions, type ShutLineReport } from './shut-lines';
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
  type FeatureLine,
  inflectionRanges,
  type NamedSurface,
  type SurfaceSeam,
} from './surface-quality';
import { type LoftOptions, loft, type SweepOptions, sweep } from './sweep';
import type { UvContext } from './uv';
import { type Carrier, carrierOverwriteNote, moveDomainToCarrier } from './uv-channel';
import {
  poisonedReport,
  STRICT_QUALITY_CODES,
  type ValidateOptions,
  type ValidationReport,
  validateMesh,
} from './validate';
import { fromView, ORTHO_VIEWS } from './views';
import { auditVisibility, type VisibilityAudit, type VisibilityOptions } from './visibility-audit';
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

interface Placement {
  readonly label?: string;
  readonly tag?: string;
  readonly material?: string;
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
  private exactStage: ExactStage | undefined;
  readonly backendPolicy: KernelPolicy;
  readonly opBackends: Readonly<Record<string, 'rust' | 'ts'>>;
  private readonly rollbackOnInternal: boolean | undefined;
  private mesh = new EditMesh();
  private readonly meshStore: TsEditMeshStore = new TsEditMeshStore(this.mesh);
  private rustStore: RustEditMeshStore | undefined;
  private authority: 'ts' | 'rust' = 'ts';
  private failure: ModelingError | undefined;
  private readonly entries: JournalEntry[] = [];
  private readonly capture: CaptureOptions | undefined;
  private readonly checkpoints: Checkpoint[] = [];
  private readonly steps: StepSnapshot[] = [];
  private stepBytes = 0;
  private readonly drawings: ResolvedDrawing[] = [];
  private readonly contours: Contour[] = [];
  private readonly surfaces: NamedSurface[] = [];
  /** Corner channel holding the patch domain `m.surface` writes (BK56); moves with `uv.lightmap`. */
  private domainChannel: CornerChannelName = 'uv1';
  /**
   * The session holds patch-domain data it did not record itself: a join adopted a carrier from
   * a patched operand. Together with its own surfaces it makes the session patch-holding, so the
   * next join compares carriers instead of adopting again, whether the session is the host or
   * the operand of that join. Rolled back with the session state.
   */
  private adoptedCarrier = false;
  /**
   * Names of the patches adopted from operand sessions (their recorded surfaces and, nested,
   * their own adopted names); the uv guards read them with `surfaces`. A snapshot records no
   * patch names, so a carrier adopted from a snapshot protects nothing. Rolled back like the flag.
   */
  private adoptedPatches: string[] = [];
  private readonly featureLines: FeatureLine[] = [];
  private readonly shapes = new Map<string, exact.Shape>();
  /** Operation index that declared each surface and feature line, for located reports. */
  private readonly qualitySources = new Map<string, number>();
  /** Declared patch layouts, with their matched patches once `surface({ layout })` built them. */
  private readonly layouts: DeclaredLayout[] = [];
  private provenance: ModelDiagnostics['provenance'];
  private output: string | undefined;
  private exportedNormals: NormalMode | undefined;
  private selectorLog: SelectorLog | undefined;
  private generations: Generations | undefined;

  constructor(options: ModelOptions = {}) {
    this.tolerance = options.tolerance ?? 1e-5;
    this.signal = options.signal;
    this.faceBudget = options.budget?.faces ?? Infinity;
    this.workBudget = options.budget?.work;
    this.compute = options.compute ?? 'auto';
    this.native = options.native;
    if (options.exact !== undefined || 'exact' in options) {
      const checked = checkedStage(options.exact);
      if (checked instanceof ModelingError) this.failure = checked;
      else this.exactStage = checked;
    }
    this.backendPolicy = options.backend ?? 'auto';
    this.opBackends = options.opBackends ?? {};
    this.rollbackOnInternal = options.rollbackOnInternal;
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
    this.ensureTsAuthority();
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

  /**
   * What an analytic bake (BK63) reads from this session: the recorded patches with their
   * tessellation criteria (a detail) and the corner channel holding the patch domain (a base).
   */
  analyticSource(): {
    readonly surfaces: readonly NamedSurface[];
    readonly domain: CornerChannelName;
  } {
    return { surfaces: [...this.surfaces], domain: this.domainChannel };
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
    this.ensureTsAuthority();
    return this.mesh;
  }

  /** Zero-copy storage view over the session's active editable mesh. */
  get store(): EditMeshStore {
    return this.authority === 'rust' && this.rustStore !== undefined
      ? this.rustStore
      : this.meshStore;
  }

  /** Release any retained Rust/WASM EditMesh handles owned by this session. */
  dispose(): void {
    this.ensureTsAuthority();
    if (this.rustStore !== undefined) {
      this.rustStore.dispose();
      this.rustStore = undefined;
    }
  }

  private shouldUseRust(op: string): boolean {
    const policy = this.opBackends[op] ?? this.backendPolicy;
    if (policy === 'ts') return false;
    if (policy === 'rust') return true;
    return getModelingKernelWasm() !== undefined;
  }

  private ensureRustAuthority(): Result<RustEditMeshStore, ModelingError> {
    if (this.authority === 'rust' && this.rustStore !== undefined) return ok(this.rustStore);
    if (this.rustStore !== undefined) {
      this.rustStore.dispose();
      this.rustStore = undefined;
    }
    if (this.mesh.faceCount === 0 && this.mesh.vertexCount === 0) {
      const created = createEditMeshStore('rust');
      if (!created.ok) return created;
      this.rustStore = created.value as RustEditMeshStore;
      this.authority = 'rust';
      return ok(this.rustStore);
    }
    const synced = syncTsToRust(this.mesh);
    if (!synced.ok) return synced;
    this.rustStore = synced.value;
    this.authority = 'rust';
    return ok(this.rustStore);
  }

  private ensureTsAuthority(): void {
    if (this.authority === 'ts' || this.rustStore === undefined) return;
    syncRustToTs(this.rustStore, this.mesh);
    this.rustStore.dispose();
    this.rustStore = undefined;
    this.authority = 'ts';
    this.generations = undefined;
  }

  private activeFaceCount(): number {
    return this.authority === 'rust' && this.rustStore !== undefined
      ? this.rustStore.faceCount
      : this.mesh.faceCount;
  }

  private activeVertexCount(): number {
    return this.authority === 'rust' && this.rustStore !== undefined
      ? this.rustStore.vertexCount
      : this.mesh.vertexCount;
  }

  private activeTopologyStamp(): number {
    return this.authority === 'rust' && this.rustStore !== undefined
      ? this.rustStore.topologyStamp
      : this.mesh.topologyStamp;
  }

  private rustAttribution(store: RustEditMeshStore, placement: Placement): Attribution {
    return {
      label: placement.label === undefined ? 0 : store.internLabel(placement.label),
      material: placement.material === undefined ? 0 : store.internMaterial(placement.material),
      tag: placement.tag === undefined ? -1 : store.internTag(placement.tag, true),
    };
  }

  private peerRustOperand(other: Model): RustPeerMesh {
    return {
      authority: other.authority,
      rustStore: other.rustStore,
      poisoned: other.poisoned,
      mesh: other.mesh,
    };
  }

  // ---- primitives ---------------------------------------------------------

  box(options: BoxOptions & Placement): OpReport {
    if (this.shouldUseRust('box')) {
      return this.runRust('box', options, options, (s, a) => rustBox(s, a, options));
    }
    return this.run('box', options, options, (attribution) =>
      appendBox(this.mesh, options, attribution),
    );
  }

  plane(options: PlaneOptions & Placement): OpReport {
    if (this.shouldUseRust('plane')) {
      return this.runRust('plane', options, options, (s, a) => rustPlane(s, a, options));
    }
    return this.run('plane', options, options, (attribution) =>
      appendPlane(this.mesh, options, attribution),
    );
  }

  polygon(options: PolygonOptions & Placement): OpReport {
    if (
      this.shouldUseRust('polygon') &&
      options.points.length >= 3 &&
      options.points.every((p) => Math.abs(p[2]) <= 1e-12)
    ) {
      return this.runRust('polygon', options, options, (s, a) => rustPolygon(s, a, options));
    }
    return this.run('polygon', options, options, (attribution) =>
      appendPolygon(this.mesh, options, attribution),
    );
  }

  cylinder(options: CylinderOptions & Placement): OpReport {
    if (
      this.shouldUseRust('cylinder') &&
      options.uv === undefined &&
      options.tolerance === undefined &&
      options.radialSegments !== undefined
    ) {
      const rustOpts = { ...options, radialSegments: options.radialSegments };
      return this.runRust('cylinder', options, options, (s, a) => rustCylinder(s, a, rustOpts));
    }
    return this.run('cylinder', options, options, (attribution) =>
      appendCylinder(this.mesh, options, attribution),
    );
  }

  cone(options: ConeOptions & Placement): OpReport {
    if (
      this.shouldUseRust('cone') &&
      options.uv === undefined &&
      options.tolerance === undefined &&
      options.heightSegments === undefined &&
      options.radialSegments !== undefined
    ) {
      const rustOpts = { ...options, radialSegments: options.radialSegments };
      return this.runRust('cone', options, options, (s, a) => rustCone(s, a, rustOpts));
    }
    return this.run('cone', options, options, (attribution) =>
      appendCone(this.mesh, options, attribution),
    );
  }

  sphere(options: SphereOptions & Placement): OpReport {
    if (
      this.shouldUseRust('sphere') &&
      options.uv === undefined &&
      options.tolerance === undefined &&
      options.widthSegments !== undefined &&
      options.heightSegments !== undefined
    ) {
      const rustOpts = {
        ...options,
        widthSegments: options.widthSegments,
        heightSegments: options.heightSegments,
      };
      return this.runRust('sphere', options, options, (s, a) => rustSphere(s, a, rustOpts));
    }
    return this.run('sphere', options, options, (attribution) =>
      appendSphere(this.mesh, options, attribution),
    );
  }

  torus(options: TorusOptions & Placement): OpReport {
    if (
      this.shouldUseRust('torus') &&
      options.uv === undefined &&
      options.tolerance === undefined &&
      options.radialSegments !== undefined &&
      options.tubularSegments !== undefined
    ) {
      const rustOpts = {
        ...options,
        radialSegments: options.radialSegments,
        tubularSegments: options.tubularSegments,
      };
      return this.runRust('torus', options, options, (s, a) => rustTorus(s, a, rustOpts));
    }
    return this.run('torus', options, options, (attribution) =>
      appendTorus(this.mesh, options, attribution),
    );
  }

  /** Revolve a `[radius, y]` profile about +Y. */
  revolve(options: RevolveOptions & Placement): OpReport {
    if (this.shouldUseRust('revolve')) {
      return this.runRust('revolve', options, options, (s, a) => rustRevolve(s, a, options));
    }
    return this.run('revolve', options, options, (attribution) =>
      appendRevolve(this.mesh, options, attribution),
    );
  }

  /** Extrude an `[x, y]` outline along +Z without holes or bevel. */
  extrudePolygon(options: ExtrudePolygonOptions & Placement): OpReport {
    if (
      this.shouldUseRust('extrudePolygon') &&
      options.holes === undefined &&
      (options.steps === undefined || options.steps === 1) &&
      options.uv === undefined
    ) {
      return this.runRust('extrudePolygon', options, options, (s, a) =>
        rustExtrudePolygon(s, a, options),
      );
    }
    return this.run('extrudePolygon', options, options, (attribution) =>
      appendExtrudePolygon(this.mesh, options, attribution),
    );
  }

  /**
   * Fold a sheet-metal flat pattern (`outline`, `bends`, `thickness`, `kFactor`) into a
   * solid: the pattern is the source, the body derived. Roles `sheet`, `bend` and
   * `sheet-edge`; a pattern that cannot fold is `model-precondition` with
   * `reason: 'not-sheet'`. `sheet.dxf` / `sheet.drawing` project the same pattern.
   */
  sheet(spec: SheetMetalSpec & Placement): OpReport {
    return this.run('sheet', spec, spec, (attribution) =>
      appendSheet(this.mesh, spec, attribution, this.tolerance),
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
    const canUseRust =
      this.shouldUseRust('sweep') &&
      Array.isArray(options.path) &&
      options.path.length >= 2 &&
      Array.isArray(options.profile) &&
      options.profile.length >= 3 &&
      typeof options.profile[0]?.[0] === 'number' &&
      (options.frame === undefined || options.frame === 'rmf') &&
      options.twist === undefined &&
      options.scale === undefined &&
      options.closed !== true &&
      (options.segments === undefined || options.segments === 1);
    if (canUseRust) {
      return this.runRust('sweep', options, options, (s, a) => rustSweep(s, a, options));
    }
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
    if (
      this.shouldUseRust('pipeNetwork') &&
      options.nodeRadius === undefined &&
      options.edgeRadius === undefined &&
      options.strutSegments === undefined &&
      (options.levels === undefined || options.levels === 1)
    ) {
      return this.runRust('pipeNetwork', options, {}, (s, a) => rustPipeNetwork(s, a, options));
    }
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
    if (
      this.shouldUseRust('loft') &&
      options.closed !== true &&
      (options.segments === undefined || options.segments === 1) &&
      options.match === 'index'
    ) {
      return this.runRust('loft', options, options, (s, a) => rustLoft(s, a, options));
    }
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
      const before = this.domainChannel === 'uv1' ? undefined : new Set(this.mesh.faces());
      const appended = appendSurface(
        this.mesh,
        { ...options, patches, blends },
        attribution,
        this.tolerance,
        this.computeOptions(),
        diagnostics,
        { names, declared, trimLoops, seams },
      );
      if (appended.ok && before !== undefined)
        moveDomainToCarrier(
          this.mesh,
          this.mesh.faces().filter((f) => !before.has(f)),
          this.domainChannel,
          diagnostics,
        );
      if (appended.ok)
        for (const [k, patch] of patches.entries()) {
          const owned = seams.filter((s) => s.owner === k).map((s) => s.seam);
          this.recordSurface(names[k] as string, patch.surface, {
            ...(patch.inflections === undefined ? {} : { inflections: patch.inflections }),
            ...(patch.transition === undefined ? {} : { transition: patch.transition }),
            ...((trimLoops[k]?.length ?? 0) > 0 ? { trims: trimLoops[k] } : {}),
            ...(owned.length > 0 ? { seams: owned } : {}),
            chord: options.chord ?? 0.001,
            angle: options.angle ?? 12,
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
   * Exact (B-rep) build ops: each stores a named, frozen `Shape` in the session and leaves the
   * mesh unchanged; `fromShape` is the only crossing into the mesh. The journal records the name
   * and plain parameters, never Shape bytes, so a replay rebuilds the Shape.
   */
  readonly brep = {
    box: (name: string, options: exact.BoxOptions) =>
      this.buildShape('brep.box', name, options, (stage, o) => stage.box(o)),
    cylinder: (name: string, options: exact.CylinderOptions) =>
      this.buildShape('brep.cylinder', name, options, (stage, o) => stage.cylinder(o)),
    cone: (name: string, options: exact.ConeOptions) =>
      this.buildShape('brep.cone', name, options, (stage, o) => stage.cone(o)),
    sphere: (name: string, options: exact.SphereOptions) =>
      this.buildShape('brep.sphere', name, options, (stage, o) => stage.sphere(o)),
    torus: (name: string, options: exact.TorusOptions) =>
      this.buildShape('brep.torus', name, options, (stage, o) => stage.torus(o)),
    extrude: (name: string, options: exact.ExtrudeOptions) =>
      this.buildShape('brep.extrude', name, options, (stage, o) => stage.extrude(o)),
    revolve: (name: string, options: exact.RevolveOptions) =>
      this.buildShape('brep.revolve', name, options, (stage, o) => stage.revolve(o)),
  } as const;

  /** The named exact shape of this session, if any. */
  shape(name: string): exact.Shape | undefined {
    return this.shapes.get(name);
  }

  private buildShape<O extends object>(
    op: string,
    name: string,
    options: O,
    make: (stage: ExactStage, options: O) => Result<exact.Shape, ModelingError>,
  ): OpReport {
    return this.run(op, { ...options, name }, {}, () => {
      const stage = this.exactStage;
      if (stage === undefined) return noExactStage(op);
      if (
        typeof name !== 'string' ||
        name.length === 0 ||
        typeof options !== 'object' ||
        options === null
      )
        return err(stage.brepError('brep-bad-argument', 'a shape name and an options object', {}));
      if (this.shapes.has(name))
        return err(stage.brepError('brep-bad-argument', 'shape names are unique', { name }));
      const made = make(stage, options);
      if (!made.ok) return made;
      const size = shapeSize(made.value);
      if (size.faces > stage.BREP_LIMITS.faces || size.edges > stage.BREP_LIMITS.edges)
        return err(
          modelingError(
            'model-work-budget',
            `a shape within ${stage.BREP_LIMITS.faces} faces and ${stage.BREP_LIMITS.edges} edges`,
            { name, ...size },
          ),
        );
      this.shapes.set(name, made.value);
      return ok({});
    });
  }

  /**
   * Tessellate a named exact shape and append it to the mesh beside any authored geometry. Faces
   * keep the shape's labels and roles, analytic creases are flagged sharp, and `uv0` is a metric
   * packed chart per face (option `uv`). The one crossing from the exact stage into the editable mesh.
   */
  fromShape(name: string, options: exact.TessellateOptions = {}): OpReport {
    let read: exact.TessellateOptions | undefined;
    try {
      read = { ...options };
    } catch {
      read = undefined;
    }
    return this.run('fromShape', { name, ...read }, {}, (attribution) => {
      const stage = this.exactStage;
      if (stage === undefined) return noExactStage('fromShape');
      if (read === undefined)
        return err(
          stage.brepError('brep-bad-argument', 'options are readable (a property access threw)', {
            name,
          }),
        );
      const shape = typeof name === 'string' ? this.shapes.get(name) : undefined;
      if (shape === undefined)
        return err(stage.brepError('brep-bad-argument', 'the name of a built shape', { name }));
      const meshed = stage.tessellate(shape, read);
      if (!meshed.ok) return meshed;
      return append(this.mesh, meshed.value, {}, attribution);
    });
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
    if (this.shouldUseRust('extrude') && faces.isPureAst()) {
      return this.runRust('extrude', { selector: faces.description, ...options }, options, (s, a) =>
        rustExtrude(s, a, faces, options),
      );
    }
    return this.runOn('extrude', faces, options, (ids, attribution, diagnostics) =>
      extrude(this.mesh, ids, options, attribution.label, this.tolerance, diagnostics),
    );
  }

  /**
   * Cut round holes into a planar face: simple, counterbore, countersink or tapped (bore =
   * the thread's tap drill, `threads.lookup`). `centers` are `[u, v]` in the face frame: with
   * the face normal's dominant axis a, `u` is the next world axis after a (cyclic X, Y, Z) and
   * `v = normal x u`, so a +Z face reads centers as world (x, y), measured from the world
   * origin projected onto the face plane. One call is one boolean for all centers; faces take
   * `label` (default `hole`) with roles `hole-wall`, `hole-floor`, `counterbore`, `countersink`.
   * `'through'` cuts every component along the axis, not only the selected face's solid.
   */
  hole(faces: FaceSelector, options: HoleCutOptions): OpReport {
    const placed = { ...options, label: options.label ?? 'hole' };
    if (
      this.shouldUseRust('hole') &&
      faces.isPureAst() &&
      placed.kind === 'simple' &&
      typeof placed.depth === 'number' &&
      placed.tolerance === undefined
    ) {
      return this.runRust('hole', { selector: faces.description, ...placed }, placed, (s, a) =>
        rustHole(
          s,
          a,
          faces,
          {
            diameter: placed.diameter,
            depth: placed.depth as number,
            centers: placed.centers,
            ...(placed.segments === undefined ? {} : { segments: placed.segments }),
            ...(placed.material === undefined ? {} : { material: placed.material }),
          },
          this.tolerance,
        ),
      );
    }
    return this.runOn('hole', faces, placed, (ids, attribution, diagnostics) =>
      hole(
        this.mesh,
        ids,
        placed,
        attribution,
        { tolerance: this.tolerance, ...this.computeOptions() },
        diagnostics,
      ),
    );
  }

  inset(
    faces: FaceSelector,
    options: { readonly thickness: number; readonly region: RegionMode; readonly label?: string },
  ): OpReport {
    if (this.shouldUseRust('inset') && faces.isPureAst()) {
      return this.runRust('inset', { selector: faces.description, ...options }, options, (s, a) =>
        rustInset(s, a, faces, options),
      );
    }
    return this.runOn('inset', faces, options, (ids, attribution) =>
      inset(this.mesh, ids, options, attribution.label),
    );
  }

  /** Move faces along their vertex normals so each face plane moves by `distance`. */
  offset(
    faces: FaceSelector,
    options: { readonly distance: number; readonly region: RegionMode; readonly label?: string },
  ): OpReport {
    if (this.shouldUseRust('offset') && faces.isPureAst()) {
      return this.runRust('offset', { selector: faces.description, ...options }, options, (s, a) =>
        rustOffset(s, a, faces, options),
      );
    }
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
    if (
      this.shouldUseRust('shell') &&
      faces.isPureAst() &&
      open === undefined &&
      flange === undefined &&
      options.taper === undefined &&
      options.clamp !== true
    ) {
      return this.runRust('shell', { selector: faces.description, ...rest }, options, (s, a) =>
        rustShell(s, a, faces, options.thickness, options.direction),
      );
    }
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
    if (this.shouldUseRust('duplicate') && faces.isPureAst()) {
      return this.runRust(
        'duplicate',
        { selector: faces.description, ...options },
        options,
        (s, a) => rustDuplicate(s, faces, a),
      );
    }
    return this.runOn('duplicate', faces, options, (ids, attribution) =>
      duplicate(this.mesh, ids, attribution.label),
    );
  }

  /** Detach faces from the rest of the mesh in place (shared vertices are duplicated). */
  disconnect(faces: FaceSelector): OpReport {
    if (this.shouldUseRust('disconnect') && faces.isPureAst()) {
      return this.runRust('disconnect', { selector: faces.description }, {}, (s) =>
        rustDisconnect(s, faces),
      );
    }
    return this.runOn('disconnect', faces, {}, (ids) => disconnect(this.mesh, ids));
  }

  /**
   * Copy another session or an FXEM snapshot into this one. The operand is read
   * only; tags, labels and material slots merge by name. With `label`, the copied
   * faces get role `part` instead of their own origins. An operand whose patch domain
   * sits on a different carrier channel than this session's is refused (`carrier-mismatch`).
   */
  append(
    part: Model | Uint8Array,
    options: {
      readonly translate?: Tuple3;
      readonly label?: string;
      readonly tag?: string;
    } = {},
  ): OpReport {
    if (this.shouldUseRust('append') && part instanceof Model) {
      return this.runRust('append', options, options, (s, a) =>
        rustAppend(s, a, part === this, this.peerRustOperand(part), options.translate),
      );
    }
    return this.run('append', options, options, (attribution) => {
      const source = this.operand(part);
      if (!source.ok) return source;
      const joined = this.joinCarrier(part, source.value);
      if (!joined.ok) return joined;
      const appended = append(this.mesh, source.value, options, attribution);
      if (appended.ok) joined.value();
      return appended;
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
    if (this.shouldUseRust('bridge') && edges.isPureAst()) {
      return this.runRust('bridge', { selector: edges.description, ...options }, options, (s, a) =>
        rustBridge(s, edges, a, options),
      );
    }
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
    if (this.shouldUseRust('loopCut') && edges.isPureAst()) {
      return this.runRust('loopCut', { selector: edges.description, ...options }, {}, (s) =>
        rustLoopCut(s, edges, options.cuts),
      );
    }
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
   * Corners where three or more bevels meet get role `corner`. `width` may list
   * `{ edges, width }` entries (first match wins; selected edges no entry matches stay
   * unbevelled), so mixed widths meet in one corner. Widths that would invert a face are
   * clamped and reported; boundary edges are `model-precondition`.
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
    const { width } = options;
    if (typeof width === 'number' && this.shouldUseRust('bevel') && edges.isPureAst()) {
      return this.runRust('bevel', { selector: edges.description, ...options }, options, (s, a) =>
        rustBevel(s, a, edges, width, options),
      );
    }
    const args =
      typeof width === 'number'
        ? options
        : {
            ...options,
            width: width.map((entry) => ({ edges: entry.edges.description, width: entry.width })),
          };
    return this.runEdges('bevel', edges, args, (ids, attribution, diagnostics) => {
      const resolved = typeof width === 'number' ? undefined : resolveWidths(this.mesh, ids, width);
      if (resolved !== undefined && !resolved.ok) return resolved;
      return bevel(
        this.mesh,
        resolved === undefined ? ids : resolved.value.edges,
        { ...options, width: resolved === undefined ? (width as number) : resolved.value.widest },
        attribution,
        options.material === undefined ? undefined : attribution.material,
        this.tolerance,
        diagnostics,
        undefined,
        resolved?.value.perEdge,
      );
    });
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
    if (
      this.shouldUseRust('panelLine') &&
      faces.isPureAst() &&
      (options.profile === undefined || options.profile === 'square')
    ) {
      return this.runRust(
        'panelLine',
        { selector: faces.description, point, normal, ...options },
        options,
        (s, a) => rustPanelLine(s, a, faces, point, normal, options, this.tolerance),
      );
    }
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
    if (this.shouldUseRust('bisect') && this.surfaces.length === 0) {
      return this.runRust('bisect', options, {}, (s, a) =>
        rustPlaneCut(s, a, options, false, this.tolerance),
      );
    }
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
    if (this.shouldUseRust('planeCut') && this.surfaces.length === 0) {
      return this.runRust('planeCut', options, options, (s, a) =>
        rustPlaneCut(s, a, options, true, this.tolerance),
      );
    }
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
    if (this.shouldUseRust('dissolve') && edges.isPureAst()) {
      return this.runRust('dissolve', { selector: edges.description }, {}, (s) =>
        rustDissolve(s, edges),
      );
    }
    return this.runEdges('dissolve', edges, {}, (ids, _attribution, diagnostics) =>
      dissolve(this.mesh, ids, this.tolerance, diagnostics),
    );
  }

  /** Split the mesh open along interior edges whose cut reaches a boundary or closes a loop. */
  split(edges: EdgeSelector): OpReport {
    if (this.shouldUseRust('split') && edges.isPureAst()) {
      return this.runRust('split', { selector: edges.description }, {}, (s) => rustSplit(s, edges));
    }
    return this.runEdges('split', edges, {}, (ids, _attribution, diagnostics) =>
      split(this.mesh, ids, diagnostics),
    );
  }

  /** Flip inside-out closed components touched by the selection so they face outward. */
  orient(faces: FaceSelector): OpReport {
    if (this.shouldUseRust('orient') && faces.isPureAst()) {
      return this.runRust('orient', { selector: faces.description }, {}, (s) =>
        rustOrient(s, faces),
      );
    }
    return this.runOn('orient', faces, {}, (ids) => orient(this.mesh, ids));
  }

  /** Triangulate n-gons exactly as export would; a self-overlapping face is `model-degenerate` in both. */
  triangulate(faces: FaceSelector): OpReport {
    if (this.shouldUseRust('triangulate') && faces.isPureAst()) {
      return this.runRust('triangulate', { selector: faces.description }, {}, (s) =>
        rustTriangulate(s, faces),
      );
    }
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
    if (this.shouldUseRust('fillHoles') && edges.isPureAst()) {
      return this.runRust(
        'fillHoles',
        { selector: edges.description, ...options },
        options,
        (s, a) => rustFillHoles(s, a, edges, options.material),
      );
    }
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
    const singleTriSubmesh =
      mesh.submeshes.length === 1 && mesh.submeshes[0]?.topology === 'triangle-list';
    const hasPos = mesh.attributes.position instanceof Float32Array;
    const hasIdx = mesh.indices instanceof Uint16Array || mesh.indices instanceof Uint32Array;
    if (this.shouldUseRust('lift') && singleTriSubmesh && hasPos && hasIdx) {
      return this.runRust('lift', options, options, (s, a) => rustLift(s, a, mesh));
    }
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
        const joined = this.joinCarrier(target, source.value);
        if (!joined.ok) return joined;
        const copies = arrayCopies(
          this.mesh,
          { source: source.value },
          options,
          attribution,
          prefix,
          this.tolerance,
        );
        if (copies.ok) joined.value();
        return copies;
      });
    }
    if (
      this.shouldUseRust('array') &&
      target.isPureAst() &&
      ('linear' in options || 'radial' in options)
    ) {
      return this.runRust('array', { selector: target.description, ...options }, options, (s, a) =>
        rustArray(s, a, target, options, prefix),
      );
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
    if (this.shouldUseRust('mirror') && this.surfaces.length === 0) {
      return this.runRust('mirror', options, {}, (store) => {
        const res = store.rustMesh.mirror(options.axis, options.weldDistance ?? this.tolerance);
        return res.ok ? ok({ mirrored: res.value }) : err(kernelErrorToModelingError(res.error));
      });
    }
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
    if (this.shouldUseRust('translate') && target.domain === 'face' && target.isPureAst()) {
      return this.runRust('translate', { selector: target.description, offset }, {}, (store) => {
        const ids = store.resolveSelector(target);
        if (!ids.ok) return ids;
        const res = store.rustMesh.translate(ids.value, offset);
        return res.ok ? ok({}) : err(kernelErrorToModelingError(res.error));
      });
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
    if (this.shouldUseRust('scale') && target.domain === 'face' && target.isPureAst()) {
      return this.runRust('scale', { selector: target.description, factor, pivot }, {}, (store) => {
        const invalid = positive();
        if (invalid !== undefined) return err(invalid);
        const ids = store.resolveSelector(target);
        if (!ids.ok) return ids;
        const res = store.rustMesh.scale(ids.value, factor, pivot);
        return res.ok ? ok({}) : err(kernelErrorToModelingError(res.error));
      });
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
    if (this.shouldUseRust('rotate') && target.domain === 'face' && target.isPureAst()) {
      return this.runRust(
        'rotate',
        { selector: target.description, axis, degrees, pivot },
        {},
        (store) => {
          const ids = store.resolveSelector(target);
          if (!ids.ok) return ids;
          const res = store.rustMesh.rotate(ids.value, axis, degrees, pivot);
          return res.ok ? ok({}) : err(kernelErrorToModelingError(res.error));
        },
      );
    }
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
    if (
      this.shouldUseRust('spherize') &&
      target.isPureAst() &&
      options.falloff === undefined &&
      (options.radii === undefined ||
        (options.radii[0] === options.radii[1] && options.radii[1] === options.radii[2]))
    ) {
      return this.runRust('spherize', { selector: target.description, ...options }, {}, (s) =>
        rustSpherize(s, target, options),
      );
    }
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
    if (this.shouldUseRust('flip') && faces.isPureAst()) {
      return this.runRust('flip', { selector: faces.description }, {}, (store) => {
        const ids = store.resolveSelector(faces);
        if (!ids.ok) return ids;
        const res = store.rustMesh.flipFaces(ids.value);
        return res.ok ? ok({ flipped: res.value }) : err(kernelErrorToModelingError(res.error));
      });
    }
    return this.runOn('flip', faces, {}, (ids) => flipFaces(this.mesh, ids));
  }

  delete(faces: FaceSelector): OpReport {
    if (this.shouldUseRust('delete') && faces.isPureAst()) {
      return this.runRust('delete', { selector: faces.description }, {}, (store) => {
        const ids = store.resolveSelector(faces);
        if (!ids.ok) return ids;
        const res = store.rustMesh.deleteFaces(ids.value);
        return res.ok ? ok({ deleted: res.value }) : err(kernelErrorToModelingError(res.error));
      });
    }
    return this.runOn('delete', faces, {}, (ids) => deleteFaces(this.mesh, ids));
  }

  /** Merge vertices closer than `distance` (meters). */
  weld(options: { readonly distance: number }): OpReport {
    if (this.shouldUseRust('weld') && this.surfaces.length === 0) {
      return this.runRust('weld', options, {}, (s) => rustWeld(s, options.distance));
    }
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
    if (this.shouldUseRust('subdivide') && (faces === undefined || faces.isPureAst())) {
      return this.runRust(
        'subdivide',
        faces === undefined ? options : { selector: faces.description, ...options },
        {},
        (s) => rustSubdivide(s, faces, options, this.faceBudget),
      );
    }
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
    if (this.shouldUseRust('lattice') && target.isPureAst() && options.bounds === undefined) {
      return this.runRust('lattice', { selector: target.description, ...options }, {}, (s) =>
        rustLattice(s, target, options),
      );
    }
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
    if (this.shouldUseRust('bend') && target.isPureAst()) {
      return this.runRust('bend', { selector: target.description, ...options }, {}, (s) =>
        rustBend(s, target, options),
      );
    }
    return this.runVertices('bend', target, options, (ids, diagnostics) =>
      bend(this.mesh, ids, options, this.tolerance, diagnostics),
    );
  }

  /** Twist about `axis`, ramping from 0 to `angle` degrees over `range`. */
  twist(target: FaceSelector | VertSelector, options: TwistOptions): OpReport {
    if (this.shouldUseRust('twist') && target.isPureAst()) {
      return this.runRust('twist', { selector: target.description, ...options }, {}, (s) =>
        rustTwist(s, target, options),
      );
    }
    return this.runVertices('twist', target, options, (ids, diagnostics) =>
      twist(this.mesh, ids, options, this.tolerance, diagnostics),
    );
  }

  /** Scale cross sections of `axis`, ramping from 1 to `factor` over `range`. */
  taper(target: FaceSelector | VertSelector, options: TaperOptions): OpReport {
    if (this.shouldUseRust('taper') && target.domain === 'face' && target.isPureAst()) {
      return this.runRust('taper', { selector: target.description, ...options }, {}, (s) =>
        rustTaper(s, target, options),
      );
    }
    return this.runVertices('taper', target, options, (ids, diagnostics) =>
      taper(this.mesh, ids, options, this.tolerance, diagnostics),
    );
  }

  /**
   * Draft prism walls `faces` by `angle` degrees toward `direction`, pivoting each wall about
   * its line on the plane of the `neutral` faces, which keep their exact positions.
   */
  applyDraft(faces: FaceSelector, options: ApplyDraftOptions): OpReport {
    const { neutral, ...rest } = options;
    if (this.shouldUseRust('applyDraft') && faces.isPureAst() && neutral.isPureAst()) {
      return this.runRust(
        'applyDraft',
        { selector: faces.description, ...rest, neutral: neutral.description },
        {},
        (s) => rustApplyDraft(s, faces, options),
      );
    }
    return this.runOn('applyDraft', faces, { ...rest, neutral: neutral.description }, (ids) => {
      const base = neutral.resolve(this.mesh);
      if (!base.ok) return base;
      return applyDraft(this.mesh, ids, base.value, options, this.tolerance);
    });
  }

  /** Lay the mesh along a path: distance along `axis` becomes arc length. */
  curveDeform(target: FaceSelector | VertSelector, options: CurveDeformOptions): OpReport {
    if (
      this.shouldUseRust('curveDeform') &&
      target.isPureAst() &&
      Array.isArray(options.path) &&
      (options.frame === undefined || options.frame === 'rmf') &&
      options.stretch !== true
    ) {
      return this.runRust('curveDeform', { selector: target.description, ...options }, {}, (s) =>
        rustCurveDeform(s, target, options, options.path as readonly Tuple3[]),
      );
    }
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
    (target: FaceSelector | VertSelector, options: SmoothOptions): OpReport => {
      if (this.shouldUseRust('smooth') && target.isPureAst()) {
        return this.runRust('smooth', { selector: target.description, ...options }, {}, (s) =>
          rustSmooth(s, target, options),
        );
      }
      return this.runVertices('smooth', target, options, (ids, diagnostics) =>
        smooth(this.mesh, ids, options, this.tolerance, diagnostics),
      );
    },
    {
      implicit: (
        target: FaceSelector | VertSelector | undefined,
        options: ImplicitSmoothOptions,
      ): OpReport => {
        const args = { ...options, pin: describePins(options?.pin) };
        const pinList =
          options?.pin === undefined
            ? []
            : Array.isArray(options.pin)
              ? options.pin
              : [options.pin];
        if (
          this.shouldUseRust('smooth.implicit') &&
          (target === undefined || target.isPureAst()) &&
          options?.solver === undefined &&
          pinList.every((p) => typeof p === 'string' || p.isPureAst())
        ) {
          return this.runRust(
            'smooth.implicit',
            target === undefined ? args : { selector: target.description, ...args },
            {},
            (s) => rustImplicitSmooth(s, target, options),
          );
        }
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
    const pinList =
      options?.pin === undefined ? [] : Array.isArray(options.pin) ? options.pin : [options.pin];
    if (
      this.shouldUseRust('arap') &&
      target.isPureAst() &&
      options?.solver === undefined &&
      options.handles.every(
        (h) =>
          h.selector.isPureAst() &&
          h.rotate === undefined &&
          (h.translate !== undefined || h.to !== undefined),
      ) &&
      pinList.every((p) => typeof p !== 'string' && p.isPureAst())
    ) {
      return this.runRust('arap', { selector: target.description, ...args }, {}, (s) =>
        rustArap(s, target, options),
      );
    }
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
    const selfSelector = onto instanceof Selector && onto.isPureAst();
    const validPeerModel =
      onto instanceof Model &&
      onto !== this &&
      onto.poisoned === undefined &&
      onto.surfaces.length === 0;
    if (
      this.shouldUseRust('shrinkwrap') &&
      target.isPureAst() &&
      rest.falloff === undefined &&
      (rest.mode !== 'project' || Array.isArray(rest.direction)) &&
      (selfSelector || validPeerModel)
    ) {
      return this.runRust('shrinkwrap', { selector: target.description, ...args }, {}, (s) => {
        let surf: { readonly positions: Float64Array; readonly indices: Uint32Array };
        if (onto instanceof Selector) {
          const ontoIds = s.resolveSelector(onto as FaceSelector);
          if (!ontoIds.ok) return ontoIds;
          surf = triangulateRustStoreFaces(s, ontoIds.value);
        } else {
          const peer = onto as Model;
          surf =
            peer.authority === 'rust' && peer.rustStore !== undefined
              ? triangulateRustStoreFaces(peer.rustStore)
              : triangulateEditMeshFaces(peer.editMesh);
        }
        return rustShrinkwrap(s, target, surf, rest);
      });
    }
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
    if (
      this.shouldUseRust('simplify') &&
      (faces === undefined || faces.isPureAst()) &&
      options.clearance === undefined &&
      options.silhouette === undefined
    ) {
      return this.runRust(
        'simplify',
        faces === undefined ? options : { selector: faces.description, ...options },
        {},
        (s) => rustSimplify(s, faces, options),
      );
    }
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
    const uvPad = options.uv?.padding === undefined ? 0 : resolveRustMipPadding(options.uv.padding);
    if (
      this.shouldUseRust('lowpoly') &&
      (faces === undefined || faces.isPureAst()) &&
      this.surfaces.length === 0 &&
      options.silhouette === undefined &&
      options.slivers === undefined &&
      Number.isFinite(uvPad)
    ) {
      return this.runRust(
        'lowpoly',
        faces === undefined ? options : { selector: faces.description, ...options },
        {},
        (s) => rustLowpoly(s, faces, options, this.tolerance),
      );
    }
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
    if (
      this.shouldUseRust('remesh') &&
      (faces === undefined || faces.isPureAst()) &&
      options.clearance === undefined &&
      options.adaptive === undefined &&
      options.direction === undefined
    ) {
      return this.runRust(
        'remesh',
        faces === undefined ? options : { selector: faces.description, ...options },
        {},
        (s) => rustRemesh(s, faces, options),
      );
    }
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
    if (
      (operation === 'offset' || operation === 'fill') &&
      this.shouldUseRust(op) &&
      (faces === undefined || faces.isPureAst()) &&
      this.surfaces.length === 0 &&
      options.material === undefined
    ) {
      return this.runRust(
        op,
        faces === undefined ? options : { selector: faces.description, ...options },
        options,
        (s, a) =>
          rustVoxelRemesh(
            s,
            faces,
            operation === 'offset' ? 'offset' : 'fill',
            options as {
              readonly voxelSize: number;
              readonly distance?: number;
              readonly band?: number;
            },
            a,
          ),
      );
    }
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
      if (this.shouldUseRust('cleanup.planar') && (faces === undefined || faces.isPureAst())) {
        return this.runRust(
          'cleanup.planar',
          faces === undefined ? {} : { selector: faces.description },
          {},
          (s) => rustCleanupPlanar(s, faces, this.tolerance),
        );
      }
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
      if (this.shouldUseRust('cleanup.quads') && (faces === undefined || faces.isPureAst())) {
        return this.runRust(
          'cleanup.quads',
          faces === undefined ? options : { selector: faces.description, ...options },
          {},
          (s) => rustCleanupQuads(s, faces, options),
        );
      }
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
      if (this.shouldUseRust('cleanup.slivers') && (faces === undefined || faces.isPureAst())) {
        return this.runRust(
          'cleanup.slivers',
          faces === undefined ? options : { selector: faces.description, ...options },
          {},
          (s) =>
            rustCleanupSlivers(s, faces, options.width, options.quiet ?? false, this.tolerance),
        );
      }
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
    tiling: (faces: FaceSelector | undefined, options: TilingOptions): OpReport => {
      if (
        this.shouldUseRust('cleanup.tiling') &&
        (faces === undefined || faces.isPureAst()) &&
        options.clearance === undefined &&
        options.direction === undefined
      ) {
        return this.runRust(
          'cleanup.tiling',
          faces === undefined ? options : { selector: faces.description, ...options },
          {},
          (s) => rustCleanupTiling(s, faces, options),
        );
      }
      return this.processOn('cleanup.tiling', faces, options, (ids, diagnostics) =>
        cleanupTiling(this.mesh, ids, options, this.processContext(), diagnostics),
      );
    },
  };

  /** Insert boundary vertices that lie on other boundary edges (default distance: tolerance). */
  resolveTJunctions(options: { readonly distance?: number } = {}): OpReport {
    if (this.shouldUseRust('resolveTJunctions')) {
      return this.runRust('resolveTJunctions', options, {}, (s) =>
        rustResolveTJunctions(s, options.distance ?? this.tolerance),
      );
    }
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
    if (this.shouldUseRust('tag') && faces.isPureAst()) {
      return this.runRust('tag', { selector: faces.description, name }, {}, (store) => {
        const ids = store.resolveSelector(faces);
        if (!ids.ok) return ids;
        const res = store.rustMesh.tagFaces(ids.value, name);
        if (!res.ok) return err(kernelErrorToModelingError(res.error));
        store.internTag(name, true);
        return ok({ tagged: ids.value.length });
      });
    }
    return this.runOn('tag', faces, { name }, (ids) => {
      const t = this.mesh.tagIndex(name, true);
      for (const f of ids) this.mesh.addTag(f, t);
      return ok({ tagged: ids.length });
    });
  }

  /** Assign a material slot by name; slot order follows first use. */
  assign(faces: FaceSelector, slot: string): OpReport {
    if (this.shouldUseRust('assign') && faces.isPureAst()) {
      return this.runRust('assign', { selector: faces.description, slot }, {}, (store) => {
        const ids = store.resolveSelector(faces);
        if (!ids.ok) return ids;
        const res = store.rustMesh.setMaterial(ids.value, slot);
        if (!res.ok) return err(kernelErrorToModelingError(res.error));
        store.internMaterial(slot);
        return ok({ assigned: ids.value.length });
      });
    }
    return this.runOn('assign', faces, { slot }, (ids) => {
      const m = this.mesh.nameIndex(this.mesh.materialNames, slot);
      for (const f of ids) this.mesh.fMaterial[f] = m;
      return ok({ assigned: ids.length });
    });
  }

  markSharp(edges: EdgeSelector, sharp = true): OpReport {
    if (this.shouldUseRust('markSharp') && edges.isPureAst()) {
      return this.runRust('markSharp', { selector: edges.description, sharp }, {}, (s) =>
        rustMarkEdges(s, edges, EDGE_SHARP, sharp),
      );
    }
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
    if (this.shouldUseRust('markCrease') && edges.isPureAst()) {
      return this.runRust(
        'markCrease',
        { selector: edges.description, sharpness: recorded },
        {},
        (s) => rustMarkCrease(s, edges, sharpness),
      );
    }
    return this.runEdges(
      'markCrease',
      edges,
      { sharpness: recorded },
      (ids, _attribution, diagnostics) => markCrease(this.mesh, ids, sharpness, diagnostics),
    );
  }

  /**
   * Mark what the faces' part is for (BK46): `detail` faces are what booleans' `details`
   * option, `lowpoly({ roles: 'form' })` and the bake read; `tool` faces shape a form.
   */
  markRole(faces: FaceSelector, role: PartRole): OpReport {
    if (this.shouldUseRust('markRole') && faces.isPureAst() && PART_ROLES.includes(role)) {
      return this.runRust('markRole', { selector: faces.description, role }, {}, (s) =>
        rustMarkRole(s, faces, role),
      );
    }
    return this.runOn('markRole', faces, { role }, (ids) => {
      if (!PART_ROLES.includes(role)) {
        return err(
          modelingError('model-invalid-argument', "role is 'form', 'detail' or 'tool'", { role }),
        );
      }
      for (const f of ids) setPartRole(this.mesh, f, role);
      return ok({ [role]: ids.length });
    });
  }

  /**
   * Tag faces with their bake group from the part tags (BK48): `parts` is the ordered
   * part -> group map (first match wins; see `BakeGroupsOptions`), applied to the selected faces
   * (default all). Run it on the low and on the high with the same map, then bake with
   * `tags: { groupPrefix }`; `idMap(m.editMesh)` paints the result in UV space.
   */
  bakeGroups(options: BakeGroupsOptions, faces: FaceSelector = sel.all()): OpReport {
    return this.runOn(
      'bakeGroups',
      faces,
      { parts: options.parts.length },
      (ids, _a, diagnostics) => assignBakeGroups(this.mesh, ids, options, diagnostics),
    );
  }

  /**
   * Set or clear the floating flag (`details: 'float'` sets it): floating detail shells ride
   * later booleans untouched and are bake floaters. `markRole` never touches it, so
   * `m.markFloat(sel.all(), false)` is how a floated shell becomes an ordinary part again.
   */
  markFloat(faces: FaceSelector, float = true): OpReport {
    if (this.shouldUseRust('markFloat') && faces.isPureAst()) {
      return this.runRust('markFloat', { selector: faces.description, float }, {}, (s) =>
        rustMarkFloat(s, faces, float),
      );
    }
    return this.runOn('markFloat', faces, { float }, (ids) => {
      for (const f of ids) {
        const flags = this.mesh.fFlags[f] as number;
        this.mesh.fFlags[f] = float ? flags | FACE_FLOAT : flags & ~FACE_FLOAT;
      }
      return ok({ [float ? 'float' : 'unfloat']: ids.length });
    });
  }

  markSeam(edges: EdgeSelector, seam = true): OpReport {
    if (this.shouldUseRust('markSeam') && edges.isPureAst()) {
      return this.runRust('markSeam', { selector: edges.description, seam }, {}, (s) =>
        rustMarkEdges(s, edges, EDGE_SEAM, seam),
      );
    }
    return this.runEdges('markSeam', edges, { seam }, (ids) =>
      markEdges(this.mesh, ids, EDGE_SEAM, seam),
    );
  }

  readonly uv = createModelUvOps({
    getTolerance: () => this.tolerance,
    getMesh: () => this.mesh,
    hasSurfaces: () => this.surfaces.length > 0 || this.adoptedCarrier,
    domainChannel: () => this.domainChannel,
    setDomainChannel: (channel) => {
      this.domainChannel = channel;
    },
    carrier: () => this.carrier(),
    uvContext: () => this.uvContext(),
    noteCarrierWrite: (op, ids, channel, diagnostics) =>
      this.noteCarrierWrite(op, ids, channel, diagnostics),
    shouldUseRust: (op) => this.shouldUseRust(op),
    runRust: (op, args, placement, body) => this.runRust(op, args, placement as Placement, body),
    run: (op, args, placement, body) => this.run(op, args, placement as Placement, body),
    runOn: (op, faces, args, body) => this.runOn(op, faces, args, body),
  });

  /** Warn when a UV operator's output channel holds the patch domain of the faces it rewrites. */
  private noteCarrierWrite(
    op: string,
    ids: readonly number[],
    channel: CornerChannelName | undefined,
    diagnostics: OpDiagnostic[],
  ): void {
    carrierOverwriteNote(op, this.mesh, ids, channel, this.carrier(), diagnostics);
  }

  private carrier(): Carrier {
    return {
      channel: this.domainChannel,
      surfaces:
        this.adoptedPatches.length === 0
          ? this.surfaces
          : [...this.surfaces, ...this.adoptedPatches.map((name) => ({ name }))],
    };
  }

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
    if (this.authority === 'rust' && this.rustStore !== undefined && selector.isPureAst()) {
      const res = this.rustStore.evaluateSelector(selector);
      if (res.ok) return res.value.length;
    }
    this.ensureTsAuthority();
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
    this.ensureTsAuthority();
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
    this.ensureTsAuthority();
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
    if (this.failure !== undefined) {
      const site = this.failure.detail?.site as { readonly opIndex?: number } | undefined;
      return poisonedReport(this.mesh, {
        code: this.failure.code,
        ...(site?.opIndex === undefined ? {} : { opIndex: site.opIndex }),
      });
    }
    const report = this.validateChecks(options);
    if (options.strict === undefined || options.strict === false) return report;
    const gated = new Set<string>(options.strict === true ? STRICT_QUALITY_CODES : options.strict);
    const failing = report.issues.some((i) => i.severity === 'warn' && gated.has(i.code));
    return failing ? { ...report, pass: false } : report;
  }

  private validationInputs(): ValidationInputs {
    return {
      mesh: this.mesh,
      tolerance: this.tolerance,
      entries: this.entries,
      drawings: this.drawings,
      surfaces: this.surfaces,
      featureLines: this.featureLines,
      qualitySources: this.qualitySources,
      layouts: this.layouts,
    };
  }

  private validateChecks(options: ValidateOptions): ValidationReport {
    this.ensureTsAuthority();
    const inputs = this.validationInputs();
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
    return finishSurfaceQualityValidation(inputs, report, options);
  }

  private validateShutLines(report: ValidationReport, options: ValidateOptions): ValidationReport {
    return validateShutLines(this.validationInputs(), report, options);
  }

  private validateDrawings(report: ValidationReport, options: ValidateOptions): ValidationReport {
    return validateDrawings(this.validationInputs(), report, options);
  }

  private validateShellClearance(report: ValidationReport): ValidationReport {
    return validateShellClearance(this.validationInputs(), report);
  }

  private validateLayouts(report: ValidationReport, options: ValidateOptions): ValidationReport {
    return validateLayouts(this.validationInputs(), report, options);
  }

  private validateEdgeFlow(report: ValidationReport, options: ValidateOptions): ValidationReport {
    return validateEdgeFlow(this.validationInputs(), report, options);
  }

  /**
   * Audit part roles by geometric visibility (BK64): from a sphere of viewpoints, how much of
   * each part can be seen, and which `detail` / `tool` parts show or `form` parts are hidden.
   * Does not change the session.
   */
  auditVisibility(
    options: VisibilityOptions & { readonly faces?: FaceSelector } = {},
  ): Result<VisibilityAudit, ModelingError> {
    if (this.failure !== undefined) return err(this.failure);
    this.ensureTsAuthority();
    const ids =
      options.faces === undefined ? ok(this.mesh.faces()) : options.faces.resolve(this.mesh);
    if (!ids.ok) return ids;
    return auditVisibility(this.mesh, ids.value, options);
  }

  /**
   * Measure how well the UV seams of a channel are hidden from a sphere of viewpoints
   * (see `measureSeamVisibility`). Does not change the session.
   */
  seamVisibility(options: SeamVisibilityOptions = {}): Result<SeamVisibilityReport, ModelingError> {
    if (this.failure !== undefined) return err(this.failure);
    this.ensureTsAuthority();
    return measureSeamVisibility(this.mesh, options);
  }

  /**
   * Measure shut lines against a DTS table (gap on the theoretical line, visual gap,
   * flush, parallelism, symmetry; see `measureShutLines`). Does not change the session.
   */
  shutLines(options: ShutLineOptions): Result<ShutLineReport, ModelingError> {
    if (this.failure !== undefined) return err(this.failure);
    this.ensureTsAuthority();
    return measureShutLines(this.mesh, options, this.drawings);
  }

  inspect(): ModelInspection {
    this.ensureTsAuthority();
    const labels = this.mesh.labelNames.slice(1).map((label) => ({
      label,
      roles: {} as Record<string, number>,
    }));
    const roles = { form: 0, detail: 0, tool: 0, float: 0 };
    for (const f of this.mesh.faces()) {
      roles[partRole(this.mesh, f)]++;
      if (((this.mesh.fFlags[f] as number) & FACE_FLOAT) !== 0) roles.float++;
      const label = labels[(this.mesh.fLabel[f] as number) - 1];
      if (label === undefined) continue;
      const role = this.mesh.roleNames[this.mesh.fRole[f] as number] ?? '';
      label.roles[role] = (label.roles[role] ?? 0) + 1;
    }
    return {
      faces: this.mesh.faceCount,
      edges: this.mesh.edgeCount,
      vertices: this.mesh.vertexCount,
      tags: [...this.mesh.tagNames],
      labels,
      materials: [...this.mesh.materialNames],
      roles,
      ...(this.output === undefined ? {} : { output: this.output }),
      ...(this.exportedNormals === undefined ? {} : { normals: this.exportedNormals }),
      ...(this.failure === undefined ? {} : { poisoned: this.failure }),
      journal: this.entries,
    };
  }

  /**
   * Canonical FXEM bytes of the current mesh. A poisoned session's bytes are its partial
   * state: used as an operand (append, array, booleans, shrinkwrap), they fail with the
   * session's first failure instead of adding partial geometry.
   */
  snapshot(): Uint8Array {
    let bytes: Uint8Array;
    if (this.authority === 'rust' && this.rustStore !== undefined) {
      const temp = new EditMesh();
      syncRustToTs(this.rustStore, temp);
      bytes = encodeSnapshot(temp);
    } else {
      bytes = encodeSnapshot(this.mesh);
    }
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
    this.ensureTsAuthority();
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
      domainChannel: this.domainChannel,
      adoptedCarrier: this.adoptedCarrier,
      adoptedPatches: [...this.adoptedPatches],
      featureLines: [...this.featureLines],
      shapes: new Map(this.shapes),
      qualitySources: new Map(this.qualitySources),
      layouts: this.layouts.map((layout) => ({ layout, fields: { ...layout } })),
      provenance: this.provenance,
      output: this.output,
      normals: this.exportedNormals,
    };
  }

  private restoreState(state: SessionState): void {
    if (this.rustStore !== undefined) {
      this.rustStore.dispose();
      this.rustStore = undefined;
    }
    this.authority = 'ts';
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
    this.domainChannel = state.domainChannel;
    this.adoptedCarrier = state.adoptedCarrier;
    this.adoptedPatches = [...state.adoptedPatches];
    replaceAll(this.featureLines, state.featureLines);
    this.shapes.clear();
    for (const [key, value] of state.shapes) this.shapes.set(key, value);
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
    this.exportedNormals = state.normals;
  }

  /** @internal Mesh and rig finish share one successful shading policy for inspection. */
  _recordExportNormals(normals: NormalMode): void {
    this.exportedNormals = { ...normals };
  }

  // ---- output -----------------------------------------------------------------------

  /** Export the compacted mesh with its report. */
  toMesh(
    options: ExportOptions = {},
  ): Result<
    { readonly mesh: MeshAsset; readonly report: ExportReport; readonly sidecar: ExportSidecar },
    ModelingError
  > {
    if (this.failure !== undefined) return err(this.failure);
    this.ensureTsAuthority();
    const { mesh: compacted, faceMap } = this.mesh.compact();
    const exported = exportMesh(
      compacted,
      options.normals?.mode === 'surface'
        ? { ...options, surfaces: this.surfaces, domain: this.domainChannel }
        : options,
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
    if (this.captured) this.provenance = exported.value.sidecar;
    return ok(exported.value);
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
    this._recordExportNormals(options.normals ?? { mode: 'weighted' });
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

  /**
   * Whether joining `part` keeps one patch-domain carrier. Only an operand that holds
   * patch-domain data on a different channel than this session's own patch data is refused.
   * A session holds patch data when it records patches (its carrier is `domainChannel`) or
   * adopted a carrier from a patched operand; as an operand it counts the same way, and keeps
   * counting after all its patch faces were deleted (the record outlives the faces, so the
   * refusal errs on the safe side). A snapshot records no patches, so its carrier is only a
   * heuristic derived from its channels: uv2 present reads as a patch domain moved to uv2 (a
   * user-made uv2 is indistinguishable and treated the same), else uv1. A session without
   * patch data adopts the carrier of a patched operand once the join succeeds (the returned
   * thunk, run only for a join that went through) and from then on holds patch data itself,
   * so a later join is compared, not adopted. A uv1-only snapshot never marks a free host:
   * uv1 is the default channel of every lightmapped or projected bare mesh. Joins of sessions
   * that never moved a domain, and of bare meshes, are unaffected; a bare snapshot with uv1
   * is still compared against a host that holds patch data on uv2.
   */
  private joinCarrier(part: Model | Uint8Array, mesh: EditMesh): Result<() => void, ModelingError> {
    let theirs: CornerChannelName | undefined;
    if (part instanceof Model)
      theirs = part.surfaces.length > 0 || part.adoptedCarrier ? part.domainChannel : undefined;
    else if (mesh.channels.has('uv2')) theirs = 'uv2';
    else if (mesh.channels.has('uv1')) theirs = 'uv1';
    if (theirs === undefined) return ok(() => {});
    const adoptPatches = () => {
      if (!(part instanceof Model)) return;
      for (const name of [...part.surfaces.map((x) => x.name), ...part.adoptedPatches])
        if (!this.adoptedPatches.includes(name)) this.adoptedPatches.push(name);
    };
    if (this.surfaces.length === 0 && !this.adoptedCarrier) {
      if (part instanceof Uint8Array && theirs === 'uv1') return ok(() => {});
      return ok(() => {
        this.domainChannel = theirs;
        this.adoptedCarrier = true;
        adoptPatches();
      });
    }
    if (theirs === this.domainChannel) return ok(adoptPatches);
    const snapshot = part instanceof Uint8Array;
    return err(
      modelingError(
        'model-precondition',
        'a join keeps one patch-domain carrier: the operand holds its patch domain on the same channel as this session',
        {
          code: 'carrier-mismatch',
          host: this.domainChannel,
          operand: theirs,
          ...(snapshot ? { derived: true } : {}),
        },
        snapshot
          ? 'a snapshot records no carrier (derived from its uv channels): join the Model session itself, or move the patch domain of this session and the snapshot alike'
          : 'run uv.lightmap with domain copyTo-uv2 on the session that has not moved its patch domain, or move neither',
      ),
    );
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
    if (
      operation !== 'split' &&
      this.shouldUseRust(op) &&
      operand instanceof Model &&
      options.label === undefined &&
      options.tag === undefined
    ) {
      return this.runRust(op, { ...described, ...options }, options, (s) =>
        rustBoolean(s, operation, operand === this, this.peerRustOperand(operand), this.tolerance),
      );
    }
    return this.run(op, { ...described, ...options }, options, (attribution, diagnostics) => {
      let target: { readonly mesh: EditMesh } | { readonly faces: readonly number[] };
      let adopt = () => {};
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
        const joined = this.joinCarrier(operand, operand.editMesh);
        if (!joined.ok) return joined;
        adopt = joined.value;
        target = { mesh: operand.editMesh };
      } else {
        const decoded = decodeOperand(operand);
        if (!decoded.ok) return decoded;
        const joined = this.joinCarrier(operand, decoded.value);
        if (!joined.ok) return joined;
        adopt = joined.value;
        target = { mesh: decoded.value };
      }
      const combined = booleanOp(
        this.mesh,
        operation,
        target,
        options,
        attribution,
        { tolerance: this.tolerance, ...this.computeOptions() },
        diagnostics,
      );
      if (combined.ok) adopt();
      return combined;
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

  private runRust(
    op: string,
    args: unknown,
    placement: Placement,
    body: (
      store: RustEditMeshStore,
      attribution: Attribution,
      diagnostics: OpDiagnostic[],
    ) => Result<RoleCounts, ModelingError>,
  ): OpReport {
    const opIndex = this.entries.length;
    const label = placement.label;
    const before = this.activeTopologyStamp();
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
    const captureRollback = this.rollbackOnInternal ?? (this.captured || invariantChecksEnabled());
    const saved = captureRollback ? this.captureState() : undefined;
    let outcome: Result<RoleCounts, ModelingError>;
    try {
      const storeRes = this.ensureRustAuthority();
      if (!storeRes.ok) {
        outcome = storeRes;
      } else {
        const store = storeRes.value;
        outcome = body(store, this.rustAttribution(store, placement), diagnostics);
      }
    } catch (cause) {
      if (cause instanceof InvariantError) throw cause;
      outcome = err(internalError(base, cause));
    }
    if (!outcome.ok && outcome.error.code === 'model-internal' && saved !== undefined) {
      this.restoreState(saved);
    }
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
    const currentFaces = this.activeFaceCount();
    if (currentFaces > this.faceBudget) {
      const failure = modelingError(
        'model-work-budget',
        `the mesh stays within ${this.faceBudget} faces`,
        {
          site: base,
          faces: currentFaces,
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
    return this.record(base, args, 'ok', roles, before, started, undefined, diagnostics);
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
    this.ensureTsAuthority();
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
    const captureRollback = this.rollbackOnInternal ?? (this.captured || invariantChecksEnabled());
    const saved = captureRollback ? this.captureState() : undefined;
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
    if (!outcome.ok && outcome.error.code === 'model-internal' && saved !== undefined)
      this.restoreState(saved);
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
    if (this.authority === 'rust' && this.rustStore !== undefined) {
      const probe = new EditMesh();
      syncRustToTs(this.rustStore, probe);
      const violations = debugValidate(probe);
      if (violations.length > 0) throw new InvariantError(op, violations);
      this.generations = undefined;
      return;
    }
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
      faces: this.activeFaceCount(),
      vertices: this.activeVertexCount(),
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

/** Wall-clock milliseconds, guarding environments without `performance`. */
function now(): number {
  return typeof performance === 'undefined' ? 0 : performance.now();
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
  readonly domainChannel: CornerChannelName;
  readonly adoptedCarrier: boolean;
  readonly adoptedPatches: string[];
  readonly featureLines: FeatureLine[];
  readonly shapes: Map<string, exact.Shape>;
  readonly qualitySources: Map<string, number>;
  readonly layouts: { readonly layout: DeclaredLayout; readonly fields: DeclaredLayout }[];
  readonly provenance: ModelDiagnostics['provenance'];
  readonly output: string | undefined;
  readonly normals: NormalMode | undefined;
}

export function model(options: ModelOptions = {}): Model {
  return new Model(options);
}
