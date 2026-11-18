import {
  canonicalJson,
  err,
  ok,
  type Result,
  sha256,
  WATER_BODY_DEFAULT_SHAPE_DILATION_M,
  type WaterBrushBodyActor,
  type WaterBrushIslandActor,
} from '@forgeax/engine-types';
import type { WaterBrushRecipeAsset, WaterError } from './contracts.js';
import { WATER_DEFAULT_BRUSH_CURVE_SHA256 } from './default-water-brush-curve.js';
import { requireWaterValue } from './required-value.js';
import { validateWaterAsset } from './validate.js';

export const WATER_DEFAULT_BRUSH_CURVE_KEY = 'water-default:/elevation-curve/1' as const;
export const WATER_BRUSH_REQUIRED_SHADER_VERSIONS = [
  'capture',
  'detectEdges',
  'blurEdges',
  'jumpFlood',
  'cacheDistanceField',
  'heightComposite',
  'weightComposite',
  'velocityHeightComposite',
  'terrainReadback',
] as const;

export type WaterBrushTextureLayout = Readonly<{
  name: string;
  widthPx: number;
  heightPx: number;
  format:
    | 'r32float'
    | 'rgba8unorm'
    | 'r8unorm'
    | 'rg16float'
    | 'rgba16float'
    | 'rg32float'
    | 'rgba32float'
    | 'r16float';
  origin: 'row-0-is-min-z';
  channels: readonly string[];
  temporary: boolean;
}>;

export type WaterBrushActorPassPlan = Readonly<{
  actorId: string;
  blurPassCount: number;
  jumpFloodPassCount: number;
  jfaStepOffsets: readonly number[];
  jumpFloodExecutedFinalTarget: 'jump-flood-a' | 'jump-flood-b';
  jumpFloodCacheSelectedTarget: 'jump-flood-a' | 'jump-flood-b';
  jumpFloodCachePassIndex: number;
  jumpFloodCacheParity: 0 | 1;
  jumpFloodCacheTarget: 'jump-flood-a' | 'jump-flood-b';
  heightRead: 'height-ping' | 'height-pong';
  heightWrite: 'height-ping' | 'height-pong';
  velocityHeightRead?: 'combined-velocity-height-a' | 'combined-velocity-height-b';
  velocityHeightWrite?: 'combined-velocity-height-a' | 'combined-velocity-height-b';
  bodyComposite?: WaterBrushBodyCompositeSettings;
  weightPasses: readonly Readonly<{ layerName: string; read: string; write: string }>[];
  heightBlend: 'alpha' | 'min' | 'max' | 'additive';
  weightLayerNames: readonly string[];
}>;

export type WaterBrushManifestInitialization = Readonly<{
  heightInput: 'base-combined-result';
  weightInput: 'base-combined-result';
  velocityHeightClearM: readonly [0, 0, -163.84, 1];
  velocityHeightUnits: 'meters';
  jumpFloodClear: readonly [0, 0, 0, 0];
  jumpFloodClearMeaning: 'no edge seed';
}>;

export type WaterBrushShaderConstants = Readonly<{
  falloffAngleClampDegrees: readonly [1, 89];
  falloffWidthMinimumM: 0.001;
  weightFalloffWidthMinimumM: 0.001;
  smoothBlendDistanceMinimumM: 0.0001;
  terracingSmoothnessInput: 'spacingM-blue-channel';
}>;

/** Versioned WaterBrush defaults shared by every recipe. */
export type WaterBrushManagerDefaults = Readonly<{
  version: 'water-brush-defaults/2';
  canvasSegmentSizeM: 10.24;
  splineMeshExtensionM: 0;
}>;

export type WaterBrushBodyCompositeSettings = Readonly<{
  canvasSegmentSizeM: number;
  splineMeshExtensionM: number;
  shapeDilationM: number;
}>;

export type WaterBrushActorCacheManifest = Readonly<{
  actorId: string;
  actorCapture:
    | Readonly<{
        kind: 'body';
        bodyGuid: string;
        bodyType: 'ocean' | 'lake' | 'river' | 'custom';
        spline: WaterBrushSplineSnapshot;
      }>
    | Readonly<{
        kind: 'island';
        sourceKey: string;
        heightOffsetM: number;
        spline: Extract<
          WaterBrushRecipeAsset['orderedActors'][number],
          { kind: 'island' }
        >['spline'];
      }>;
  inputDigest: string;
  sourceInputDigest: string;
  captureProvenance: WaterBrushCaptureProvenance;
  cacheKey: string;
  textures: readonly string[];
}>;

export type WaterBrushBodySegmentMesh = Readonly<{
  segmentIndex: number;
  meshGuid: string;
  meshDigest: string;
}>;
type WaterBrushBodyCaptureBase = Readonly<{
  source: 'pack-mesh';
  sourcePayloadDigest: string;
  worldMatrixM: readonly number[];
  depthVelocityDigest: string;
}>;
export type WaterBrushBodyCaptureProvenance = WaterBrushBodyCaptureBase &
  (
    | Readonly<{ meshGuid: string; meshDigest: string; riverSegmentMeshes?: never }>
    | Readonly<{
        meshGuid?: never;
        meshDigest?: never;
        riverSegmentMeshes: readonly WaterBrushBodySegmentMesh[];
      }>
  );
export type WaterBrushIslandCaptureProvenance = Readonly<{
  source: 'island-spline';
  splineDigest: string;
  shapeMeshDigest: string;
  shapeGeneratorVersion: string;
  worldMatrixM: readonly number[];
  depthVelocityDigest: string;
}>;
export type WaterBrushCaptureProvenance =
  | WaterBrushBodyCaptureProvenance
  | WaterBrushIslandCaptureProvenance;

export type WaterBrushTerrainManifest = Readonly<{
  version: 2;
  recipeDigest: string;
  baseTerrainDigest: string;
  terrainCapture: WaterBrushRecipeAsset['terrainCapture'];
  pixelCenterMapping: Readonly<{
    originLocalXZ: readonly [number, number];
    stepLocalXZ: readonly [number, number];
    originWorldM: readonly [number, number, number];
    stepWorldXM: readonly [number, number, number];
    stepWorldZM: readonly [number, number, number];
  }>;
  textures: readonly WaterBrushTextureLayout[];
  shaderVersions: WaterBrushManifestInputs['shaderVersions'];
  actorCaches: readonly WaterBrushActorCacheManifest[];
  actorPassPlan: readonly WaterBrushActorPassPlan[];
  terrainReadbackLayout: Readonly<{
    heightTexture: string;
    weightTexturesByLayer: Readonly<Record<string, string>>;
  }>;
  initialization: WaterBrushManifestInitialization;
  shaderConstants: WaterBrushShaderConstants;
  managerDefaults: WaterBrushManagerDefaults;
  cacheKey: string;
}>;

export type WaterBrushManifestInputs = Readonly<{
  /** Content digest of the immutable base Terrain source payload. */
  baseTerrainDigest: string;
  /** Frozen Brush capture projection digest keyed by actor id. Body projection omits shapeDilationM and its derived dilatedWaterInfoMeshGuid. */
  actorInputDigests: Readonly<Record<string, string>>;
  /** Runtime-resolved identities checked against authored labels before body ordering. */
  actorIdentities: Readonly<Record<string, WaterBrushResolvedActorIdentity>>;
  /** Digests of referenced curve and texture payloads, keyed by GUID. */
  dependencyDigests: Readonly<Record<string, string>>;
  shaderVersions: Readonly<Record<string, string>>;
}>;

type WaterBrushSplineSnapshot = Extract<
  WaterBrushRecipeAsset['orderedActors'][number],
  { kind: 'island' }
>['spline'];

/** Exclude composite-only dilation and its derived dilated WaterInfo mesh reference. */
export function waterBrushBodyCaptureInputDigest(
  body: import('./contracts.js').WaterBodyAsset,
): string {
  const {
    shapeDilationM: _shapeDilationM,
    dilatedWaterInfoMeshGuid: _dilatedWaterInfoMeshGuid,
    ...captureBody
  } = body;
  return sha256(canonicalJson(captureBody));
}

export function waterBrushDepthVelocityDigest(spline: WaterBrushSplineSnapshot): string {
  return sha256(
    canonicalJson(
      spline.points.map(
        ({ inputKey, positionM, arriveTangentM, leaveTangentM, depthM, velocityMPerSec }) => ({
          inputKey,
          positionM,
          arriveTangentM,
          leaveTangentM,
          depthM,
          velocityMPerSec,
        }),
      ),
    ),
  );
}

export type WaterBrushResolvedActorIdentity =
  | Readonly<{
      kind: 'body';
      bodyGuid: string;
      bodyType: 'ocean' | 'lake' | 'river' | 'custom';
      fullName: string;
      shapeDilationM: number;
      spline: Extract<WaterBrushRecipeAsset['orderedActors'][number], { kind: 'island' }>['spline'];
      captureProvenance: WaterBrushBodyCaptureProvenance;
    }>
  | Readonly<{
      kind: 'island';
      sourceKey: string;
      fullName: string;
      captureProvenance: WaterBrushIslandCaptureProvenance;
    }>;

export function waterBrushIslandSplineDigest(
  spline: Extract<WaterBrushRecipeAsset['orderedActors'][number], { kind: 'island' }>['spline'],
): string {
  return sha256(canonicalJson(spline));
}

const invalid = (expected: string, detail?: unknown): WaterError => ({
  code: 'invalid-source',
  expected,
  hint: 'repair the frozen Brush recipe inputs and build the manifest again',
  ...(detail === undefined ? {} : { detail }),
});

function actorId(actor: WaterBrushRecipeAsset['orderedActors'][number]): string {
  return typeof actor === 'string'
    ? actor
    : (actor.actorId ?? ('sourceKey' in actor ? actor.sourceKey : actor.bodyGuid));
}

function cacheCurveKey(actor: WaterBrushRecipeAsset['orderedActors'][number]): string {
  return typeof actor === 'string'
    ? WATER_DEFAULT_BRUSH_CURVE_KEY
    : (actor.rules?.curves.elevationCurveGuid ?? WATER_DEFAULT_BRUSH_CURVE_KEY);
}

function isBodyActor(
  actor: WaterBrushRecipeAsset['orderedActors'][number],
): actor is WaterBrushBodyActor {
  return typeof actor !== 'string' && actor.kind === 'body';
}

function validCapturePose(
  value: WaterBrushCaptureProvenance | undefined,
): value is WaterBrushCaptureProvenance {
  if (
    value === undefined ||
    !/^[0-9a-f]{64}$/i.test(value.depthVelocityDigest) ||
    value.worldMatrixM.length !== 16 ||
    !value.worldMatrixM.every(Number.isFinite) ||
    Math.abs(requireWaterValue(value.worldMatrixM[3])) > 1e-7 ||
    Math.abs(requireWaterValue(value.worldMatrixM[7])) > 1e-7 ||
    Math.abs(requireWaterValue(value.worldMatrixM[11])) > 1e-7 ||
    Math.abs(requireWaterValue(value.worldMatrixM[15]) - 1) > 1e-7
  )
    return false;
  const m = value.worldMatrixM;
  const determinant =
    requireWaterValue(m[0]) *
      (requireWaterValue(m[5]) * requireWaterValue(m[10]) -
        requireWaterValue(m[9]) * requireWaterValue(m[6])) -
    requireWaterValue(m[4]) *
      (requireWaterValue(m[1]) * requireWaterValue(m[10]) -
        requireWaterValue(m[9]) * requireWaterValue(m[2])) +
    requireWaterValue(m[8]) *
      (requireWaterValue(m[1]) * requireWaterValue(m[6]) -
        requireWaterValue(m[5]) * requireWaterValue(m[2]));
  return Number.isFinite(determinant) && Math.abs(determinant) > 1e-12;
}

function validCaptureProvenance(
  value: WaterBrushCaptureProvenance | undefined,
  actor: WaterBrushBodyActor | WaterBrushIslandActor,
  identity?: WaterBrushResolvedActorIdentity,
): boolean {
  if (!validCapturePose(value)) return false;
  const validBodyProvenance = (): boolean => {
    if (actor.kind === 'body') {
      if (
        value.source !== 'pack-mesh' ||
        !/^[0-9a-f]{64}$/i.test(value.sourcePayloadDigest) ||
        identity?.kind !== 'body'
      )
        return false;
      const validMesh = (mesh: WaterBrushBodySegmentMesh) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mesh.meshGuid) &&
        /^[0-9a-f]{64}$/i.test(mesh.meshDigest);
      if (value.depthVelocityDigest !== waterBrushDepthVelocityDigest(identity.spline))
        return false;
      if (actor.bodyType !== 'river')
        return (
          value.riverSegmentMeshes === undefined &&
          value.meshGuid !== undefined &&
          value.meshDigest !== undefined &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.meshGuid) &&
          /^[0-9a-f]{64}$/i.test(value.meshDigest)
        );
      const segmentCount = identity.spline.closed
        ? identity.spline.points.length
        : identity.spline.points.length - 1;
      return (
        value.meshGuid === undefined &&
        value.meshDigest === undefined &&
        value.depthVelocityDigest === waterBrushDepthVelocityDigest(identity.spline) &&
        Array.isArray(value.riverSegmentMeshes) &&
        value.riverSegmentMeshes.length === segmentCount &&
        value.riverSegmentMeshes.every(
          (mesh, index) => mesh.segmentIndex === index && validMesh(mesh),
        ) &&
        new Set(value.riverSegmentMeshes.map((mesh) => mesh.meshGuid.toLowerCase())).size ===
          segmentCount
      );
    }
    return false;
  };
  if (actor.kind === 'body') return validBodyProvenance();

  return (
    value.source === 'island-spline' &&
    value.splineDigest === sha256(canonicalJson(actor.spline)) &&
    value.depthVelocityDigest === waterBrushDepthVelocityDigest(actor.spline) &&
    /^[0-9a-f]{64}$/i.test(value.shapeMeshDigest) &&
    typeof value.shapeGeneratorVersion === 'string' &&
    value.shapeGeneratorVersion.trim().length > 0
  );
}

function compareBodyActors(
  left: WaterBrushRecipeAsset['orderedActors'][number],
  right: WaterBrushRecipeAsset['orderedActors'][number],
): number {
  if (
    typeof left === 'string' ||
    typeof right === 'string' ||
    left.kind === 'island' ||
    right.kind === 'island'
  )
    return 0;
  const group = (actor: typeof left | typeof right): number =>
    ({ ocean: 0, lake: 1, river: 2, custom: 3 })[actor.bodyType];
  const groupDiff = group(left) - group(right);
  if (groupDiff !== 0) return groupDiff;
  const name = (actor: typeof left | typeof right): string => actor.fullName;
  const a = name(left),
    b = name(right);
  return a < b
    ? -1
    : a > b
      ? 1
      : actorId(left) < actorId(right)
        ? -1
        : actorId(left) > actorId(right)
          ? 1
          : 0;
}

function inputMatrix(capture: WaterBrushRecipeAsset['terrainCapture']): readonly number[] {
  return capture.worldMatrixM;
}

function worldVector(
  matrix: readonly number[],
  x: number,
  z: number,
  translate: boolean,
): [number, number, number] {
  const w = translate ? 1 : 0;
  return [
    requireWaterValue(matrix[0]) * x +
      requireWaterValue(matrix[8]) * z +
      requireWaterValue(matrix[12]) * w,
    requireWaterValue(matrix[1]) * x +
      requireWaterValue(matrix[9]) * z +
      requireWaterValue(matrix[13]) * w,
    requireWaterValue(matrix[2]) * x +
      requireWaterValue(matrix[10]) * z +
      requireWaterValue(matrix[14]) * w,
  ];
}

/** Build deterministic, RHI-independent cache/layout inputs for the Render executor. */
function isPublishedBrushActor(
  actor: WaterBrushRecipeAsset['orderedActors'][number],
): actor is WaterBrushBodyActor | WaterBrushIslandActor {
  return (
    typeof actor !== 'string' &&
    (actor.kind === 'body' ||
      (actor.rules !== undefined &&
        actor.fullName !== undefined &&
        actor.heightOffsetM !== undefined))
  );
}
export function buildWaterBrushTerrainManifest(
  recipe: WaterBrushRecipeAsset,
  inputs: WaterBrushManifestInputs,
): Result<WaterBrushTerrainManifest, WaterError> {
  const checked = validateWaterAsset(recipe);
  if (!checked.ok || checked.value.kind !== 'water-brush-recipe')
    return err(
      invalid(
        'validated WaterBrushRecipe asset with frozen Terrain capture',
        checked.ok ? checked.value.kind : checked.error,
      ),
    );
  if (recipe.actorVersion !== 1 || recipe.orderedActors.some((actor) => typeof actor === 'string'))
    return err(
      invalid(
        'migrate WaterBrushRecipe v0 actors to typed v1 records before building the manifest',
      ),
    );
  const validateInputs = (): Result<void, WaterError> => {
    for (const name of WATER_BRUSH_REQUIRED_SHADER_VERSIONS) {
      if (
        typeof inputs.shaderVersions[name] !== 'string' ||
        requireWaterValue(inputs.shaderVersions[name]).trim().length === 0
      ) {
        return err(
          invalid(
            'stable non-empty versions for every Brush capture, JFA, cache, composition and readback shader',
            name,
          ),
        );
      }
    }
    const actorIds = new Set<string>();
    for (const actor of recipe.orderedActors) {
      if (!isPublishedBrushActor(actor))
        return err(invalid('typed v1 actor records before constructing Brush pass order', actor));
      const id = actorId(actor);
      if (actorIds.has(id))
        return err(invalid('globally unique stable actor identifiers before body sorting', id));
      actorIds.add(id);
      const identity = inputs.actorIdentities[id];
      const invalidActorIdentity = (): boolean =>
        !identity ||
        identity.kind !== actor.kind ||
        identity.fullName !== actor.fullName ||
        (actor.kind === 'body' &&
          (!('bodyGuid' in identity) ||
            identity.bodyGuid !== actor.bodyGuid ||
            identity.bodyType !== actor.bodyType)) ||
        (actor.kind === 'island' &&
          (!('sourceKey' in identity) || identity.sourceKey !== actor.sourceKey)) ||
        (actor.kind === 'body' &&
          identity.kind === 'body' &&
          (!Number.isFinite(identity.shapeDilationM) || identity.shapeDilationM < 0)) ||
        !validCaptureProvenance(identity.captureProvenance, actor, identity);
      if (invalidActorIdentity()) {
        return err(
          invalid(
            'resolved actor identity and capture provenance (mesh GUID/digest, invertible pose, depth/velocity digest) match the frozen actor before body sorting',
            { actorId: id, authored: actor, resolved: identity },
          ),
        );
      }
    }

    return ok(undefined);
  };
  const admittedInputs = validateInputs();
  if (!admittedInputs.ok) return admittedInputs;
  const publishedActors = recipe.orderedActors.filter(isPublishedBrushActor);
  const orderedActors = [
    ...publishedActors.filter(isBodyActor).sort(compareBodyActors),
    // Islands retain registration order independently of the WaterBody priority sort.
    ...publishedActors.filter((actor): actor is WaterBrushIslandActor => actor.kind === 'island'),
  ];
  const normalizedRecipe = { ...recipe, orderedActors };
  const capture = recipe.terrainCapture;
  const [widthPx, heightPx] = capture.resolutionPx;
  const [minX, minZ] = capture.boundsXZ.minM;
  const [maxX, maxZ] = capture.boundsXZ.maxM;
  const stepX = (maxX - minX) / widthPx;
  const stepZ = (maxZ - minZ) / heightPx;
  const centerOriginX = minX + stepX * 0.5;
  const centerOriginZ = minZ + stepZ * 0.5;
  const matrix = inputMatrix(capture);
  const mapping = {
    originLocalXZ: [centerOriginX, centerOriginZ] as const,
    stepLocalXZ: [stepX, stepZ] as const,
    originWorldM: worldVector(matrix, centerOriginX, centerOriginZ, true),
    stepWorldXM: worldVector(matrix, stepX, 0, false),
    stepWorldZM: worldVector(matrix, 0, stepZ, false),
  };
  const maxDimension = Math.max(widthPx, heightPx);
  const jumpFloodPassCount = Math.ceil(Math.log2(maxDimension));
  const jfaStepOffsets = Array.from(
    { length: jumpFloodPassCount },
    (_, pass) => 2 ** (jumpFloodPassCount - pass - 1),
  );
  const prepareTextureLayout = () => {
    const hasBodyActors = orderedActors.some(isBodyActor);
    const textures: WaterBrushTextureLayout[] = [
      ...(hasBodyActors
        ? [
            {
              name: 'combined-velocity-height-a',
              widthPx,
              heightPx,
              format: 'rgba16float' as const,
              origin: 'row-0-is-min-z' as const,
              channels: ['velocity-x', 'velocity-y', 'velocity-z', 'height'],
              temporary: true,
            },
            {
              name: 'combined-velocity-height-b',
              widthPx,
              heightPx,
              format: 'rgba16float' as const,
              origin: 'row-0-is-min-z' as const,
              channels: ['velocity-x', 'velocity-y', 'velocity-z', 'height'],
              temporary: true,
            },
          ]
        : []),
      {
        name: 'height-ping',
        widthPx,
        heightPx,
        format: 'rgba8unorm',
        origin: 'row-0-is-min-z',
        channels: ['packed height R', 'packed height G', 'packed height B', 'packed height A'],
        temporary: true,
      },
      {
        name: 'height-pong',
        widthPx,
        heightPx,
        format: 'rgba8unorm',
        origin: 'row-0-is-min-z',
        channels: ['packed height R', 'packed height G', 'packed height B', 'packed height A'],
        temporary: true,
      },
      {
        name: 'terrain-output-height-m',
        widthPx,
        heightPx,
        format: 'r32float',
        origin: 'row-0-is-min-z',
        channels: ['decoded composite Terrain height in meters'],
        temporary: true,
      },
    ];
    for (const [layerName] of Object.entries(capture.layerNameToIndex).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      textures.push({
        name: `weight:${layerName}:ping`,
        widthPx,
        heightPx,
        format: 'r8unorm',
        origin: 'row-0-is-min-z',
        channels: [`${layerName} weight`],
        temporary: true,
      });
      textures.push({
        name: `weight:${layerName}:pong`,
        widthPx,
        heightPx,
        format: 'r8unorm',
        origin: 'row-0-is-min-z',
        channels: [`${layerName} weight`],
        temporary: true,
      });
    }
    for (const guid of [...recipe.curves, ...recipe.textures]) {
      const digest = inputs.dependencyDigests[guid];
      if (!/^[0-9a-f]{64}$/i.test(digest ?? ''))
        return err(invalid('sha256 digest for every referenced curve/texture payload', guid));
    }
    for (const guid of [...recipe.curves].sort())
      textures.push({
        name: `curve-lut:${guid}`,
        widthPx: 256,
        heightPx: 1,
        format: 'r16float',
        origin: 'row-0-is-min-z',
        channels: [`CurveFloat(${guid}) at i/255`],
        temporary: false,
      });

    return ok(textures);
  };
  const textureLayout = prepareTextureLayout();
  if (!textureLayout.ok) return textureLayout;
  const textures = textureLayout.value;
  const actorPassPlan: WaterBrushActorPassPlan[] = [];
  const managerDefaults: WaterBrushManagerDefaults = Object.freeze({
    version: 'water-brush-defaults/2',
    canvasSegmentSizeM: 10.24,
    splineMeshExtensionM: 0,
  });
  const prepareActorPasses = () => {
    let heightIndex = 0;
    let velocityHeightIndex = 0;
    const weightIndices = new Map<string, number>();
    const prepareActorPass = (actor: WaterBrushBodyActor | WaterBrushIslandActor): boolean => {
      const id = actorId(actor);
      const bodyActor = isBodyActor(actor);
      const settings = typeof actor === 'string' ? undefined : actor.rules;
      const blurPassCount = settings?.blurring.enabled
        ? Math.min(settings.blurring.radiusPx, 9)
        : 0;
      const executedPassCount = jumpFloodPassCount + blurPassCount;
      const cachePassIndex = jumpFloodPassCount + (settings?.blurring.radiusPx ?? 0);
      const executedFinalTarget = executedPassCount % 2 === 0 ? 'jump-flood-a' : 'jump-flood-b';
      const cacheSelectedTarget = cachePassIndex % 2 === 0 ? 'jump-flood-a' : 'jump-flood-b';
      const weightSettings = settings?.weightSettings ?? [];
      const weightPasses = weightSettings.map(({ layerName }) => {
        const index = weightIndices.get(layerName) ?? 0;
        weightIndices.set(layerName, index + 1);
        return {
          layerName,
          read: `weight:${layerName}:${index % 2 === 0 ? 'ping' : 'pong'}`,
          write: `weight:${layerName}:${index % 2 === 0 ? 'pong' : 'ping'}`,
        };
      });
      textures.push(
        {
          name: `actor:${id}:depth-and-shape`,
          widthPx,
          heightPx,
          format: 'rg32float',
          origin: 'row-0-is-min-z',
          channels: ['depth and shape R', 'depth and shape G'],
          temporary: true,
        },
        {
          name: `actor:${id}:water-depth-and-velocity`,
          widthPx,
          heightPx,
          format: 'rgba32float',
          origin: 'row-0-is-min-z',
          channels: [
            'water depth and velocity R',
            'water depth and velocity G',
            'water depth and velocity B',
            'water depth and velocity A',
          ],
          temporary: true,
        },
        {
          name: `actor:${id}:jump-flood-a`,
          widthPx,
          heightPx,
          format: 'rgba32float',
          origin: 'row-0-is-min-z',
          channels: [
            'nearest seed U',
            'nearest seed V',
            'nearest seed Z/height',
            'current-pixel sign mask from source alpha',
          ],
          temporary: true,
        },
        {
          name: `actor:${id}:jump-flood-b`,
          widthPx,
          heightPx,
          format: 'rgba32float',
          origin: 'row-0-is-min-z',
          channels: [
            'nearest seed U',
            'nearest seed V',
            'nearest seed Z/height',
            'current-pixel sign mask from source alpha',
          ],
          temporary: true,
        },
        {
          name: `actor:${id}:distance-height-depth-velocity`,
          widthPx,
          heightPx,
          format: bodyActor
            ? actor.bodyType === 'river'
              ? 'rgba32float'
              : 'rgba16float'
            : 'rg16float',
          origin: 'row-0-is-min-z',
          channels: bodyActor ? ['RGBA body brush cache'] : ['RG island brush cache'],
          temporary: false,
        },
      );
      const curve = cacheCurveKey(actor);
      if (!textures.some((texture) => texture.name === `curve-lut:${curve}`))
        textures.push({
          name: `curve-lut:${curve}`,
          widthPx: 256,
          heightPx: 1,
          format: 'r16float',
          origin: 'row-0-is-min-z',
          channels: [`CurveFloat(${curve}) at i/255`],
          temporary: false,
        });
      actorPassPlan.push({
        actorId: id,
        blurPassCount,
        jumpFloodPassCount,
        jfaStepOffsets,
        jumpFloodExecutedFinalTarget: executedFinalTarget,
        jumpFloodCacheSelectedTarget: cacheSelectedTarget,
        jumpFloodCachePassIndex: cachePassIndex,
        jumpFloodCacheParity: (cachePassIndex % 2) as 0 | 1,
        jumpFloodCacheTarget: cacheSelectedTarget,
        heightRead: heightIndex % 2 === 0 ? 'height-ping' : 'height-pong',
        heightWrite: heightIndex % 2 === 0 ? 'height-pong' : 'height-ping',
        ...(bodyActor
          ? {
              velocityHeightRead:
                velocityHeightIndex % 2 === 0
                  ? ('combined-velocity-height-a' as const)
                  : ('combined-velocity-height-b' as const),
              velocityHeightWrite:
                velocityHeightIndex % 2 === 0
                  ? ('combined-velocity-height-b' as const)
                  : ('combined-velocity-height-a' as const),
              bodyComposite: {
                canvasSegmentSizeM: managerDefaults.canvasSegmentSizeM,
                splineMeshExtensionM: managerDefaults.splineMeshExtensionM,
                shapeDilationM:
                  inputs.actorIdentities[id]?.kind === 'body'
                    ? requireWaterValue(inputs.actorIdentities[id]).shapeDilationM
                    : WATER_BODY_DEFAULT_SHAPE_DILATION_M,
              },
            }
          : {}),
        weightPasses,
        heightBlend: settings?.blend.type ?? 'alpha',
        weightLayerNames: weightSettings.map((setting) => setting.layerName),
      });

      return bodyActor;
    };
    for (const actor of orderedActors) {
      const bodyActor = prepareActorPass(actor);
      heightIndex++;
      if (bodyActor) velocityHeightIndex++;
    }

    return weightIndices;
  };
  const weightIndices = prepareActorPasses();
  const terrainReadbackLayout = Object.freeze({
    heightTexture: 'terrain-output-height-m',
    weightTexturesByLayer: Object.freeze(
      Object.fromEntries(
        Object.keys(capture.layerNameToIndex)
          .sort()
          .map((layerName) => {
            const passes = weightIndices.get(layerName) ?? 0;
            return [layerName, `weight:${layerName}:${passes % 2 === 1 ? 'pong' : 'ping'}`];
          }),
      ),
    ),
  });
  const prepareActorCaches = () => {
    for (const guid of [...recipe.curves, ...recipe.textures])
      if (!/^[0-9a-f]{64}$/i.test(inputs.dependencyDigests[guid] ?? ''))
        return err(invalid('sha256 digest for every referenced curve/texture payload', guid));
    if (
      orderedActors.some((actor) => cacheCurveKey(actor) === WATER_DEFAULT_BRUSH_CURVE_KEY) &&
      inputs.dependencyDigests[WATER_DEFAULT_BRUSH_CURVE_KEY] !== WATER_DEFAULT_BRUSH_CURVE_SHA256
    ) {
      return err(
        invalid('SHA-256 digest of the built-in default elevation curve R16F samples', {
          expected: WATER_DEFAULT_BRUSH_CURVE_SHA256,
          actual: inputs.dependencyDigests[WATER_DEFAULT_BRUSH_CURVE_KEY],
        }),
      );
    }
    const actorCaches: WaterBrushActorCacheManifest[] = [];
    const prepareActorCache = (
      actor: WaterBrushBodyActor | WaterBrushIslandActor,
    ): Result<void, WaterError> => {
      const id = actorId(actor);
      const digest = inputs.actorInputDigests[id];
      if (!/^[0-9a-f]{64}$/i.test(digest ?? ''))
        return err(invalid('sha256 digest for every frozen actor input', id));
      const cacheShaderVersions = Object.fromEntries(
        Object.entries(inputs.shaderVersions)
          .filter(([name]) =>
            ['capture', 'detectEdges', 'blurEdges', 'jumpFlood', 'cacheDistanceField'].includes(
              name,
            ),
          )
          .sort(([a], [b]) => a.localeCompare(b)),
      );
      const curveKey = cacheCurveKey(actor);
      const curveDigest = inputs.dependencyDigests[curveKey];
      if (!/^[0-9a-f]{64}$/i.test(curveDigest ?? ''))
        return err(
          invalid('sha256 digest for the curve LUT bound to CacheDistanceField', {
            actorId: id,
            curveKey,
          }),
        );
      const rules = typeof actor === 'string' ? undefined : actor.rules;
      const identity = requireWaterValue(inputs.actorIdentities[id]);
      const actorCapture: WaterBrushActorCacheManifest['actorCapture'] =
        actor.kind === 'body'
          ? {
              kind: 'body',
              bodyGuid: actor.bodyGuid,
              bodyType: actor.bodyType,
              spline: requireWaterValue(identity.kind === 'body' ? identity : undefined).spline,
            }
          : {
              kind: 'island',
              sourceKey: actor.sourceKey,
              heightOffsetM: actor.heightOffsetM,
              spline: actor.spline,
            };
      const resolvedIdentity =
        identity.kind === 'body'
          ? {
              kind: identity.kind,
              bodyGuid: identity.bodyGuid,
              bodyType: identity.bodyType,
              fullName: identity.fullName,
            }
          : { kind: identity.kind, sourceKey: identity.sourceKey, fullName: identity.fullName };
      const captureProvenance = identity.captureProvenance;
      const cacheCaptureProvenance =
        captureProvenance.source === 'pack-mesh'
          ? (({ sourcePayloadDigest: _sourcePayloadDigest, ...rest }) => rest)(captureProvenance)
          : captureProvenance;
      const actorInputDigest = sha256(
        canonicalJson({
          sourceInputDigest: requireWaterValue(digest),
          actorCapture,
          resolvedIdentity,
          captureProvenance: cacheCaptureProvenance,
        }),
      );
      const input = {
        actorId: id,
        actorCapture,
        resolvedIdentity,
        captureProvenance: cacheCaptureProvenance,
        inputDigest: actorInputDigest,
        terrainCapture: capture,
        managerDefaults,
        cacheMaterialInputs: {
          jumpFloodCacheSelectedTarget: actorPassPlan.find((pass) => pass.actorId === id)
            ?.jumpFloodCacheSelectedTarget,
          useBlur: rules?.blurring.enabled ?? false,
          blurRadiusPx: rules?.blurring.radiusPx ?? 0,
          invert: typeof actor !== 'string' && actor.kind === 'body' && actor.bodyType === 'ocean',
          useMeshDepth:
            typeof actor !== 'string' && actor.kind === 'body' && actor.bodyType === 'river',
          curlNoise: rules?.curlNoise,
          zOffsetM: rules?.falloff.zOffsetM ?? 0,
          curves: rules?.curves,
          curveKey,
          curveDigest,
        },
        shaderVersions: cacheShaderVersions,
        layoutVersion: 1,
      };
      actorCaches.push({
        actorId: id,
        actorCapture,
        inputDigest: actorInputDigest,
        sourceInputDigest: requireWaterValue(digest),
        captureProvenance,
        cacheKey: sha256(canonicalJson(input)),
        textures: [
          `actor:${id}:depth-and-shape`,
          `actor:${id}:water-depth-and-velocity`,
          `actor:${id}:jump-flood-a`,
          `actor:${id}:jump-flood-b`,
          `actor:${id}:distance-height-depth-velocity`,
        ],
      });
      return ok(undefined);
    };
    for (const actor of orderedActors) {
      const cache = prepareActorCache(actor);
      if (!cache.ok) return cache;
    }

    return ok(actorCaches);
  };
  const cachedActors = prepareActorCaches();
  if (!cachedActors.ok) return cachedActors;
  const actorCaches = cachedActors.value;
  if (!/^[0-9a-f]{64}$/i.test(inputs.baseTerrainDigest))
    return err(
      invalid('sha256 digest of the frozen base Terrain source', inputs.baseTerrainDigest),
    );
  const initialization: WaterBrushManifestInitialization = Object.freeze({
    heightInput: 'base-combined-result',
    weightInput: 'base-combined-result',
    velocityHeightClearM: [0, 0, -163.84, 1] as const,
    velocityHeightUnits: 'meters',
    jumpFloodClear: [0, 0, 0, 0] as const,
    jumpFloodClearMeaning: 'no edge seed',
  });
  const shaderConstants: WaterBrushShaderConstants = Object.freeze({
    falloffAngleClampDegrees: [1, 89] as const,
    falloffWidthMinimumM: 0.001,
    weightFalloffWidthMinimumM: 0.001,
    smoothBlendDistanceMinimumM: 0.0001,
    terracingSmoothnessInput: 'spacingM-blue-channel',
  });
  const recipeDigest = sha256(canonicalJson(normalizedRecipe));
  const cacheKey = sha256(
    canonicalJson({
      version: 2,
      recipeDigest,
      baseTerrainDigest: inputs.baseTerrainDigest,
      capture,
      actorCaches: actorCaches.map(({ actorId: id, cacheKey: key }) => [id, key]),
      actorPassPlan,
      terrainReadbackLayout,
      dependencyDigests: Object.fromEntries(
        [...recipe.curves, ...recipe.textures]
          .sort()
          .map((guid) => [guid, inputs.dependencyDigests[guid]]),
      ),
      textures,
      initialization,
      shaderConstants,
      managerDefaults,
      shaderVersions: inputs.shaderVersions,
    }),
  );
  return ok(
    Object.freeze({
      version: 2,
      recipeDigest,
      baseTerrainDigest: inputs.baseTerrainDigest,
      terrainCapture: capture,
      pixelCenterMapping: mapping,
      textures: Object.freeze(textures),
      shaderVersions: inputs.shaderVersions,
      actorCaches: Object.freeze(actorCaches),
      actorPassPlan: Object.freeze(actorPassPlan),
      terrainReadbackLayout,
      initialization,
      shaderConstants,
      managerDefaults,
      cacheKey,
    }),
  );
}
