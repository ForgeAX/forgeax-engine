import { type ByteCache, err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from '../errors';
import type { NormalMode } from '../finish';
import type { Tuple3 } from '../geom';
import { decodeJobEntry, encodeJobEntry } from './job-cache';
import type { Flow } from './line-field';
import { sha256 } from './sha256';

/**
 * Compute jobs (design 4.1): heavy numeric work behind one contract with a required
 * TypeScript baseline and an optional native backend. Each kind maps to its params and
 * provenance shape; adding a kind is adding an entry to both maps.
 */
export type BooleanOperation = 'union' | 'difference' | 'intersection' | 'split';

export interface BooleanJobParams {
  readonly operation: BooleanOperation;
  /** Coplanarity and weld distance in meters. */
  readonly tolerance: number;
}

export type SubdivisionScheme = 'catmullClark' | 'simple';
/** OpenSubdiv boundary interpolation: `edgeAndCorner` also keeps valence-2 boundary corners. */
export type SubdivisionBoundary = 'edgeOnly' | 'edgeAndCorner';

export interface SubdivideJobParams {
  readonly scheme: SubdivisionScheme;
  readonly boundary: SubdivisionBoundary;
  readonly levels: number;
  /** Input FXEM face indices to refine, ascending; 'all' refines every face. */
  readonly faces: readonly number[] | 'all';
  /** Sharpness of flagged edges that store no level of their own (absent: infinite). */
  readonly creaseSharpness?: number;
}

/** 2D region operations: booleans of two regions, or offset/stroke of one. */
export type RegionOperation = 'union' | 'difference' | 'intersection' | 'xor' | 'offset' | 'stroke';

export interface RegionJobParams {
  readonly operation: RegionOperation;
  /** Weld distance in region units. */
  readonly tolerance: number;
  /** Offset distance (outward > 0) or stroke half-width. */
  readonly delta?: number;
  /** Corners where offsets diverge (default 'round'); a miter beyond `miterLimit` bevels. */
  readonly join?: 'round' | 'miter' | 'bevel';
  /** Stroke ends and offset spikes (default 'round'). */
  readonly cap?: 'round' | 'butt' | 'square';
  /** Miter length over offset distance (default 2). */
  readonly miterLimit?: number;
  /** Largest chord error of round joins and caps (default 0.5% of the distance). */
  readonly arcTolerance?: number;
}

export type SolveMethod = 'cg' | 'pcg-jacobi' | 'cgls';

/**
 * Sparse linear solve: `cg` / `pcg-jacobi` take a symmetric positive definite matrix,
 * `cgls` solves min ||A x - b|| without forming A^T A.
 */
export interface SolveSparseParams {
  readonly method: SolveMethod;
  /** Relative residual to reach (default 1e-10). */
  readonly tolerance?: number;
  /** Default max(100, 4 x unknowns). */
  readonly maxIterations?: number;
  /** CGLS column scaling (default 'jacobi'). */
  readonly precondition?: 'jacobi' | 'none';
}

/**
 * 'lscm' least-squares conformal, 'expmap' geodesic polar, 'rectify' quad grids mapped
 * to straight rows and columns (LSCM for islands that are not quad grids).
 */
export type UnwrapMethod = 'lscm' | 'expmap' | 'rectify';

/**
 * Where LSCM pins an island: the two farthest-apart elements of its longest boundary
 * loop (`boundary`), or of the whole island (`extent`).
 */
export type UvPinRule = 'boundary' | 'extent';

export interface UvUnwrapJobParams {
  readonly method: UnwrapMethod;
  readonly pins: UvPinRule;
  /** Relative residual of the CGLS fallback (an island beyond the direct solve's envelope limit). */
  readonly tolerance: number;
  readonly maxIterations?: number;
  /**
   * `'expmap'` (uv.auto): LSCM starts each island from its ExpMap, and the island keeps
   * the ExpMap when LSCM folds, collapses or distorts it more (slivers make the LSCM
   * system ill-conditioned).
   */
  readonly start?: 'expmap';
  /**
   * `'slim'`: every island that is not a rectified grid is refined by SLIM toward
   * isometry (symmetric Dirichlet energy, flip-free; a folded disk restarts from its
   * Tutte embedding). The refined layout replaces the start only if it passes the
   * gate: flip-free, lower energy, no new self-overlap, no wider texel density spread.
   * Without the option the unwrap is unchanged.
   */
  readonly refine?: 'slim';
}

export interface UvPackJobParams {
  /** Atlas size in texels (square). */
  readonly resolution: number;
  /** Texels between islands (half of it at the atlas border). */
  readonly padding: number;
  /** Allow reorienting islands: minimal-area bounding rectangle and quarter turns. */
  readonly rotate: boolean;
  /** Scale every island to its 3D area first (one texel density); otherwise keep relative UV scale. */
  readonly normalize: boolean;
  /** 'skyline' (default): bounding rectangles; 'raster': island cell masks (holes and concave islands take others). */
  readonly method?: 'skyline' | 'raster';
  /** Raster turns in degrees (90: four orientations, 45: eight; default 90). */
  readonly rotateStep?: 90 | 45;
  /** Congruent islands (same triangles, same shape up to quarter turns) share one placement. */
  readonly stack?: boolean;
  /** Texels per meter (normalize) instead of the largest scale: the scale may fall to target x (1 - tolerance). */
  readonly density?: { readonly target: number; readonly tolerance: number };
}

/** One influence of `skin.bind`: a bone fan from its root to every child joint (or the root alone). */
export interface SkinBone {
  readonly root: Tuple3;
  readonly tips: readonly Tuple3[];
}

/**
 * Automatic skin weights (geodesic voxel route, then cotan
 * smoothing and cleanup). Bones are the influences, by index.
 */
export interface SkinBindJobParams {
  readonly bones: readonly SkinBone[];
  /** Occupancy cells along the longest axis of the input bounds. */
  readonly resolution: number;
  /** 0: W = 1 / d^2 falloff; 1: W = 1 / d^4 (stiffer, more local). */
  readonly stiffness: number;
  /** Cotangent-weighted smoothing iterations. */
  readonly smoothing: number;
  /** Blend toward the neighbor average per iteration, in (0, 1]. */
  readonly smoothingStrength: number;
  readonly maxInfluences: number;
  /** Influences below this weight are dropped (the largest always stays). */
  readonly prune: number;
  /** `[vertex, bone]` pairs held at weight 1 (seams shared with rigid parts). */
  readonly pins?: readonly number[];
}

/**
 * Voxel operations: `sdf` builds a signed distance grid from mesh faces, `mesh`
 * extracts a grid's iso surface (Surface Nets), and `union` / `offset` / `fill` run
 * both: the (smooth) union of the faces' closed parts, their offset surface, or the
 * closed surface of open input.
 */
export type VoxelOperation = 'sdf' | 'mesh' | 'union' | 'offset' | 'fill';

/** Inside test of the distance grid: generalized winding number >= 1/2, or 3-axis ray crossings. */
export type VoxelSign = 'winding' | 'parity';

export interface VoxelJobParams {
  readonly operation: VoxelOperation;
  /** Input FXEM faces the field is built from, ascending, or 'all' (unused by `mesh`). */
  readonly faces: readonly number[] | 'all';
  /** Grid spacing in meters (`mesh` takes it from its grid). */
  readonly voxelSize: number;
  /** Narrow band half-width in voxels with exact distances; farther samples clamp to it. */
  readonly band: number;
  readonly sign: VoxelSign;
  /** Smooth-union blend radius in meters (`union`; 0 is the hard union). */
  readonly radius?: number;
  /** Offset distance in meters, outward > 0 (`offset`). */
  readonly distance?: number;
  /** Extracted level in meters (default 0); > 0 grows the surface. */
  readonly iso?: number;
  /** Relaxation sweeps of the Surface Nets vertices, each kept inside its cell (default 0). */
  readonly smooth?: number;
  /** Place cell vertices at the quadric minimizer of the crossing planes (dual contouring). */
  readonly sharp?: boolean;
}

/** Design 5.6 constraint level of one feature class: change freely, slide along it, or pin it. */
export type ConstraintLevel = 'free' | 'slide' | 'pin';

/** Feature classes of the shared constraint generator (design 5.6 `constrain`). */
export interface RemeshConstraints {
  readonly boundary: ConstraintLevel;
  readonly sharp: ConstraintLevel;
  readonly seam: ConstraintLevel;
  readonly material: ConstraintLevel;
  /** Edges between faces of different label, role or tags. */
  readonly label: ConstraintLevel;
}

/** QEM error terms: plane quadrics, plus a volume-preserving constraint, plus a vertex-normal attribute quadric. */
export type QuadricKind = 'plane' | 'volume' | 'attribute';

/** `simplify` collapses edges by quadric error; `isotropic` splits, collapses, flips and smooths toward one edge length. */
export type RemeshOperation = 'simplify' | 'isotropic' | 'tiling';

export interface RemeshJobParams {
  readonly operation: RemeshOperation;
  /** Input FXEM faces to process, ascending, or 'all'; the rest pass through unchanged. */
  readonly faces: readonly number[] | 'all';
  readonly constraints: RemeshConstraints;
  /** Simplify: stop at this many triangles. */
  readonly targetFaces?: number;
  /** Simplify: stop before a collapse whose RMS plane distance exceeds this; tiling: no move leaves the input surface by more (meters). */
  readonly maxError?: number;
  /** Simplify error terms (default 'volume'). */
  readonly quadric?: QuadricKind;
  /** Refuse moves (collapses; remesh splits, flips and smoothing too) that bring a triangle within this distance of one it shares no vertex with (meters). */
  readonly clearance?: number;
  /** Simplify: refuse collapses that leave a triangle above this aspect (worse than it was); tiling: collapse needles above it (default 5). */
  readonly maxAspect?: number;
  /** Simplify: refuse collapses that give a vertex more neighbours than this. */
  readonly maxValence?: number;
  /** Simplify: quadrics of the contour-generator vertices seen from `eyes` scale by 1 + weight. */
  readonly silhouette?: { readonly eyes: readonly Tuple3[]; readonly weight: number };
  /** Isotropic: target edge length in meters. */
  readonly targetEdgeLength?: number;
  /** Isotropic: curvature-adaptive lengths, chord error `error` (meters), at least `minEdge`, at most targetEdgeLength. */
  readonly adaptive?: { readonly error: number; readonly minEdge: number };
  /** Isotropic: split/collapse/flip/smooth passes; tiling: flip and collapse passes (default 10). */
  readonly iterations?: number;
  /** Isotropic: tangential smoothing speed in [0, 1] (default 0.1). */
  readonly smoothing?: number;
  /** Isotropic: the line field the long edges follow, built on the input faces. */
  readonly direction?: RemeshDirection;
}

/** A remesh direction with its selectors resolved to input FXEM face and vertex ids. */
export interface RemeshDirection {
  readonly guides:
    | readonly {
        readonly faces?: readonly number[];
        readonly flow: Flow;
        readonly anisotropy?: number;
      }[]
    | 'principal';
  /** Long over short edge length (1 is isotropic); a guide's own value wins on its faces. */
  readonly anisotropy: number;
  /** Extra hard constraints: input vertex pairs, flattened. */
  readonly constrain?: readonly number[];
}

/**
 * Automatic charting: normal-weighted farthest-point
 * seeds grow into patches, and neighbors merge while their joint ExpMap stays within
 * the distortion and normal limits. Input edges flagged as seams are hard boundaries.
 */
export interface UvChartJobParams {
  /** Initial patches; the chart count never exceeds it (except one per extra component). */
  readonly maxCharts: number;
  /** Largest area-weighted mean area distortion of a merged chart's ExpMap. */
  readonly maxDistortion: number;
  /** Largest angle (degrees) between the average normals of two merging charts. */
  readonly maxNormalDeviation: number;
}

export interface UvChartMetrics {
  readonly faces: number;
  readonly area3d: number;
  /** Area-weighted mean of max(rho, 1 / rho) of the chart's ExpMap. */
  readonly meanDistortion: number;
}

/** Per job face (FXEM face order): its chart; per chart facts in chart order. */
export interface UvChartProvenance {
  readonly faceChart: Int32Array;
  readonly charts: readonly UvChartMetrics[];
}

/** Maps of one bake (design 13): one correspondence pass feeds every evaluator. */
export type BakeMapKind =
  | 'normal'
  | 'normalObject'
  | 'ao'
  | 'curvature'
  | 'cavity'
  | 'edgeWear'
  | 'height'
  | 'position'
  | 'thickness'
  | 'opacity'
  | 'ormh'
  | 'materialId'
  | 'baseColor'
  | 'emissive'
  | 'resample';

/**
 * Surface of one detail material slot, the one table every slot-driven map reads:
 * `ormh` (roughness, metallic), `baseColor` (sRGB RGBA; its alpha also scales `opacity`)
 * and `emissive` (linear RGB times `emissiveIntensity`). Unset fields come from the slot
 * `'*'`, then the defaults: white opaque, roughness 0.5, metallic 0, no emission, intensity 1.
 */
export interface BakeSlot {
  /** Linear RGB ID mask color; defaults to the slot-order material palette. */
  readonly materialId?: readonly [number, number, number];
  readonly baseColor?: readonly [number, number, number, number];
  readonly roughness?: number;
  readonly metallic?: number;
  readonly emissive?: readonly [number, number, number];
  readonly emissiveIntensity?: number;
}

/**
 * Ray direction field of the correspondence: `averaged` casts along the
 * position-welded, angle-weighted vertex normals of each group (smooth cage:
 * continuous across hard edges), `shading` along the base's exported (split) shading
 * normals, `face` along each base face's geometric normal (no skew on flat panels).
 * `{ face: tag }` casts faces with that tag along their face normal and the rest
 * averaged; `{ blend: meters }` turns from averaged at hard edges to face normal at
 * `blend` meters from them.
 */
export type BakeDirection =
  | 'averaged'
  | 'shading'
  | 'face'
  | { readonly face: string }
  | { readonly blend: number };

/**
 * Cage extent of a group: rays start `offset` meters outside the base along the
 * direction field and travel at most `maxRay` meters (so they reach `maxRay - offset`
 * below it). `'auto'` estimates from the group's detail (largest outward and inward
 * deviation x 1.05).
 */
export interface BakeCage {
  readonly offset: number | 'auto';
  readonly maxRay: number | 'auto';
}

/** Per-group overrides of the bake-wide cage and direction. */
export interface BakeGroupSettings {
  readonly cage?: Partial<BakeCage>;
  readonly direction?: BakeDirection;
}

/** A normal mode in job params (JSON): a transfer source travels as base64 FXEM. */
export type BakeJobNormals =
  | Exclude<NormalMode, { readonly mode: 'transfer' }>
  | {
      readonly mode: 'transfer';
      readonly from: string;
      readonly sourceNormals?: Exclude<NormalMode, { readonly mode: 'transfer' }>;
    };

export interface BakeJobParams {
  readonly maps: readonly BakeMapKind[];
  /** Texels of the base's uv0 atlas, or one value per base vertex. */
  readonly target: 'texture' | 'vertex';
  /** Texture size (texture target): square, or [width, height] for strips. */
  readonly resolution: number | readonly [number, number];
  readonly cage: BakeCage;
  readonly direction: BakeDirection;
  /** @internal Skip the own-side check of cage rays (the hard-rim gate's falsifier). */
  readonly rawCage?: true;
  /**
   * Face-tag conventions of the bake: `groupPrefix` is a tag prefix, so a face tagged
   * `<groupPrefix><id>` belongs to bake group `id` on the base and on the detail (untagged faces
   * form the group ''; rays only find their own group); `floater` tags detail faces
   * that float over the surface (normal-only: height ignores them, AO does not see them).
   */
  readonly tags?: { readonly groupPrefix?: string; readonly floater?: string };
  /** Per bake group id: overrides of the bake-wide cage and direction. */
  readonly groups?: Readonly<Record<string, BakeGroupSettings>>;
  /** Texels the gutter grows around every chart, or 'fill' to fill every empty texel. */
  readonly gutter: number | 'fill';
  /** Lowest mip level that must not mix charts or background (V4); reported, warned when bleeding. */
  readonly protectMip: number;
  /** Samples per texel on a square grid (1, 4, 9 or 16). */
  readonly samples: number;
  /** Cubic B-spline reconstruction within each chart, or none. */
  readonly filter: 'bspline' | 'none';
  /** Export normals of the base (its tangent frame) and of the detail (its shading). */
  readonly baseNormals: BakeJobNormals;
  readonly detailNormals: BakeJobNormals;
  /**
   * Occlusion rays: count, bias in degrees above the tangent plane, reach in meters, and
   * scope - 'group' (only the sample's own group occludes) or 'all' (every group except
   * `exclude`).
   */
  readonly ao: {
    readonly rays: number;
    readonly bias: number;
    /** Reach in meters, or 'auto': per group min(0.1 x its diagonal, 0.5 m). */
    readonly distance: number | 'auto';
    readonly scope: 'group' | 'all';
    readonly exclude: readonly string[];
    /** 'linear' (an occluder at distance t weighs 1 - t / reach) or 'none' (any hit occludes fully). */
    readonly attenuation: 'linear' | 'none';
    /** Height (world y) of a ground plane that occludes too. */
    readonly floor?: number;
    /**
     * Edge-aware denoise radius in texels (0 = off): AO is averaged over texels of its chart
     * whose detail normals agree, so low ray counts stop dominating compressed size.
     */
    readonly denoise: number;
  };
  /**
   * Height storage: `bits` 8 (rgba8) or 16 (r16unorm), and the `[inner, outer]` signed
   * offsets in meters mapped to 0 and 1 (default symmetric around the cage).
   */
  readonly height: { readonly bits: 8 | 16; readonly range?: readonly [number, number] };
  /** Position map normalization: the detail's bounding 'box' per axis, or its bounding 'sphere'. */
  readonly position: { readonly bounds: 'box' | 'sphere' };
  /** Thickness rays into the detail (count, reach in meters or 'auto' = 0.1 x the group diagonal). */
  readonly thickness: { readonly rays: number; readonly distance: number | 'auto' };
  /**
   * Per detail material slot name: its surface (`BakeSlot`); `'*'` is the fallback of
   * every slot without an entry. Material slot names are mesh material names, which the
   * modeling session never names `'*'`, so the key cannot collide with a slot.
   */
  readonly slots: Readonly<Record<string, BakeSlot>>;
  /**
   * Edge wear from texture-space curvature (normalized by its 95th percentile): rises
   * over `range` of convex curvature; `noise` (value noise of `scale` meters, `amount`
   * 0..1) breaks it up.
   */
  readonly edgeWear: {
    readonly range: readonly [number, number];
    readonly noise: { readonly scale: number; readonly amount: number; readonly seed: number };
  };
  /** Cavity: rises over `range` of normalized concave curvature. */
  readonly cavity: { readonly range: readonly [number, number] };
  /** Opacity mips keep the fraction of texels at or above `cutoff` (alpha test). */
  readonly opacity: { readonly cutoff: number };
  /**
   * Atlas wrap per uv axis: `true` joins the opposite borders of the atlas
   * (filtering, gutter and curvature cross them: a cylinder whose uv wraps around); a
   * world vector also repeats the detail by that translation, one period on both sides
   * (a tileable bake).
   */
  readonly wrap?: { readonly u?: true | Tuple3; readonly v?: true | Tuple3 };
  /** Size of the third input (rgba8 texels sampled through the detail's uv0) for `resample`. */
  readonly resample?: { readonly width: number; readonly height: number };
}

/** Axis-aligned box in the bake's units (meters). */
export interface BakeBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** Face ids listed per cluster (the count is always exact). */
export const BAKE_CLUSTER_FACES = 32;

/**
 * Clipped samples of one feature (audit A1). `above`: detail stands past the cage start
 * (`worst` m beyond it, so `offset` is too small); `below`: a ray found nothing and detail lies
 * `worst` m past the cage end (`maxRay` is too short). `bounds` boxes the clipped base samples;
 * `baseFaces` are base mesh faces, `detailFaces` the detail faces that are lost, both ascending.
 */
export interface BakeClipCluster {
  readonly side: 'above' | 'below';
  readonly samples: number;
  readonly worst: number;
  readonly bounds: BakeBounds;
  readonly baseFaces: readonly number[];
  readonly baseFaceCount: number;
  readonly detailFaces: readonly number[];
  readonly detailFaceCount: number;
}

/**
 * Samples that landed on one hovering detail part (audit A3). `part` numbers the group's
 * hovering parts by their lowest detail face; `gap` is the part's smallest distance to the
 * base, `bounds` boxes the whole part and `detailFaces` are its faces.
 */
export interface BakeStrayCluster {
  readonly part: number;
  readonly samples: number;
  readonly gap: number;
  readonly bounds: BakeBounds;
  readonly baseFaces: readonly number[];
  readonly baseFaceCount: number;
  readonly detailFaces: readonly number[];
  readonly detailFaceCount: number;
}

/** One bake group's resolved cage and correspondence statistics (V2). */
export interface BakeGroupReport {
  readonly id: string;
  readonly offset: number;
  readonly maxRay: number;
  /** Base samples (texel samples or vertices) of the group. */
  readonly samples: number;
  readonly rayHits: number;
  /** Samples whose ray missed and took the nearest detail point instead. */
  readonly nearest: number;
  /**
   * Samples with facing detail outside the cage span along their ray (audit A1): within `maxRay`
   * beyond the ray's start, or past its end when the ray found nothing.
   */
  readonly clipped: number;
  /** The clipped samples grouped by feature: neighbouring clipped base samples form one cluster. */
  readonly clipClusters: readonly BakeClipCluster[];
  /**
   * Detail parts hovering off the base farther than the attached detail rises (audit A3): how
   * many, the smallest gap in meters, the samples that landed on them and, per part that
   * caught samples, its cluster.
   */
  readonly stray: {
    readonly parts: number;
    readonly gap: number;
    readonly samples: number;
    readonly clusters: readonly BakeStrayCluster[];
  };
  readonly detailTriangles: number;
  /** Resolved occlusion and thickness reach in meters. */
  readonly aoDistance: number;
  readonly thicknessDistance: number;
  /** Fraction of the group's detail area within 15 degrees of its rays: walls no bake sees (V3). */
  readonly steepArea: number;
}

export interface BakeProvenance {
  /** Texels (or vertices) with a base sample. */
  readonly covered: number;
  readonly rayHits: number;
  /** Samples whose ray missed and took the nearest detail point instead. */
  readonly nearest: number;
  /** Groups in id order (one group '' without `groups`). */
  readonly groups: readonly BakeGroupReport[];
  /** Detail material slots in slot order with their material-id colors. */
  readonly materials: readonly { readonly slot: string; readonly color: readonly number[] }[];
  /** Mean curvature (1 / m) mapped to 0 and 1 of the curvature map. */
  readonly curvatureRange: number;
  /** Signed offsets (m) mapped to 0 and 1 of the height map: [inner, outer]. */
  readonly heightRange: readonly [number, number];
  /** Bounds the position map normalizes by (box min/max; for 'sphere' the box of the sphere). */
  readonly positionBounds: { readonly min: Tuple3; readonly max: Tuple3 };
  /**
   * The emissive map stores linear emission over this scale (the largest slot peak,
   * max channel x intensity, at least 1): a material's emissive intensity.
   */
  readonly emissiveScale: number;
  /**
   * Mip bleed (V4, texture target): per mip level 1.., the 2^level texel blocks that hold
   * a chart's texels and also texels of another chart or of no chart (background).
   */
  readonly bleed: readonly number[];
  /**
   * Stacked UVs (V5, texture bakes): sub-samples a later triangle also covers, those whose
   * tangent-space normals differ by more than 5 degrees or heights by more than 2 % of
   * the height range, the largest angle (degrees) and height gap, and the base face of the
   * first conflicting texel (-1: none).
   */
  readonly stack: BakeStack;
  /**
   * Texture target: samples on base triangles whose corners disagree on tangent
   * handedness (a welded mirror seam: the frame interpolates through w = 0, audit A4), and
   * the smallest such base face (-1: none).
   */
  readonly handedness: BakeHandedness;
}

export interface BakeStack {
  readonly samples: number;
  readonly conflicts: number;
  readonly maxAngle: number;
  /** Largest height gap (meters along the ray) between two stacked samples. */
  readonly maxHeight: number;
  readonly face: number;
}

export interface BakeHandedness {
  readonly samples: number;
  readonly face: number;
}

export interface ComputeJobParams {
  readonly boolean: BooleanJobParams;
  readonly 'uv.chart': UvChartJobParams;
  readonly bake: BakeJobParams;
  readonly 'solve.sparse': SolveSparseParams;
  readonly 'uv.unwrap': UvUnwrapJobParams;
  readonly 'uv.pack': UvPackJobParams;
  readonly region: RegionJobParams;
  readonly subdivide: SubdivideJobParams;
  readonly voxel: VoxelJobParams;
  readonly remesh: RemeshJobParams;
  readonly 'skin.bind': SkinBindJobParams;
}

export type ComputeJobKind = keyof ComputeJobParams;

export const COMPUTE_JOB_KINDS: readonly ComputeJobKind[] = [
  'boolean',
  'region',
  'subdivide',
  'solve.sparse',
  'uv.unwrap',
  'uv.pack',
  'voxel',
  'remesh',
  'skin.bind',
  'uv.chart',
  'bake',
];

/**
 * Per output face (in the output's FXEM face order): the input operand, the face of
 * that operand's FXEM and the triangle of the face's canonical triangulation
 * (`jobTriangles`) the output face lies in.
 */
export interface FaceProvenance {
  readonly operand: Uint8Array;
  readonly face: Int32Array;
  readonly triangle: Int32Array;
}

/** Per output face (in the output's FXEM face order): the input FXEM face it refines. */
export interface SourceFaceProvenance {
  readonly face: Int32Array;
}

/**
 * Per output ring (shapes in order, outline first): for each edge the input operand,
 * the ring of that operand (outlines and holes in input order) and its edge, or -1
 * for edges an offset join or cap created.
 */
export interface EdgeProvenance {
  readonly operand: Uint8Array;
  readonly ring: Int32Array;
  readonly edge: Int32Array;
}

/** Distortion of one UV island against its 3D surface. */
export interface UvIslandMetrics {
  readonly faces: number;
  readonly area3d: number;
  readonly areaUv: number;
  /** Area-normalized Sander L2 stretch; 1 is isometric up to scale. */
  readonly stretchL2: number;
  /** Area-normalized Sander L-infinity stretch (largest singular value). */
  readonly stretchLinf: number;
  /** Largest per-triangle max(rho, 1 / rho) of relative areas, clipped at 100. */
  readonly areaDistortion: number;
  readonly flipped: number;
  readonly zeroArea: number;
  readonly iterations: number;
  readonly residual: number;
  /** With `refine`: pairs of the island's own triangles that overlap in UV (exact predicates). */
  readonly overlaps?: number;
  /** With `refine`: how the SLIM refinement ended (`rectified` islands are not refined). */
  readonly refineStatus?: UvRefineStatus;
  /** With `refine`: SLIM iterations spent (0 when none ran). */
  readonly refineIterations?: number;
  /** With `refine`: flipped plus zero-area triangles of the layout before refinement. */
  readonly flippedBefore?: number;
  /** With `refine`: symmetric Dirichlet energy per 3D area (4 is isometric) before; absent when folded. */
  readonly energyBefore?: number;
  /** With `refine`: the same energy of the layout the island kept. */
  readonly energyAfter?: number;
}

/** accepted: refined layout kept; the others name the gate that kept the start (`unavailable`: SLIM could not run). */
export type UvRefineStatus =
  | 'accepted'
  | 'flipped'
  | 'no-gain'
  | 'overlap'
  | 'density'
  | 'unavailable'
  | 'rectified';

/** Per job face (FXEM face order): its island; plus per island facts in island order. */
export interface UvIslandProvenance {
  readonly faceIsland: Int32Array;
  readonly islands: readonly UvIslandMetrics[];
}

/** Where pack put an island: texel rectangle (padding included) and quarter turns. */
export interface UvPlacement {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly turned: boolean;
  /** Raster: the island's turn in degrees after its minimal-rectangle orientation. */
  readonly angle?: number;
  /** Stacked: the island whose placement this one shares. */
  readonly leader?: number;
}

export interface UvPackProvenance {
  readonly faceIsland: Int32Array;
  readonly placements: readonly UvPlacement[];
}

export interface ComputeJobProvenance {
  readonly boolean: readonly FaceProvenance[];
  readonly region: readonly EdgeProvenance[];
  readonly subdivide: readonly SourceFaceProvenance[];
  readonly 'solve.sparse': null;
  readonly 'uv.unwrap': UvIslandProvenance;
  readonly 'uv.pack': UvPackProvenance;
  /** Per output face: the input FXEM face it came from (nearest face for voxel surfaces), or -1. */
  readonly voxel: readonly SourceFaceProvenance[];
  readonly remesh: readonly SourceFaceProvenance[];
  readonly 'skin.bind': null;
  readonly 'uv.chart': UvChartProvenance;
  readonly bake: BakeProvenance;
}

export type ComputePolicy = 'auto' | 'ts' | 'native';
export type ComputeBackendName = 'ts' | 'native';
export type ComputeQuality = 'baseline' | 'production';

export interface ComputeJobRequest<K extends ComputeJobKind = ComputeJobKind> {
  readonly kind: K;
  /**
   * Canonical FXEM snapshots (`boolean`, `uv.*`, `remesh`, `voxel`, `bake` base and
   * detail, then the optional resample texels), an `encodeSdf` grid plus optionally its
   * source FXEM for sharp normals (`voxel` operation `mesh`), `encodeRegion` bytes
   * (`region`), or
   * for `solve.sparse` FXCS CSR bytes, the right-hand side and an optional initial
   * guess (little-endian float64, see `encodeCsr`); one FXEM for `skin.bind`.
   */
  readonly inputs: readonly Uint8Array[];
  readonly params: ComputeJobParams[K];
}

/** Why part of a `partial` result is wrong, and where. */
export type ComputeLocationReason =
  | 'open-edge'
  | 'non-manifold-edge'
  | 'unmapped-face'
  | 'volume'
  | 'merge'
  | 'unreached';

export interface ComputeLocation {
  readonly reason: ComputeLocationReason;
  readonly position: Tuple3;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** What a backend returns; the job runner adds the report identity fields. */
export interface BackendOutput<K extends ComputeJobKind> {
  readonly status: 'ok' | 'partial';
  readonly outputs: readonly Uint8Array[];
  readonly provenance: ComputeJobProvenance[K];
  readonly metrics: Readonly<Record<string, number>>;
  readonly locations: readonly ComputeLocation[];
}

export interface ComputeJobReport {
  readonly backend: ComputeBackendName;
  readonly backendIdentity: string;
  readonly quality: ComputeQuality;
  /** DDC key: sha256 of kind, canonical inputs, canonical params and backend identity. */
  readonly cacheKey: string;
  readonly metrics: Readonly<Record<string, number>>;
}

/**
 * Status `failed` is the error branch of the Result (a `ModelingError` whose detail
 * carries the backend); `ok` and `partial` carry outputs.
 */
export interface ComputeJobResult<K extends ComputeJobKind = ComputeJobKind>
  extends Omit<BackendOutput<K>, 'metrics'> {
  readonly report: ComputeJobReport;
}

/** Work budget and cooperative cancellation shared by every backend loop. */
export class WorkMeter {
  units = 0;
  failure: ModelingError | undefined;
  readonly budget: number;
  private readonly signal: { readonly aborted: boolean } | undefined;

  constructor(budget: number, signal?: { readonly aborted: boolean }) {
    this.budget = budget;
    this.signal = signal;
  }

  /** Spend work units; false once the budget is exceeded or the signal aborted. */
  spend(units: number): boolean {
    if (this.failure !== undefined) return false;
    const before = this.units;
    this.units += units;
    if (this.units > this.budget) {
      this.failure = modelingError(
        'model-work-budget',
        `the job stays within ${this.budget} work units`,
        { units: this.units },
        'reduce the operand detail, raise budget.work, or use the native backend (forgeax toolchain install modeling) when it is available',
      );
      return false;
    }
    if (this.signal?.aborted === true && (before === 0 || before >> 8 !== this.units >> 8)) {
      this.failure = modelingError('model-cancelled', 'the build is not cancelled', {});
      return false;
    }
    return true;
  }
}

export interface ComputeBackend {
  readonly name: ComputeBackendName;
  /** Kernel version for the TS baseline; tool version, lock and platform for native. */
  readonly identity: string;
  supports(kind: ComputeJobKind): boolean;
  quality(kind: ComputeJobKind): ComputeQuality;
  run<K extends ComputeJobKind>(
    request: ComputeJobRequest<K>,
    work: WorkMeter,
  ): Result<BackendOutput<K>, ModelingError>;
}

export interface ComputeOptions {
  readonly policy?: ComputePolicy;
  /** Host-injected native backend (design X6); absent until the toolchain is installed. */
  readonly native?: ComputeBackend;
  readonly signal?: { readonly aborted: boolean };
  /** Work units before `model-work-budget` (default DEFAULT_WORK_BUDGET). */
  readonly budget?: number;
  /**
   * Host result store (a build DDC) keyed by `computeCacheKey`: a verified entry is
   * returned instead of running the job, byte-identical to a run; a corrupt one is rerun.
   */
  readonly cache?: ByteCache;
}

export const DEFAULT_WORK_BUDGET = 200_000_000;

const NATIVE_HINT =
  "install the native modeling toolchain (forgeax toolchain install modeling), or use compute: 'auto' to fall back to the TypeScript baseline";

/**
 * Canonical text of a job's params. Numbers JSON cannot tell apart keep distinct tokens
 * (-0, NaN, +-Infinity; bare words never collide with the quoted strings or null), and
 * values outside the plain-JSON model carry a type tag, so two different requests never
 * share a key. `plainParamsFault` is the gate that rejects the latter before a run.
 */
function canonicalJson(value: unknown, path: object[] = []): string {
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function' || typeof value === 'symbol') return `<${typeof value}>`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (path.includes(value)) return '<cycle>';
  const next = [...path, value];
  const each = (v: unknown) => canonicalJson(v, next);
  if (Array.isArray(value)) return `[${value.map(each).join(',')}]`;
  if (value instanceof Map) return `Map[${[...value].map((e) => each(e)).join(',')}]`;
  if (value instanceof Set) return `Set[${[...value].map(each).join(',')}]`;
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return `${value.constructor.name}<${Array.from(bytes).join(',')}>`;
  }
  const primitive = value.valueOf();
  if (primitive !== value) return `${value.constructor.name}(${each(primitive)})`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const tag =
    Object.getPrototypeOf(value) === Object.prototype ? '' : String(value.constructor?.name);
  return `${tag}{${entries.map(([k, v]) => `${JSON.stringify(k)}:${each(v)}`).join(',')}}`;
}

/** Path of the first param outside plain JSON (objects, arrays, strings, numbers, booleans, null). */
function plainParamsFault(value: unknown, path: object[] = [], at = 'params'): string | undefined {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return undefined;
  if (typeof value !== 'object') return at;
  if (path.includes(value)) return at;
  const next = [...path, value];
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const fault = plainParamsFault(value[i], next, `${at}[${i}]`);
      if (fault !== undefined) return fault;
    }
    return undefined;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return at;
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const fault = plainParamsFault(v, next, `${at}.${k}`);
    if (fault !== undefined) return fault;
  }
  return undefined;
}

function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    const c = char.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** DDC key of a job on one backend (design 4.1 cache row). */
export function computeCacheKey(request: ComputeJobRequest, backendIdentity: string): string {
  const head = utf8(
    canonicalJson({
      kind: request.kind,
      params: request.params,
      backend: backendIdentity,
      inputs: request.inputs.map((b) => b.length),
    }),
  );
  const total = head.length + request.inputs.reduce((n, b) => n + b.length, 0);
  const bytes = new Uint8Array(total);
  bytes.set(head);
  let offset = head.length;
  for (const input of request.inputs) {
    bytes.set(input, offset);
    offset += input.length;
  }
  return sha256(bytes);
}

/**
 * Resolve the backend for a policy: `ts` always takes the baseline, `native` requires
 * the native backend (`model-capability-unavailable` otherwise), `auto` prefers native
 * when it is available and supports the kind.
 */
export function resolveBackend(
  kind: ComputeJobKind,
  policy: ComputePolicy,
  ts: ComputeBackend,
  native: ComputeBackend | undefined,
): Result<ComputeBackend, ModelingError> {
  const ready = native?.supports(kind) === true ? native : undefined;
  switch (policy) {
    case 'ts':
      return ok(ts);
    case 'native':
      if (ready === undefined) {
        return err(
          modelingError(
            'model-capability-unavailable',
            `a native compute backend for '${kind}' is installed`,
            { kind, policy, backend: 'native' },
            NATIVE_HINT,
          ),
        );
      }
      return ok(ready);
    case 'auto':
      return ok(ready ?? ts);
  }
}

/** Run one compute job on the resolved backend under its budget and signal. */
export function runComputeJob<K extends ComputeJobKind>(
  request: ComputeJobRequest<K>,
  ts: ComputeBackend,
  options: ComputeOptions = {},
): Result<ComputeJobResult<K>, ModelingError> {
  if (!COMPUTE_JOB_KINDS.includes(request.kind)) {
    return err(
      modelingError('model-invalid-argument', `kind is one of ${COMPUTE_JOB_KINDS.join(', ')}`, {
        kind: request.kind,
      }),
    );
  }
  const fault = plainParamsFault(request.params);
  if (fault !== undefined) {
    return err(
      modelingError(
        'model-invalid-argument',
        'params are plain JSON values (objects, arrays, strings, numbers, booleans, null)',
        { kind: request.kind, at: fault },
      ),
    );
  }
  const backend = resolveBackend(request.kind, options.policy ?? 'auto', ts, options.native);
  if (!backend.ok) return backend;
  const chosen = backend.value;
  const budget = options.budget ?? DEFAULT_WORK_BUDGET;
  const cacheKey = computeCacheKey(request, chosen.identity);
  const report = (metrics: Readonly<Record<string, number>>): ComputeJobReport => ({
    backend: chosen.name,
    backendIdentity: chosen.identity,
    quality: chosen.quality(request.kind),
    cacheKey,
    metrics,
  });
  // A cancelled or over-budget run fails; serving its cached result would not.
  const cache = options.signal?.aborted === true ? undefined : options.cache;
  const hit = cache === undefined ? undefined : decodeJobEntry(cacheKey, cache.get(cacheKey));
  if (hit !== undefined && (hit.metrics.work as number) <= budget) {
    const { metrics, ...rest } = hit;
    return ok({ ...(rest as Omit<BackendOutput<K>, 'metrics'>), report: report(metrics) });
  }
  const work = new WorkMeter(budget, options.signal);
  let out: Result<BackendOutput<K>, ModelingError>;
  try {
    out = chosen.run(request, work);
  } catch (cause) {
    out = err(
      modelingError('model-internal', 'the job runs without a kernel fault', {
        cause: String((cause as Error)?.message ?? cause).slice(0, 500),
      }),
    );
  }
  if (!out.ok) {
    const cause = out.error;
    return err(
      modelingError(
        cause.code,
        cause.expected,
        {
          ...cause.detail,
          backend: chosen.name,
          backendIdentity: chosen.identity,
          work: work.units,
        },
        cause.hint,
      ),
    );
  }
  const { metrics, ...rest } = out.value;
  const done = { ...metrics, work: work.units };
  if (cache !== undefined) {
    const entry = encodeJobEntry(cacheKey, { ...rest, metrics: done });
    if (entry !== undefined) cache.put(cacheKey, entry);
  }
  return ok({ ...rest, report: report(done) });
}
