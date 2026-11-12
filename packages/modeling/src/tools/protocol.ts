import type { MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import type { SourceSite } from '../capture';
import type { OverlayKind } from '../diagnostics';
import type { Contour, ExplodedPart, ExplodeOptions, ResolvedDrawing } from '../drawing';
import type { RepairReport } from '../ops';
import type { FeatureLine, NamedSurface } from '../surface-quality';
import type { FacePick, SelectorSynthesis } from '../synthesize';
import type { ValidateOptions } from '../validate';
import type { WatertightOptions } from '../watertight';
import type { CoverageReference } from '../watertight-coverage';

/** A section view: cut at the plane, keep the side opposite `normal`, cap and hatch the cut. */
export interface SectionRequest {
  readonly point: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  /** Hatch line spacing in meters; default 1/40 of the section extent. */
  readonly spacing?: number;
  /** Hatch angle in degrees within the plane; default 45. */
  readonly angle?: number;
}

/** A rig pose: explicit joint values, or the rig's exported path at `u`; rest without either. */
export interface PoseRequest {
  /** Captured rig index; absent selects the only rig, else the one whose finish() produced an output. */
  readonly rig?: number;
  readonly u?: number;
  readonly values?: Readonly<Record<string, number | Readonly<Record<string, number>>>>;
  readonly limits?: 'clamp' | 'reject';
  /** Penetration accepted between parts (meters); designed contacts come from the rig. */
  readonly tolerance?: number;
}

/** A path scan along the rig's exported path. */
export interface ScanRequest {
  readonly rig?: number;
  readonly step?: number;
  readonly maxTravel?: number;
  readonly refine?: number;
  readonly tolerance?: number;
  readonly clearance?: number;
}

/** One capture request executed by the modeling capture Worker. */
export interface CaptureRequest {
  readonly sourcePath: string;
  /**
   * Upper bound in milliseconds for this capture, enforced by the tool process (`--timeout-ms`;
   * default: the tool's `timeoutMs`). Large Packs on a busy host need more than the default.
   */
  readonly timeoutMs?: number;
  /** Capture Worker heap limit in MiB (`--heap-mb`; default `defaultCaptureHeapMb()`). */
  readonly heapMb?: number;
  readonly values?: Readonly<Record<string, unknown>>;
  /**
   * Time repeated builds of the loaded Pack in one Worker (`--timing-runs`): `cold` is the
   * reported build, `hot` an identical rebuild, `local` a rebuild with these parameter
   * values merged over `values`, `final` a rebuild with the original values. Omit `local`
   * for `hot` only. The rebuilds' sessions are discarded.
   */
  readonly timingRuns?: { readonly local?: Readonly<Record<string, unknown>> };
  /** Captured session index; absent selects the only session, else the one whose finish() produced an output. */
  readonly session?: number;
  readonly checkpoint?: string;
  /** State right after this operation (`opIndex` from `model.history`); excludes `checkpoint`. */
  readonly step?: number;
  /**
   * Render payloads of these operation states, in order (step replay); at most
   * REPLAY_LIMIT. `all`: every successful operation that leaves faces, evenly
   * sampled down to REPLAY_LIMIT (the last one is always kept).
   */
  readonly replay?: readonly number[] | 'all';
  readonly selector?: string;
  /** Render the selected faces see-through (X-ray of an outer shell). */
  readonly xray?: string;
  readonly explode?: ExplodeOptions;
  readonly section?: SectionRequest;
  /**
   * Validate every session (`summary.validation`) with these options. Absent means no
   * validation: the exact self-intersection check dominates large captures, so only
   * `model.validate` asks for it.
   */
  /**
   * Data only across the Worker boundary: no `watertight.open` selector, and a coverage
   * reference as FXEM bytes, never a live Model.
   */
  readonly validate?: Omit<ValidateOptions, 'watertight'> & {
    readonly watertight?:
      | true
      | (Omit<WatertightOptions, 'open' | 'reference'> & {
          readonly reference?: Omit<CoverageReference, 'surface'> & {
            readonly surface: Uint8Array;
          };
        });
  };
  readonly overlays?: readonly OverlayKind[];
  /** `edges` overlays keep only edges with an end inside these bounds (a close-up frame). */
  readonly overlayBounds?: readonly number[];
  /** Include every session's operation steps (`report.history`). */
  readonly history?: boolean;
  /** Include a renderable export of the target state (`report.render`). */
  readonly render?: boolean;
  /** Include the FXEM snapshot of the target state (`report.state`), as `model.diff` compares. */
  readonly snapshot?: boolean;
  /**
   * Pose a rig: `report.pose`; the posed state replaces the rig's session state for
   * selections, overlays and renders, with parts in contact in the highlight slot.
   */
  readonly pose?: PoseRequest;
  /** Scan the rig's exported path: `report.scan`. */
  readonly scan?: ScanRequest;
  /** Resolve picks on the target state and synthesize their selector: `report.synthesis`. */
  readonly synthesize?: { readonly pick: FacePick; readonly maxAtoms?: number };
  /** Score a selector against picks carried over from a reference state: `report.verified`. */
  readonly verify?: VerifyRequest;
  /** With `selector`: include the selected faces as highlight overlay geometry. */
  readonly highlight?: boolean;
}

/** A synthesized selector checked on another build (stability check). */
export interface VerifyRequest {
  readonly selector: string;
  /** Canonical FXEM snapshot of the state the picks were made on. */
  readonly reference: Uint8Array;
  /** Picked faces as canonical face ids of `reference`. */
  readonly faces: readonly number[];
}

/** A declared Pack parameter with a numeric range: the stability check rebuilds at both ends. */
export interface ParameterRange {
  readonly name: string;
  readonly type: string;
  readonly value: number;
  readonly minimum: number;
  readonly maximum: number;
}

export interface SynthesisPayload {
  readonly session: number;
  readonly checkpoint?: string;
  readonly step?: number;
  /** Picked faces (session face ids, as `model.select` and `elementIds` report them). */
  readonly picked: readonly number[];
  readonly synthesis: SelectorSynthesis;
  /** Selected faces of the synthesized selector as overlay geometry. */
  readonly highlight: OverlayPayload;
  readonly reference: Uint8Array;
  /** `picked` as canonical face ids of `reference`. */
  readonly faces: readonly number[];
  readonly parameters: readonly ParameterRange[];
}

export interface VerifyPayload {
  readonly session: number;
  /** Faces the picks correspond to in this build (`transferSelection`). */
  readonly expected: number;
  readonly matched: number;
  readonly common: number;
  /** Picks without a counterpart in this build. */
  readonly lost: number;
  readonly jaccard: number;
}

export interface CaptureFailure {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
}

export type CaptureResponse =
  | { readonly ok: true; readonly value: CaptureReport }
  | { readonly ok: false; readonly error: CaptureFailure };

export interface CheckpointSummary {
  readonly name: string;
  /** Number of operations before the checkpoint. */
  readonly opIndex: number;
  readonly faces: number;
  readonly vertices: number;
  readonly source?: SourceSite;
}

export interface SessionSummary {
  readonly index: number;
  /** Output source key the session's finish() produced (`mesh/<key>`); absent for helper sessions. */
  readonly output?: string;
  readonly faces: number;
  readonly edges: number;
  readonly vertices: number;
  readonly tags: readonly string[];
  readonly labels: readonly {
    readonly label: string;
    readonly roles: Readonly<Record<string, number>>;
  }[];
  readonly materials: readonly string[];
  readonly checkpoints: readonly CheckpointSummary[];
  /** Number of recorded operations; `model.history` lists them. */
  readonly operations: number;
  readonly poisoned?: CaptureFailure & { readonly source?: SourceSite };
  /** Present when the request asked to validate. */
  readonly validation?: SessionValidation;
}

/** One validation finding located on geometry and, through its creating label, on source. */
export interface ValidationFinding {
  readonly code: string;
  readonly severity: 'error' | 'warn' | 'info';
  /** `confirmed` facts versus `candidate` contacts that may be intended. */
  readonly certainty: 'confirmed' | 'candidate';
  readonly location: {
    /** Face ids of the session state (the ids `elementIds` overlays draw); bounded. */
    readonly faces?: readonly number[];
    readonly vertices?: readonly number[];
    /** Centroid of the first referenced element. */
    readonly point?: readonly [number, number, number];
    /** Label and role of the first referenced face, when an operation labeled it. */
    readonly createdBy?: { readonly label: string; readonly role: string };
    /** Call site of the last operation with that label. */
    readonly source?: SourceSite;
  };
  readonly detail: unknown;
}

export interface SessionValidation {
  readonly pass: boolean;
  readonly closed: boolean;
  readonly volume: number;
  readonly boundaryEdges: number;
  readonly issues: readonly ValidationFinding[];
  readonly issuesTruncated: boolean;
  /** Non-fatal operation diagnostics (clamps, fallbacks, soft effect assertions). */
  readonly operations: readonly {
    readonly opIndex: number;
    readonly op: string;
    readonly label?: string;
    readonly source?: SourceSite;
    readonly diagnostics: readonly unknown[];
  }[];
}

/** One recorded operation of a captured session, in call order. */
export interface HistoryStep {
  readonly opIndex: number;
  readonly op: string;
  readonly label?: string;
  /** JSON-safe projection of the call arguments (selectors as their expression). */
  readonly args: unknown;
  readonly status: string;
  readonly roles: Readonly<Record<string, number>>;
  /** Session size after the operation. */
  readonly faces: number;
  readonly vertices: number;
  readonly durationMs: number;
  readonly source?: SourceSite;
  readonly diagnostics?: readonly unknown[];
  /** Repair operations: events changed and the largest departures from the input. */
  readonly repair?: RepairReport;
  readonly error?: CaptureFailure;
}

export interface SessionHistory {
  readonly index: number;
  readonly output?: string;
  readonly steps: readonly HistoryStep[];
  readonly stepsTruncated: boolean;
  readonly checkpoints: readonly CheckpointSummary[];
}

/** Wall-clock phases of one capture, in milliseconds. */
export interface CaptureTiming {
  /** Pack loading and parameter resolution. */
  readonly loadMs: number;
  /** The Pack build under capture. */
  readonly buildMs: number;
  /** Session summaries (and history, when requested), excluding validation. */
  readonly summarizeMs: number;
  /** Exact validation of every session; 0 unless requested. */
  readonly validateMs: number;
  /** Selection, overlays, render payloads and replay states for the target session. */
  readonly targetMs: number;
  readonly totalMs: number;
  /** First build under capture, in milliseconds (`timingRuns`; equals `buildMs`). */
  readonly cold?: number;
  /** An identical rebuild in the warm Worker (`timingRuns`). */
  readonly hot?: number;
  /** A rebuild with `timingRuns.local` applied to the parameter values. */
  readonly local?: number;
  /** A rebuild with the original values after the local edit; absent without `timingRuns.local`. */
  readonly final?: number;
  /** The build that produced these timings (`timingRuns`). */
  readonly env?: CaptureEnvironment;
}

export interface CaptureEnvironment {
  /** Digest of the runtime files of the built package the Worker ran from. */
  readonly distDigest: string;
  /** `TS_KERNEL_DIGEST`: identity of the TS kernels. */
  readonly kernelSha: string;
}

/**
 * The Pack's own `material/*` and `texture/*` outputs of the build that produced the captured
 * mesh. A renderer binds `materials[slotName]` to the mesh slot of the same name; texture
 * references inside a material are GUID strings that key `textures`.
 */
export interface PackMaterials {
  /** `material/<slotName>` outputs, keyed by `<slotName>`. */
  readonly materials: Readonly<Record<string, MaterialAsset>>;
  /** `texture/<key>` outputs, keyed by the formatted GUID derived from the Pack id and `texture/<key>`. */
  readonly textures: Readonly<Record<string, TextureAsset>>;
}

export interface CaptureReport {
  readonly timing: CaptureTiming;
  readonly build: {
    readonly ok: boolean;
    readonly outputs: readonly string[];
    readonly error?: CaptureFailure;
  };
  readonly sessions: readonly SessionSummary[];
  /** Session that `selected`, `overlays` and `render` were evaluated on. */
  readonly session?: number;
  readonly selected?: SelectionReport;
  readonly overlays?: readonly OverlayPayload[];
  readonly history?: readonly SessionHistory[];
  readonly render?: RenderPayload;
  readonly replay?: ReplayPayload;
  /** Present for `render` and `replay` captures whose build has `material/*` outputs. */
  readonly materials?: PackMaterials;
  readonly state?: StatePayload;
  /** Every rig the build created (`rig()` calls), in creation order. */
  readonly rigs?: readonly RigSummary[];
  readonly pose?: PoseReport;
  readonly scan?: ScanPayload;
  readonly synthesis?: SynthesisPayload;
  readonly verified?: VerifyPayload;
}

export interface RigSummary {
  readonly index: number;
  /** Captured session the rig poses. */
  readonly session: number;
  /** Output source key of the rig's finish() (`scene/<key>`). */
  readonly output?: string;
  readonly joints: readonly {
    readonly name: string;
    readonly parent: string | null;
    readonly kind: string;
    readonly axis: readonly number[];
    readonly limits?: unknown;
  }[];
  readonly parts: readonly {
    readonly name: string;
    readonly joint: string;
    readonly faces: number;
    readonly closed: boolean;
  }[];
  /** Key u values of the exported path. */
  readonly path?: readonly number[];
  readonly error?: CaptureFailure;
}

export interface PoseReport {
  readonly rig: number;
  readonly session: number;
  readonly u?: number;
  /** Applied joint values (after limits). */
  readonly values: Readonly<Record<string, unknown>>;
  readonly clamped: readonly unknown[];
  /** Joint frames in model space, row-major 3x4. */
  readonly joints: readonly { readonly name: string; readonly world: readonly number[] }[];
  readonly interference: unknown;
  /** Parts drawn in the highlight slot: those in confirmed or candidate contact. */
  readonly highlighted: readonly string[];
}

export interface ScanPayload {
  readonly rig: number;
  readonly session: number;
  readonly report: unknown;
}

/** Step replay of one session: each frame is the state right after its operation. */
export interface ReplayPayload {
  readonly session: number;
  readonly operations: number;
  readonly frames: readonly (RenderPayload & {
    readonly opIndex: number;
    readonly op: string;
    readonly label?: string;
    readonly source?: SourceSite;
  })[];
  /** True when step snapshots hit MAX_STEP_BYTES; later steps show the last kept state. */
  readonly stepsTruncated: boolean;
}

/** FXEM snapshot of the target session state (structured-clone transport). */
export interface StatePayload {
  readonly session: number;
  readonly checkpoint?: string;
  readonly snapshot: Uint8Array;
}

export interface SelectionReport {
  readonly session: number;
  readonly checkpoint?: string;
  readonly selector: string;
  readonly domain: string;
  readonly count: number;
  readonly ids: readonly number[];
  readonly bounds?: readonly [number, number, number, number, number, number];
  /** Selected faces as overlay geometry (`highlight` requests). */
  readonly highlight?: OverlayPayload;
}

/** JSON transport of a preview overlay mesh (see engine.preview.display.set `overlays`). */
export interface OverlayPayload {
  readonly kind: OverlayKind | 'selection';
  readonly topology: 'triangle-list' | 'line-list';
  readonly positions: readonly number[];
  readonly colors: readonly number[];
  readonly legend: readonly {
    readonly label: string;
    readonly color: readonly number[];
    readonly faces: number;
  }[];
}

/** Material slot that `render` assigns to the selected faces. */
export const HIGHLIGHT_SLOT = 'highlight';
/** Material slot of the faces a render shows see-through (`xray`). */
export const XRAY_SLOT = 'xray';
export const REPLAY_LIMIT = 64;

/** Largest per-call capture budget a caller may ask for. */
export const CAPTURE_TIMEOUT_LIMIT_MS = 600_000;

/** `--timeout-ms`: per-call capture budget; composers such as DevKit's `model.render` spread it. */
export const CAPTURE_TIMEOUT_ARG = {
  type: 'integer',
  minimum: 1000,
  maximum: CAPTURE_TIMEOUT_LIMIT_MS,
  description:
    'Upper bound in milliseconds for each Pack rebuild of this call (default 60000); raise it for large Packs or a busy host',
} as const;

export const CAPTURE_HEAP_LIMIT_MB = 16_384;

/** `--heap-mb`: per-call capture Worker heap; composers spread it like `timeoutMs`. */
export const CAPTURE_HEAP_ARG = {
  type: 'integer',
  minimum: 256,
  maximum: CAPTURE_HEAP_LIMIT_MB,
  description:
    'Capture Worker heap limit in MiB (default: a quarter of admitted system memory, 1024-8192); raise it for very large assemblies',
} as const;

/**
 * A renderable export of one session state (structured-clone transport, so typed
 * arrays survive). The selection, when given, owns the `highlight` slot.
 */
export interface RenderPayload {
  readonly session: number;
  readonly checkpoint?: string;
  readonly mesh: MeshAsset;
  readonly faces: number;
  readonly triangles: number;
  readonly gpuVertices: number;
  readonly bounds: readonly [number, number, number, number, number, number];
  /** True when the state lacked complete `uv0` and a box projection stood in for export. */
  readonly uvProjected: boolean;
  /**
   * Design drawings and contours of the session, drawn by ortho views; its NURBS
   * patches and feature lines, which zebra, curvature and comb views evaluate exactly.
   */
  readonly drawing: {
    readonly drawings: readonly ResolvedDrawing[];
    readonly contours: readonly Contour[];
    readonly surfaces: readonly NamedSurface[];
    readonly featureLines: readonly FeatureLine[];
  };
  readonly explode?: { readonly by: string; readonly parts: readonly ExplodedPart[] };
  readonly section?: {
    readonly point: readonly number[];
    readonly normal: readonly number[];
    /** Cap triangles (triangle-list positions) facing `normal`. */
    readonly cap: readonly number[];
    /** Hatch and outline lines (line-list positions), lifted off the cap. */
    readonly hatch: readonly number[];
    readonly outline: readonly number[];
    readonly area: number;
    readonly spacing: number;
  };
  readonly xray?: { readonly selector: string; readonly faces: number };
}

export const HISTORY_LIMIT = 500;
export const ID_LIMIT = 64;
export const OVERLAY_VERTEX_LIMIT = 200_000;
export const ISSUE_LIMIT = 50;

/** @internal One heap-exhaustion response shared by capture host and coordinator. */
export function captureHeapFailure(heapMb: number): CaptureResponse {
  return {
    ok: false,
    error: {
      code: 'model-work-budget',
      expected: `the capture fits in ${heapMb} MiB of Worker heap`,
      hint: 'pass a larger heapMb (--heap-mb), up to 16384, or capture a smaller Pack',
      detail: { heapMb },
    },
  };
}
