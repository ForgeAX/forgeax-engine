import {
  defineComponent,
  defineRelationship,
  type EntityHandle,
  type Query,
  type World,
} from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  type DirectionalShadowQuality,
  directionalShadowQualityFromF32,
} from '../components/directional-shadow-filter';
import {
  captureShadowViewIdentity,
  directionalShadowViewIdentity,
} from '../gpu-driven/shadow-view-identity';
import type { ShadowViewIdentity } from '../inspection-types';
import {
  CSM_CAMERA_KEYS,
  type CsmCameraData,
  computeDirectionalCsm,
  type LightRoster,
  type PointLightSnapshot,
  type PointShadowSnapshot,
  pssmSplit,
  type RectAreaDirectLightSnapshot,
  type SpotLightSnapshot,
} from '../render-system-extract';
import { sameValue } from '../same-value';
import { SHADOW_ATLAS_DEFAULT_LAYERS } from '../shadow-atlas';
import { shadowPlanes } from '../shadow-frustum';
import { renderWorldFor } from './render-world';

/** Spot shadow tiles in the renderer-owned spot depth array. */
export const SPOT_SHADOW_LAYERS = 4;

/** Directional facts that do not depend on a view: the light and its shadow configuration. */
export type DirectionalLightFacts = Pick<
  LightRoster,
  | 'directional'
  | 'directionalCsmConfig'
  | 'directionalCsmDirection'
  | 'depthBias'
  | 'normalBias'
  | 'directionalShadowError'
>;

type LightFacts =
  | DirectionalLightFacts
  | PointLightSnapshot
  | SpotLightSnapshot
  | RectAreaDirectLightSnapshot;

/** `RenderLight.kind` values. */
const LightKindValue = Object.freeze({ directional: 0, point: 1, spot: 2, rect: 3 } as const);

/**
 * A light in the Render World. `shadowLayer` is the atlas layer (point cube or
 * spot tile) the light holds for its whole lifetime, so another light's arrival
 * or removal never moves it; -1 means the light has no shadow layer. `facts`
 * carry that layer as `shadowAtlasLayer` / `shadowAtlasTile`.
 */
export const RenderLight = defineComponent('RenderLight', {
  kind: { type: 'enum', default: LightKindValue.directional, labels: LightKindValue },
  shadowLayer: { type: 'i32', default: -1 },
  facts: 'unique<LightFacts>',
});

/** A point light's requested cube shadow (PointLightShadow facts). */
export const RenderPointShadow = defineComponent('RenderPointShadow', {
  facts: 'unique<PointShadowSnapshot>',
});

/** Shadow views follow their light: despawning the light despawns its views. */
export const { source: ShadowViewOf, target: LightShadowViews } = defineRelationship({
  sourceName: 'ShadowViewOf',
  sourceField: 'light',
  targetName: 'LightShadowViews',
  targetField: 'views',
  exclusive: true,
  linkedSpawn: true,
});

/** A view entity's cascade views follow it: despawning the view despawns them. */
export const { source: CascadeViewOf, target: ViewCascadeViews } = defineRelationship({
  sourceName: 'CascadeViewOf',
  sourceField: 'view',
  targetName: 'ViewCascadeViews',
  targetField: 'views',
  exclusive: true,
  linkedSpawn: true,
});

/**
 * A view entity's directional cascade fit and the lights it records with;
 * written only by `render-cascade-fit`.
 */
export const ViewCascadeFit = defineComponent('ViewCascadeFit', {
  fit: 'unique<ViewCascadeFit>',
});

/** The cascade matrices a view's last accepted scene submission rasterized. */
export interface CascadeHistory {
  lightViewProj: readonly Float32Array[] | undefined;
}

/**
 * The lights a view entity records with, fitted this frame by
 * `render-cascade-fit`; undefined while the view is not fitted (disabled, the
 * shared capture view, or no fit system).
 */
export function viewLightsOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewLights | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewCascadeFit)) return undefined;
  return world.resolveUniqueRef<ViewRecord>(world.get(entity, ViewCascadeFit).unwrap().fit).unwrap()
    .lights;
}

/**
 * A view entity's submitted cascade history, the projection its next fit
 * retains; written only by `render-cascade-history`.
 */
export const ViewCascadeHistory = defineComponent('ViewCascadeHistory', {
  history: 'unique<CascadeHistory>',
});

/** Light-space projection a point face or spot shadow view retains between light changes. */
export interface ShadowViewProjection {
  readonly identity: ShadowViewIdentity;
  readonly matrix: Float32Array;
  /** Six plane lanes derived once; automatic CSM disables the near lane for pancaking. */
  readonly planes: Float32Array;
}

/** One point cube face or spot shadow view of a light. */
export const ShadowView = defineComponent('ShadowView', {
  projection: 'unique<ShadowViewProjection>',
});

/** A directional light's cascades fitted for one view. */
export interface DirectionalCascades {
  /** Four cascade matrices (unused slots zero); absent until a camera can be fitted. */
  readonly lightViewProj: readonly Float32Array[] | undefined;
  /** Four vec4 lanes: split, worldUnitsPerTexel, lightDepthWorldSpan, reserved. */
  readonly splitPlanes: Float32Array;
  readonly cascadeCount: number;
  readonly cascadeBlend: number;
  readonly shadowMapSize: number;
  readonly directionalShadowQuality: DirectionalShadowQuality | undefined;
  /** One shadow view per `lightViewProj` matrix, planes derived once per fit. */
  readonly views: readonly ShadowViewProjection[];
}

/** What a view fits its cascades against. */
export interface CascadeFit {
  readonly camera: CsmCameraData | undefined;
  /** The view's last submitted cascades; a matrix still covering its slice is kept. */
  readonly retained?: readonly Float32Array[] | undefined;
  readonly normalBias?: number | undefined;
}

/**
 * The lights one view records with: the light owner's roster, the view's
 * directional cascades, and every shadow view it may raster (its cascades,
 * then the owner's point faces and spots). Retained per view; arrays are the
 * owner's and are never copied.
 */
export interface ViewLights extends LightRoster {
  readonly cascades: DirectionalCascades | undefined;
  readonly shadowViews: readonly ShadowViewProjection[];
}

/** The light owning a point face or spot shadow view: its stable cube layer or spot tile. */
export function shadowViewLight(
  lights: ViewLights,
  identity: ShadowViewIdentity,
): PointShadowSnapshot | SpotLightSnapshot | undefined {
  return identity.kind === 'point'
    ? lights.pointShadow.find((light) => light.shadowAtlasLayer === identity.index)
    : identity.kind === 'spot'
      ? lights.spot.find((light) => light.shadowAtlasTile === identity.index)
      : undefined;
}

/** The caster channels a shadow view rasters; an unauthored mask admits every channel. */
export function shadowViewCasterChannels(
  lights: ViewLights,
  identity: ShadowViewIdentity,
): number | undefined {
  return identity.kind === 'directional'
    ? lights.directionalCsmConfig?.shadowCasterChannels
    : shadowViewLight(lights, identity)?.shadowCasterChannels;
}

/**
 * Fit a directional light's cascades for one camera. Without a fittable
 * camera the cascade metadata (count, split planes, map size) remains so the
 * view still sizes its shadow resources; matrices stay absent.
 */
export function fitDirectionalCascades(
  roster: Pick<LightRoster, 'directionalCsmConfig' | 'directionalCsmDirection'>,
  fit: CascadeFit,
): DirectionalCascades | undefined {
  const config = roster.directionalCsmConfig;
  const direction = roster.directionalCsmDirection;
  if (config === undefined || direction === undefined) return undefined;
  const csm = computeDirectionalCsm(direction, config, fit.camera, fit.retained, fit.normalBias);
  if (csm !== null)
    return {
      ...csm,
      views: csm.lightViewProj.map((matrix, index) =>
        Object.freeze({
          identity: directionalShadowViewIdentity(index),
          matrix,
          planes: shadowPlanes(matrix, config.shadowViewProjection === undefined),
        }),
      ),
    };
  const cascadeCount = Math.round(config.cascadeCount);
  const splits = pssmSplit(
    fit.camera?.near ?? 0.1,
    config.shadowDistance,
    cascadeCount,
    config.splitLambda,
  );
  const splitPlanes = new Float32Array(16);
  for (let i = 0; i < splits.length; i++) splitPlanes[i * 4] = splits[i] ?? 0;
  return {
    lightViewProj: undefined,
    splitPlanes,
    cascadeCount,
    cascadeBlend: config.cascadeBlend,
    shadowMapSize: config.mapSize,
    directionalShadowQuality: directionalShadowQualityFromF32(
      config.shadowFilter,
      config.shadowAngularRadius,
      config.maxPenumbraTexels,
    ),
    views: [],
  };
}

/** One recording view's retained light read, cascade fit and cascade view entities. */
export interface ViewRecord {
  /** The view entity its cascade views follow; undefined for a hand-driven capture fit. */
  readonly view: EntityHandle | undefined;
  config: LightRoster['directionalCsmConfig'];
  direction: LightRoster['directionalCsmDirection'];
  normalBias: number | undefined;
  retained: Float32Array[] | undefined;
  /** A copy of the camera the last fit read; undefined for a cameraless fit. */
  camera: CsmCameraData | undefined;
  cascades: DirectionalCascades | undefined;
  /** False until the view's first fit. */
  fitted: boolean;
  light: EntityHandle | undefined;
  readonly cascadeEntities: EntityHandle[];
  roster: LightRoster | undefined;
  pointSpotViews: readonly ShadowViewProjection[] | undefined;
  lights: ViewLights | undefined;
}

export function createViewRecord(view?: EntityHandle): ViewRecord {
  return {
    view,
    config: undefined,
    direction: undefined,
    normalBias: undefined,
    retained: undefined,
    camera: undefined,
    cascades: undefined,
    fitted: false,
    light: undefined,
    cascadeEntities: [],
    roster: undefined,
    pointSpotViews: undefined,
    lights: undefined,
  };
}

function copyCamera(camera: CsmCameraData): CsmCameraData {
  const copy: Record<string, unknown> = {};
  for (const key of CSM_CAMERA_KEYS) {
    const value = camera[key];
    copy[key] = ArrayBuffer.isView(value)
      ? value.slice()
      : Array.isArray(value)
        ? [...value]
        : value;
  }
  return copy as unknown as CsmCameraData;
}

function sameCamera(stored: CsmCameraData | undefined, camera: CsmCameraData | undefined): boolean {
  if (stored === undefined || camera === undefined) return stored === camera;
  for (const key of CSM_CAMERA_KEYS) if (!sameValue(stored[key], camera[key])) return false;
  return true;
}

/** The same matrix objects: what a view last submitted is what it retains. */
function sameMatrices(
  left: readonly Float32Array[] | undefined,
  right: readonly Float32Array[] | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

function sameFit(record: ViewRecord, roster: LightRoster, fit: CascadeFit): boolean {
  if (!record.fitted) {
    record.fitted = true;
    return false;
  }
  if (
    record.config !== roster.directionalCsmConfig ||
    record.direction !== roster.directionalCsmDirection
  )
    return false;
  // Without a shadow configuration nothing is fitted, whatever the camera does.
  if (roster.directionalCsmConfig === undefined) return true;
  return (
    Object.is(record.normalBias, fit.normalBias) &&
    sameMatrices(record.retained, fit.retained) &&
    sameCamera(record.camera, fit.camera)
  );
}

const EMPTY: LightRoster = Object.freeze({
  directional: undefined,
  directionalCount: 0,
  point: Object.freeze([]),
  spot: Object.freeze([]),
  rect: Object.freeze([]),
  pointShadow: Object.freeze([]),
  directionalCsmConfig: undefined,
  directionalCsmDirection: undefined,
  depthBias: undefined,
  normalBias: undefined,
  directionalShadowError: undefined,
});

/** Layer fields are Render World facts, never compared against the source. */
const LAYER_KEYS: ReadonlySet<string> = new Set(['shadowAtlasLayer', 'shadowAtlasTile']);

function sameList(stored: readonly unknown[], source: readonly unknown[]): boolean {
  if (stored.length !== source.length) return false;
  for (let index = 0; index < stored.length; index += 1)
    if (!sameValue(stored[index], source[index], LAYER_KEYS)) return false;
  return true;
}

function directionalFacts(source: LightRoster): DirectionalLightFacts {
  return {
    directional: source.directional,
    directionalCsmConfig: source.directionalCsmConfig,
    directionalCsmDirection: source.directionalCsmDirection,
    depthBias: source.depthBias,
    normalBias: source.normalBias,
    directionalShadowError: source.directionalShadowError,
  };
}

function sameDirectional(stored: LightRoster, source: LightRoster): boolean {
  return (
    stored.directionalCount === source.directionalCount &&
    sameValue(stored.directional, source.directional) &&
    sameList(stored.additionalDirectional ?? [], source.additionalDirectional ?? []) &&
    sameValue(stored.directionalCsmConfig, source.directionalCsmConfig) &&
    sameValue(stored.directionalCsmDirection, source.directionalCsmDirection) &&
    stored.depthBias === source.depthBias &&
    stored.normalBias === source.normalBias &&
    sameValue(stored.directionalShadowError, source.directionalShadowError)
  );
}

/** Source identity of one light; keyless fixtures fall back to their ordinal. */
function keyOf(
  light: { readonly entity?: unknown; readonly worldId?: number },
  ordinal: number,
): number {
  if (light.entity === undefined) return -(ordinal + 1);
  return (light.worldId ?? 0) * 0x1_0000_0000 + Number(light.entity);
}

/** Ingest identity translation of one light kind: source key to entity, and its layer pool. */
interface LightKind {
  readonly value: number;
  readonly shadow: 'point' | 'spot' | undefined;
  readonly declared: Map<number, { readonly entity: EntityHandle; seen: number }>;
  /** Free atlas layers, lowest first. */
  readonly free: number[];
}

function lightKind(value: number, shadow: LightKind['shadow'], capacity = 0): LightKind {
  return { value, shadow, declared: new Map(), free: freeList(capacity) };
}

/**
 * Source-driven light entities. A recording view's extraction hands its
 * lights to {@link RenderLights.adopt}, which turns them into one entity per light: a new light spawns, a
 * vanished one despawns, a changed one is rewritten, and a steady frame writes
 * nothing. Each shadow-capable light holds a stable atlas layer and one
 * {@link ShadowView} entity per face, so adding or removing a light never moves
 * another light's shadow identity.
 *
 * `roster` is the retained light roster in source order: its arrays hold the
 * light entities' facts and keep their identity until a light changes.
 * `render-cascade-fit` adds each view entity's directional cascades through
 * {@link RenderLights.fitView}: one {@link ShadowView} entity per cascade of
 * each (light, view), refitted only when the camera, light or submitted
 * history changed. A capture's cube faces and the shared capture view fit by
 * hand through {@link RenderLights.viewLights}.
 */
export class RenderLights {
  roster: LightRoster = EMPTY;
  /** Point faces then spots, in roster order; replaced only when a shadow view changes. */
  shadowViews: readonly ShadowViewProjection[] = Object.freeze([]);
  private readonly directional = lightKind(LightKindValue.directional, undefined);
  private readonly point = lightKind(LightKindValue.point, 'point', SHADOW_ATLAS_DEFAULT_LAYERS);
  private readonly spot = lightKind(LightKindValue.spot, 'spot', SPOT_SHADOW_LAYERS);
  private readonly rect = lightKind(LightKindValue.rect, undefined);
  /** The source roster last adopted. */
  private adopted: LightRoster | undefined;
  /** Shadowed point lights (pointShadow order) then casting spots: the `shadowViews` order. */
  private shadowed: readonly EntityHandle[] = Object.freeze([]);
  private orderChanged = false;
  /** Lights whose shadow views refit this run; reused. */
  private readonly refit = new Set<EntityHandle>();
  /** Hand-driven capture fits and the light read each retains, keyed by the recording. */
  private readonly views = new Map<object, ViewRecord>();
  private syncs = 0;

  constructor(readonly world: World) {}

  /**
   * Reconcile the light entities with a frame's extracted roster (the
   * `render-lights` system). A change-driven source hands over the same
   * roster while its lights hold still; an equal one compares in place and
   * writes nothing.
   */
  adopt(source: LightRoster): void {
    if (source === this.adopted) return;
    if (!this.matches(source)) this.apply(source);
    this.adopted = source;
  }

  /**
   * The lights a hand-driven capture `view` records with: `roster` (the
   * adopted roster, or a capture's frozen copy of it) and its directional cascades. The
   * cascades refit only when the camera, the directional light or the
   * retained projection changed; a steady frame returns the same object.
   */
  viewLights(
    view: object,
    roster: LightRoster,
    fit: CascadeFit,
    /** The view entity whose despawn takes the cascade views with it. */
    owner?: EntityHandle,
  ): ViewLights {
    let record = this.views.get(view);
    if (record === undefined) {
      record = createViewRecord(owner);
      this.views.set(view, record);
    }
    return this.fitView(record, roster, fit);
  }

  /**
   * Fit one view record's cascades (`render-cascade-fit` for a view entity's
   * {@link ViewCascadeFit}, or a hand-driven capture key).
   */
  fitView(record: ViewRecord, roster: LightRoster, fit: CascadeFit): ViewLights {
    if (!sameFit(record, roster, fit)) {
      record.config = roster.directionalCsmConfig;
      record.direction = roster.directionalCsmDirection;
      record.normalBias = fit.normalBias;
      record.retained = fit.retained === undefined ? undefined : [...fit.retained];
      record.camera = fit.camera === undefined ? undefined : copyCamera(fit.camera);
      const cascades = fitDirectionalCascades(roster, fit);
      // Equal values keep the retained matrices: their identity is what the next fit retains.
      const changed = !sameValue(record.cascades, cascades);
      if (changed) record.cascades = cascades;
      if (changed || record.light !== this.directionalEntity()) this.writeCascadeViews(record);
    }
    const lights = record.lights;
    if (
      lights !== undefined &&
      record.roster === roster &&
      lights.cascades === record.cascades &&
      record.pointSpotViews === this.shadowViews
    )
      return lights;
    record.roster = roster;
    record.pointSpotViews = this.shadowViews;
    const cascadeViews = record.cascades?.views ?? [];
    record.lights = Object.freeze({
      directional: roster.directional,
      directionalCount: roster.directionalCount,
      additionalDirectional: roster.additionalDirectional ?? [],
      point: roster.point,
      spot: roster.spot,
      rect: roster.rect,
      pointShadow: roster.pointShadow,
      depthBias: roster.depthBias,
      normalBias: roster.normalBias,
      directionalShadowError: roster.directionalShadowError,
      directionalCsmConfig: roster.directionalCsmConfig,
      directionalCsmDirection: roster.directionalCsmDirection,
      cascades: record.cascades,
      shadowViews:
        cascadeViews.length === 0
          ? this.shadowViews
          : Object.freeze([...cascadeViews, ...this.shadowViews]),
    });
    return record.lights;
  }

  /** A recording view retired: despawn its cascade views. */
  releaseView(view: object): void {
    const record = this.views.get(view);
    if (record === undefined) return;
    this.views.delete(view);
    this.despawnCascadeViews(record);
  }

  /** A view entity stopped fitting (disabled, or now the shared capture view): drop its fit. */
  retireFit(record: ViewRecord): void {
    if (!record.fitted) return;
    this.despawnCascadeViews(record);
    record.fitted = false;
    record.cascades = undefined;
    record.camera = undefined;
    record.retained = undefined;
    record.roster = undefined;
    record.lights = undefined;
  }

  /** Spawn or rewrite one shadow view entity per cascade of a view's fit. */
  private writeCascadeViews(record: ViewRecord): void {
    const world = this.world;
    const light = this.directionalEntity();
    if (record.light !== light) {
      this.despawnCascadeViews(record);
      record.light = light;
    }
    const views = record.cascades?.views ?? [];
    if (light === undefined) return;
    const entities = record.cascadeEntities;
    while (entities.length > views.length) {
      const entity = entities.pop() as EntityHandle;
      if (world.hasComponent(entity, ShadowView)) world.despawn(entity).unwrap();
    }
    for (const [cascade, projection] of views.entries()) {
      const handle = world.allocUniqueRef('ShadowViewProjection', projection);
      const entity = entities[cascade];
      if (entity === undefined)
        entities.push(
          (record.view === undefined
            ? world.spawn(
                { component: ShadowViewOf, data: { light } },
                { component: ShadowView, data: { projection: handle } },
              )
            : world.spawn(
                { component: ShadowViewOf, data: { light } },
                { component: CascadeViewOf, data: { view: record.view } },
                { component: ShadowView, data: { projection: handle } },
              )
          ).unwrap(),
        );
      else world.set(entity, ShadowView, { projection: handle }).unwrap();
    }
  }

  private despawnCascadeViews(record: ViewRecord): void {
    const world = this.world;
    // Linked despawn already retired the views of a departed light.
    for (const entity of record.cascadeEntities)
      if (world.hasComponent(entity, ShadowView)) world.despawn(entity).unwrap();
    record.cascadeEntities.length = 0;
    record.light = undefined;
  }

  private directionalEntity(): EntityHandle | undefined {
    for (const light of this.directional.declared.values()) return light.entity;
    return undefined;
  }

  private matches(source: LightRoster): boolean {
    const current = this.roster;
    return (
      sameDirectional(current, source) &&
      sameList(current.point, source.point) &&
      sameList(current.spot, source.spot) &&
      sameList(current.rect, source.rect) &&
      sameList(current.pointShadow, source.pointShadow)
    );
  }

  private apply(source: LightRoster): void {
    const frame = ++this.syncs;
    const shadows = new Map<number, PointShadowSnapshot>();
    for (const [index, shadow] of source.pointShadow.entries())
      shadows.set(keyOf(shadow, index), shadow);
    const directional =
      source.directional === undefined
        ? undefined
        : this.declare(
            this.directional,
            keyOf(source.directional, 0),
            frame,
            directionalFacts(source),
          );
    const points = source.point.map((light, index) => {
      const key = keyOf(light, index);
      return this.declare(this.point, key, frame, light, shadows.get(key));
    });
    const spots = source.spot.map((light, index) =>
      this.declare(this.spot, keyOf(light, index), frame, light),
    );
    const rects = source.rect.map((light, index) =>
      this.declare(this.rect, keyOf(light, index), frame, light),
    );
    for (const kind of [this.directional, this.point, this.spot, this.rect]) {
      for (const [key, light] of kind.declared) {
        if (light.seen === frame) continue;
        this.freeLayer(kind, this.layerOf(light.entity));
        // Linked despawn retires the light's shadow views with it.
        this.world.despawn(light.entity).unwrap();
        kind.declared.delete(key);
      }
    }
    // Layers go to waiting lights in source order once every departure freed its own.
    const shadowed: EntityHandle[] = [];
    for (const [index, shadow] of source.pointShadow.entries()) {
      const light = this.point.declared.get(keyOf(shadow, index));
      if (light !== undefined && light.seen === frame) shadowed.push(light.entity);
    }
    for (const entity of shadowed) this.acquire(this.point, entity);
    for (const entity of spots) if (this.wantsTile(entity)) this.acquire(this.spot, entity);
    const order = [...shadowed, ...spots.filter((entity) => this.layerOf(entity) >= 0)];
    const retainedOrder = this.shadowed;
    if (
      retainedOrder.length !== order.length ||
      order.some((entity, index) => entity !== retainedOrder[index])
    ) {
      this.shadowed = Object.freeze(order);
      this.orderChanged = true;
    }
    this.roster = Object.freeze({
      ...(directional === undefined ? EMPTY : (this.facts(directional) as DirectionalLightFacts)),
      directionalCount: source.directionalCount,
      additionalDirectional: Object.freeze([...(source.additionalDirectional ?? [])]),
      point: Object.freeze(points.map((entity) => this.facts(entity) as PointLightSnapshot)),
      spot: Object.freeze(spots.map((entity) => this.facts(entity) as SpotLightSnapshot)),
      rect: Object.freeze(rects.map((entity) => this.facts(entity) as RectAreaDirectLightSnapshot)),
      pointShadow: Object.freeze(
        shadowed.map((entity) => this.pointShadow(entity) as PointShadowSnapshot),
      ),
    });
  }

  /**
   * Refit the point face and spot views of each light
   * whose layer, facts or point shadow changed, then republish the ordered
   * `shadowViews` only if a view or the order changed (the
   * `render-shadow-views` system, over its changed-row queries).
   */
  fitShadowViews(lights: Query, shadows: Query): void {
    const refit = this.refit;
    for (const row of lights) refit.add(row.entity);
    for (const row of shadows) refit.add(row.entity);
    let changed = this.orderChanged;
    this.orderChanged = false;
    for (const entity of refit)
      if (this.world.hasComponent(entity, RenderLight) && this.refreshViews(entity)) changed = true;
    refit.clear();
    if (!changed) return;
    const views: ShadowViewProjection[] = [];
    for (const entity of this.shadowed) views.push(...this.currentViews(entity));
    this.shadowViews = Object.freeze(views);
  }

  /** Spawn or rewrite one light entity. */
  private declare(
    kind: LightKind,
    key: number,
    frame: number,
    facts: LightFacts,
    shadow?: PointShadowSnapshot,
  ): EntityHandle {
    const world = this.world;
    const declared = kind.declared.get(key);
    if (declared === undefined) {
      const entity = world
        .spawn({
          component: RenderLight,
          data: {
            kind: kind.value,
            shadowLayer: -1,
            facts: world.allocUniqueRef('LightFacts', stamp(kind, -1, facts, shadow)),
          },
        })
        .unwrap();
      kind.declared.set(key, { entity, seen: frame });
      if (shadow !== undefined) this.writeShadow(entity, -1, shadow);
      return entity;
    }
    const entity = declared.entity;
    declared.seen = frame;
    const casts = kind.shadow === 'point' ? shadow !== undefined : castsSpot(facts);
    if (!casts) this.release(kind, entity);
    const layer = this.layerOf(entity);
    if (!sameValue(this.facts(entity), facts, LAYER_KEYS))
      this.writeFacts(entity, stamp(kind, layer, facts, shadow));
    if (!sameValue(this.pointShadow(entity), shadow, LAYER_KEYS))
      this.writeShadow(entity, layer, shadow);
    return entity;
  }

  private wantsTile(entity: EntityHandle): boolean {
    return castsSpot(this.facts(entity));
  }

  /** Take the lowest free layer; a full atlas leaves the light unshadowed. */
  private acquire(kind: LightKind, entity: EntityHandle): void {
    if (this.layerOf(entity) >= 0 || kind.free.length === 0) return;
    this.restamp(kind, entity, kind.free.shift() as number);
  }

  private freeLayer(kind: LightKind, layer: number): void {
    if (layer < 0) return;
    kind.free.push(layer);
    kind.free.sort((a, b) => a - b);
  }

  /** A live light stops casting: free its layer and despawn its shadow views. */
  private release(kind: LightKind, entity: EntityHandle): void {
    const layer = this.layerOf(entity);
    if (layer < 0) return;
    this.freeLayer(kind, layer);
    for (const view of this.viewEntities(entity)) this.world.despawn(view).unwrap();
    this.restamp(kind, entity, -1);
  }

  private restamp(kind: LightKind, entity: EntityHandle, layer: number): void {
    this.world.set(entity, RenderLight, { shadowLayer: layer }).unwrap();
    const shadow = this.pointShadow(entity);
    this.writeFacts(entity, stamp(kind, layer, this.facts(entity), shadow));
    if (shadow !== undefined) this.writeShadow(entity, layer, shadow);
  }

  /** The light's shadow view projections, in face order. */
  private currentViews(entity: EntityHandle): ShadowViewProjection[] {
    const world = this.world;
    return this.viewEntities(entity).map((view) =>
      world
        .resolveUniqueRef<ShadowViewProjection>(world.get(view, ShadowView).unwrap().projection)
        .unwrap(),
    );
  }

  /**
   * Spawn or rewrite the light's shadow views in face order when its layer or
   * matrices changed; true when a view was written.
   */
  private refreshViews(entity: EntityHandle): boolean {
    const kind = this.kindOf(entity);
    if (kind === undefined) return false;
    const layer = this.layerOf(entity);
    const matrices = layer < 0 ? undefined : this.viewMatrices(kind, entity);
    if (matrices === undefined) return false;
    const world = this.world;
    const entities = this.viewEntities(entity);
    const current = this.currentViews(entity);
    if (
      current.length === matrices.length &&
      current.every(
        (view, face) => view.identity.index === layer && sameValue(view.matrix, matrices[face]),
      )
    )
      return false;
    for (let face = 0; face < matrices.length; face += 1) {
      const matrix = new Float32Array(matrices[face] as Float32Array);
      const priorIdentity = current[face]?.identity;
      const projection: ShadowViewProjection = Object.freeze({
        identity: captureShadowViewIdentity(
          priorIdentity?.kind === kind.shadow &&
            priorIdentity?.index === layer &&
            priorIdentity?.face === (kind.shadow === 'point' ? face : undefined) &&
            priorIdentity?.layer === undefined &&
            priorIdentity?.terrainReceiver === undefined
            ? priorIdentity
            : kind.shadow === 'point'
              ? { kind: 'point' as const, index: layer, face }
              : { kind: 'spot' as const, index: layer },
        ),
        matrix,
        planes: shadowPlanes(matrix),
      });
      const handle = world.allocUniqueRef('ShadowViewProjection', projection);
      const view = entities[face];
      if (view === undefined)
        world
          .spawn(
            { component: ShadowViewOf, data: { light: entity } },
            { component: ShadowView, data: { projection: handle } },
          )
          .unwrap();
      else world.set(view, ShadowView, { projection: handle }).unwrap();
    }
    return true;
  }

  private kindOf(entity: EntityHandle): LightKind | undefined {
    const value = this.world.get(entity, RenderLight).unwrap().kind;
    return value === LightKindValue.point
      ? this.point
      : value === LightKindValue.spot
        ? this.spot
        : undefined;
  }

  /** Face matrices of a light's shadow views. */
  private viewMatrices(kind: LightKind, entity: EntityHandle): Float32Array[] | undefined {
    if (kind.shadow === 'point') {
      const shadow = this.pointShadow(entity);
      if (shadow === undefined) return undefined;
      return Array.from({ length: 6 }, (_, face) =>
        shadow.shadowMatrices.subarray(face * 16, face * 16 + 16),
      );
    }
    const spot = this.facts(entity) as SpotLightSnapshot;
    return spot.lightViewProj === undefined ? undefined : [spot.lightViewProj];
  }

  /** The light's shadow view entities, in the face order they were spawned. */
  private viewEntities(entity: EntityHandle): readonly EntityHandle[] {
    const world = this.world;
    if (!world.hasComponent(entity, LightShadowViews)) return [];
    return [...world.get(entity, LightShadowViews).unwrap().views] as EntityHandle[];
  }

  private layerOf(entity: EntityHandle): number {
    return this.world.get(entity, RenderLight).unwrap().shadowLayer;
  }

  private facts(entity: EntityHandle): LightFacts {
    const world = this.world;
    return world
      .resolveUniqueRef<LightFacts>(world.get(entity, RenderLight).unwrap().facts)
      .unwrap();
  }

  private pointShadow(entity: EntityHandle): PointShadowSnapshot | undefined {
    const world = this.world;
    if (!world.hasComponent(entity, RenderPointShadow)) return undefined;
    return world
      .resolveUniqueRef<PointShadowSnapshot>(world.get(entity, RenderPointShadow).unwrap().facts)
      .unwrap();
  }

  private writeFacts(entity: EntityHandle, facts: LightFacts): void {
    const world = this.world;
    world.set(entity, RenderLight, { facts: world.allocUniqueRef('LightFacts', facts) }).unwrap();
  }

  private writeShadow(
    entity: EntityHandle,
    layer: number,
    shadow: PointShadowSnapshot | undefined,
  ): void {
    const world = this.world;
    const present = world.hasComponent(entity, RenderPointShadow);
    if (shadow === undefined) {
      if (present) world.removeComponent(entity, RenderPointShadow).unwrap();
      return;
    }
    const stamped =
      shadow.shadowAtlasLayer === layer ? shadow : { ...shadow, shadowAtlasLayer: layer };
    const facts = world.allocUniqueRef('PointShadowSnapshot', stamped);
    if (present) world.set(entity, RenderPointShadow, { facts }).unwrap();
    else world.addComponent(entity, { component: RenderPointShadow, data: { facts } }).unwrap();
  }
}

function castsSpot(facts: LightFacts): boolean {
  const spot = facts as SpotLightSnapshot;
  return spot.castShadow && spot.lightViewProj !== undefined;
}

/** A light's own layer stamped into its stored facts. */
function stamp(
  kind: LightKind,
  layer: number,
  facts: LightFacts,
  shadow: PointShadowSnapshot | undefined,
): LightFacts {
  if (kind.shadow === 'spot') {
    const spot = facts as SpotLightSnapshot;
    return spot.shadowAtlasTile === layer ? spot : { ...spot, shadowAtlasTile: layer };
  }
  if (kind.shadow !== 'point') return facts;
  const point = facts as PointLightSnapshot;
  if (shadow === undefined) {
    if (point.shadowAtlasLayer === undefined) return point;
    const { shadowAtlasLayer: _layer, ...unshadowed } = point;
    return unshadowed;
  }
  return point.shadowAtlasLayer === layer ? point : { ...point, shadowAtlasLayer: layer };
}

function freeList(capacity: number): number[] {
  return Array.from({ length: capacity }, (_, layer) => layer);
}

const OWNERS = new WeakMap<World, RenderLights>();

/** The Render World's one light owner. */
export function renderLightsOf(world: World): RenderLights {
  let owner = OWNERS.get(world);
  if (owner === undefined) {
    owner = new RenderLights(world);
    OWNERS.set(world, owner);
  }
  return owner;
}

/** The light owner of a record context's Render World. */
export function renderLightsFor(owner: { readonly renderWorld?: World | undefined }): RenderLights {
  return renderLightsOf(renderWorldFor(owner));
}

/** The retained atmosphere Sun a capture generation pins its directional light to. */
export interface PinnedSun {
  readonly direction: ArrayLike<number>;
  readonly color: ArrayLike<number>;
  readonly intensity: number;
}

/**
 * A capture generation's roster: the directional pinned to the retained
 * atmosphere Sun (the roster itself when either side is absent).
 */
export function pinAtmosphereSun<T extends LightRoster>(lights: T, sun: PinnedSun | undefined): T {
  if (sun === undefined || lights.directional === undefined) return lights;
  const direction = vec3.create(
    -(sun.direction[0] ?? 0),
    -(sun.direction[1] ?? 0),
    -(sun.direction[2] ?? 0),
  );
  return {
    ...lights,
    directional: {
      ...lights.directional,
      direction,
      color: vec3.create(
        (sun.color[0] ?? 0) * sun.intensity,
        (sun.color[1] ?? 0) * sun.intensity,
        (sun.color[2] ?? 0) * sun.intensity,
      ),
      intensity: sun.intensity,
    },
    directionalCsmDirection: vec3.create(direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? 0),
  };
}
