import { ADVANCE_ANIMATION_PLAYER_SYSTEM, AnimationPlayer, AnimationTargetId, bindAnimationTargets } from '@forgeax/engine/animation';
import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { type ComponentData, ENTITY_NULL_RAW, type EntityHandle, Time, Update, type World } from '@forgeax/engine/ecs';
import { createCylinderGeometry, createSphereGeometry } from '@forgeax/engine/geometry';
import { FRAME_START_SCAN_SYSTEM_NAME, INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { quat } from '@forgeax/engine/math';
import { studioEnvironment } from '@forgeax/engine-modeling';
import { createPathSample, PathParameterization, type PreparedPath, preparePath } from '@forgeax/engine/path';
import {
  ANTIALIAS_FXAA,
  BLOOM_ENABLED,
  Camera,
  ClippingPlanes,
  clippingPlanesData,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  PlanarReflection,
  PointLight,
  perspective,
  type RenderTarget,
  type RenderTargetAuthoring,
  SceneInstance,
  ShadowParticipation,
  Skylight,
  TONEMAP_ACES_FILMIC,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine/render';
import { ChildOf, GlobalTransform, Name, Transform, worldDespawnScene } from '@forgeax/engine/scene';
import { type AssetHandle, type MeshAsset, RenderQueue } from '@forgeax/engine/types';
import { type CameraRail, cueAt, cuePose, type ShowCue, type ShowSegment, type StagePose, timeOf } from './director.ts';
import { analysisMesh, type ShowAnalysis } from './analysis.ts';
import { applicableControls, COMMON_CONTROLS, type ShowControl } from './controls.ts';
import type { ShowHistory } from './history.ts';

type Triple = [number, number, number];
type MaterialHandle = AssetHandle<'material'>;

/**
 * One thing on the turntable, assembled from any number of Pack outputs: scenes (a
 * rig.finish scene with its transformation clip, a whole-machine scene, static part
 * scenes) and plain meshes, all in one build space. Every AnimationPlayer of the scenes
 * follows the same transformation parameter u (each over its own clip duration).
 */
export interface ShowSubject {
  readonly name: string;
  readonly scenes?: readonly AssetHandle<'scene'>[];
  /** Plain meshes; `name` names the part. */
  readonly meshes?: readonly { readonly handle: AssetHandle<'mesh'>; readonly name: string }[];
  /** Materials by mesh slot name; slots without one use the Show palette. */
  readonly materials?: Readonly<Record<string, MaterialHandle>>;
  /** Part names drawn as X-ray shells during `xray` segments. */
  readonly xray?: readonly string[];
  /** The build history scrubbed during `history` segments. */
  readonly history?: ShowHistory;
  /** Materials by slot for the clean finish (the default when present); the weathered finish keeps the Pack's. */
  readonly clean?: Readonly<Record<string, MaterialHandle>>;
  /** One line about the subject (the page shows it under the caption). */
  readonly legend?: string;
  /** Where the geometry comes from (Pack, build function and stage). */
  readonly source?: string;
  /** Looks of slots without a material (linear color); others fall back to the Show palette. */
  readonly palette?: Readonly<
    Record<string, { readonly color: Triple; readonly metallic?: number; readonly roughness?: number }>
  >;
  /** Debug panel controls (default `COMMON_CONTROLS`); the panel shows the applicable ones. */
  readonly controls?: readonly ShowControl[];
  /**
   * A high-to-low bake case: parts named `high` are the high mesh, parts whose name starts with
   * `low` the low meshes, `plain` replaces their materials in the Plain look.
   */
  readonly bake?: { readonly high: string; readonly low: string; readonly plain: MaterialHandle };
}

/** What the debug panel shows for one subject. */
export interface ShowSubjectPanel {
  readonly name: string;
  readonly legend: string;
  readonly source: string;
  readonly controls: readonly ShowControl[];
  readonly parts: readonly string[];
}

export interface ShowOptions {
  readonly subjects: readonly ShowSubject[];
  readonly segments: readonly ShowSegment[];
  /** Drawing-buffer aspect of the camera (the Camera keeps it current with autoAspect). */
  readonly aspect?: number;
  /** Choreography: the stage pose of each instant of segment `index` (default `stagePose`). */
  readonly pose?: (kind: ShowSegment['kind'], u: number, index: number) => StagePose;
  /** Called after every update with the state on screen (a timeline UI mirrors it). */
  readonly observe?: (state: ShowState) => void;
  /**
   * The cooked SHOW_DISC_KEY material of show.pack.ts. With `renderTargets` the turntable
   * disc mirrors the subject through the camera's PlanarReflection; otherwise it is satin.
   */
  readonly disc?: MaterialHandle;
  /** Logical render target authoring of the realm (the Renderer, or the Worker Host bridge). */
  readonly renderTargets?: RenderTargetAuthoring;
}

/** Package of show.pack.ts and the source key of its polished disc (planar mirroring is cooked). */
export const SHOW_PACKAGE_ID = '01900000-0000-7000-8000-0000000c0111';
export const SHOW_DISC_KEY = 'material/disc';

/** Polished gunmetal turntable: the subject's mirror image stands on it at about a quarter strength. */
export function showDiscMaterial() {
  return Materials.standard({ baseColor: [0.25, 0.26, 0.28, 1], metallic: 1, roughness: 0.08, planarReflection: true });
}

/**
 * A camera around the form on stage: yaw about +y from +z and pitch above the horizon in
 * radians, distance in metres from the aim point, which `pan` offsets from the form's middle.
 */
export interface ShowView {
  readonly yaw: number;
  readonly pitch: number;
  readonly distance: number;
  readonly pan: Triple;
}

export type ShowCommand =
  | { readonly kind: 'play' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'seek'; readonly segment: number; readonly u: number }
  /** Hold a user view; without one the camera follows the choreography again. */
  | { readonly kind: 'view'; readonly view?: ShowView }
  /** Show or hide the floor and turntable discs (and their mirror). */
  | { readonly kind: 'floor'; readonly visible: boolean }
  /** Surface view of every part: curvature or zebra replace the surface, edges overlay it. */
  | { readonly kind: 'analysis'; readonly mode: ShowAnalysis }
  /** Clean paint (the subject's `clean` looks) or the Pack's weathered finish. */
  | { readonly kind: 'finish'; readonly mode: ShowFinish }
  /** Hidden parts (indices into the subject's part list). */
  | { readonly kind: 'hide'; readonly subject: number; readonly parts: readonly number[] }
  /** Bake case: which mesh level is on stage and whether it wears its baked or the plain material. */
  | { readonly kind: 'bake'; readonly mesh?: ShowBakeMesh; readonly material?: ShowBakeMaterial };

export type ShowFinish = 'clean' | 'weathered';
export type ShowBakeMesh = 'low' | 'high';
export type ShowBakeMaterial = 'baked' | 'plain';

export interface ShowState {
  readonly playing: boolean;
  readonly time: number;
  readonly segment: number;
  readonly kind: ShowSegment['kind'];
  readonly subject: string;
  readonly u: number;
  /** The camera on screen, whether the choreography or the user holds it. */
  readonly view: ShowView;
  /** Turntable yaw of the subject on stage; the subject's own +z faces yaw `spin`. */
  readonly spin: number;
  /** The user holds the camera (a view command or a drag on the canvas). */
  readonly free: boolean;
  readonly floor: boolean;
  /** Finish on the subject; `available` is false when the subject has no clean looks. */
  readonly finish: { readonly mode: ShowFinish; readonly available: boolean };
  /** Requested surface view and how many parts of the subject on stage show it so far. */
  readonly analysis: { readonly mode: ShowAnalysis; readonly done: number; readonly total: number };
  /** Hidden parts of the subject on stage. */
  readonly hidden: readonly number[];
  /** Bake case levels on stage; `available` is false for subjects without a bake. */
  readonly bake: { readonly mesh: ShowBakeMesh; readonly material: ShowBakeMaterial; readonly available: boolean };
  /** The history step on screen during `history` segments. */
  readonly step?: {
    readonly stage: string;
    readonly index: number;
    readonly count: number;
    readonly opIndex: number;
    readonly op: string;
    readonly label?: string;
    readonly source?: { readonly path: string; readonly line: number };
    readonly faces: number;
  };
}

export interface Show {
  command(command: ShowCommand): void;
  state(): ShowState;
  /** Panel facts of every subject, in subject order. */
  subjects(): readonly ShowSubjectPanel[];
  /** Applies the pose of the current cue; the Update system calls it every frame. */
  update(dt: number): void;
  dispose(): void;
}

/** Slot looks for modeling material names that come without a material asset. */
const PALETTE: Readonly<Record<string, { readonly color: Triple; readonly metallic: number; readonly roughness: number }>> = {
  Default: { color: [0.6, 0.62, 0.66], metallic: 0, roughness: 0.5 },
  steel: { color: [0.55, 0.57, 0.6], metallic: 1, roughness: 0.32 },
  chrome: { color: [0.9, 0.9, 0.92], metallic: 1, roughness: 0.08 },
  paint: { color: [0.62, 0.05, 0.04], metallic: 0, roughness: 0.22 },
  alu: { color: [0.8, 0.81, 0.83], metallic: 1, roughness: 0.28 },
  dark: { color: [0.08, 0.08, 0.09], metallic: 0.2, roughness: 0.45 },
  rubber: { color: [0.05, 0.05, 0.055], metallic: 0, roughness: 0.85 },
  rim: { color: [0.7, 0.71, 0.73], metallic: 1, roughness: 0.2 },
  glass: { color: [0.08, 0.1, 0.12], metallic: 0, roughness: 0.05 },
  trim: { color: [0.12, 0.12, 0.13], metallic: 0.5, roughness: 0.35 },
  highlight: { color: [1, 0.55, 0.1], metallic: 0, roughness: 0.4 },
};

const BLEND = {
  depthWriteEnabled: false,
  cullMode: 'none',
  blend: {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  },
} as const;

const FOV = (32 * Math.PI) / 180;
/** Canvas-pixel drag to radians, wheel notch to distance factor, user view limits. */
const ORBIT_RADIANS_PER_PIXEL = 0.005;
const ZOOM_PER_NOTCH = 1.12;
const PITCH_LIMIT: readonly [number, number] = [-0.15, 1.5];

/** The view of a camera at `eye` aiming at `target`, relative to the aim point `aim`. */
export function viewOf(eye: readonly number[], target: readonly number[], aim: readonly number[]): ShowView {
  const d = [0, 1, 2].map((k) => (eye[k] as number) - (target[k] as number));
  const distance = Math.hypot(d[0] as number, d[1] as number, d[2] as number) || 1;
  return {
    yaw: Math.atan2(d[0] as number, d[2] as number),
    pitch: Math.asin(Math.max(-1, Math.min(1, (d[1] as number) / distance))),
    distance,
    pan: [0, 1, 2].map((k) => (target[k] as number) - (aim[k] as number)) as Triple,
  };
}

/** Eye and aim point of `view` around `aim`. */
export function viewPose(view: ShowView, aim: readonly number[]): { eye: Triple; target: Triple } {
  const target = [0, 1, 2].map((k) => (aim[k] as number) + (view.pan[k] as number)) as Triple;
  const c = Math.cos(view.pitch);
  const dir: Triple = [c * Math.sin(view.yaw), Math.sin(view.pitch), c * Math.cos(view.yaw)];
  return { eye: [0, 1, 2].map((k) => (target[k] as number) + view.distance * (dir[k] as number)) as Triple, target };
}

/** Mouse gestures of one frame on the canvas: drag orbits, Shift or right drag pans, the wheel zooms. */
export interface OrbitInput {
  readonly dx: number;
  readonly dy: number;
  readonly pan: boolean;
  readonly wheel: number;
}

/** The view after one frame of gestures; distances stay within `range`, pitch above the floor. */
export function orbitView(view: ShowView, input: OrbitInput, range: readonly [number, number]): ShowView {
  if (input.pan) {
    // Move the aim point in the view plane, one view height per canvas height of drag.
    const scale = view.distance * 0.0015;
    const right: Triple = [Math.cos(view.yaw), 0, -Math.sin(view.yaw)];
    const s = Math.sin(view.pitch);
    const up: Triple = [-s * Math.sin(view.yaw), Math.cos(view.pitch), -s * Math.cos(view.yaw)];
    const pan = [0, 1, 2].map(
      (k) => (view.pan[k] as number) - input.dx * scale * (right[k] as number) + input.dy * scale * (up[k] as number),
    ) as Triple;
    return { ...view, pan, distance: zoomed(view.distance, input.wheel, range) };
  }
  return {
    yaw: view.yaw - input.dx * ORBIT_RADIANS_PER_PIXEL,
    pitch: Math.max(PITCH_LIMIT[0], Math.min(PITCH_LIMIT[1], view.pitch + input.dy * ORBIT_RADIANS_PER_PIXEL)),
    distance: zoomed(view.distance, input.wheel, range),
    pan: view.pan,
  };
}

function zoomed(distance: number, wheel: number, range: readonly [number, number]) {
  return Math.max(range[0], Math.min(range[1], distance * ZOOM_PER_NOTCH ** wheel));
}
/** Turntable disc center height and thickness: a thin plate just under the subject. */
const DISC_Y = -0.012;
const DISC_THICKNESS = 0.02;
/** Intensity of the flank kicker light (candela). */
const KICKER = 14;
/** Radius of the cyclorama sphere; its bottom is the floor. */
const CYC_RADIUS = 400;

interface Part {
  readonly entity: EntityHandle;
  readonly name: string;
  readonly materials: readonly MaterialHandle[];
  /** The same slots with the subject's clean looks, when any slot takes one. */
  readonly clean?: readonly MaterialHandle[];
  /** The part's own mesh; surface views replace it while shown. */
  readonly mesh: AssetHandle<'mesh'>;
  /** Surface views computed so far (none on failure), and the edge overlay entity. */
  readonly views: Map<ShowAnalysis, AssetHandle<'mesh'> | null>;
  overlay?: EntityHandle;
  /** Surface view now on the part. */
  shownView: ShowAnalysis;
  /** Authored local position; explode offsets from it. */
  readonly rest: Triple;
  /** Unit explode direction in the parent frame (world direction from the subject center at rest). */
  readonly away: Triple;
  /** The bake level of the part (undefined outside a bake case). */
  readonly level?: ShowBakeMesh;
  /** The part's slots in the plain material (bake cases). */
  readonly plain?: readonly MaterialHandle[];
  /** Visibility last written to the part (undefined before the first). */
  shown?: boolean;
}

interface Stage {
  readonly subject: ShowSubject;
  /** Turntable entity: yaw only, at the floor center. */
  readonly turntable: EntityHandle;
  /** Moves build space onto the turntable: the subject stands on y = 0, centered in x/z. */
  readonly offset: Triple;
  /** Holder of the subject's content; it lifts every form so its lowest point stands on the floor. */
  readonly content: EntityHandle;
  readonly parts: readonly Part[];
  /** Every AnimationPlayer of the subject's scenes; the transformation u drives them together. */
  readonly players: readonly { readonly entity: EntityHandle; readonly duration: number }[];
  /** Bounds in turntable space at rest; the subject stands on y = 0 centered in x/z. */
  readonly min: Triple;
  readonly max: Triple;
  readonly radius: number;
  readonly rails: Readonly<Record<CameraRail, PreparedPath>>;
  /** Center the rails were laid around. */
  readonly center: Triple;
  /** Floor-relative height range and bounding radius of the form at transformation parameter u. */
  readonly forms: readonly { readonly u: number; readonly height: readonly [number, number]; readonly radius: number }[];
  historyEntity?: EntityHandle;
  /** Looks last written to the parts (X-ray materials, hidden under a history state). */
  xray: boolean;
  historyOn: boolean;
  historyMeshes: Map<number, AssetHandle<'mesh'>>;
  hidden: ReadonlySet<number>;
}

function bakeLevel(subject: ShowSubject, name: string, slots: number): { level?: ShowBakeMesh; plain?: readonly MaterialHandle[] } {
  const bake = subject.bake;
  if (bake === undefined) return {};
  const level = name === bake.high ? 'high' : name.startsWith(bake.low) ? 'low' : undefined;
  return level === undefined ? {} : { level, plain: Array.from({ length: slots }, () => bake.plain) };
}

/** The form at transformation parameter u, interpolated between the measured samples. */
function formAt(stage: Stage, u: number): Stage['forms'][number] {
  const forms = stage.forms;
  const next = forms.findIndex((f) => f.u >= u);
  if (next === -1) return forms[forms.length - 1] as Stage['forms'][number];
  if (next === 0) return forms[0] as Stage['forms'][number];
  const a = forms[next - 1] as Stage['forms'][number];
  const b = forms[next] as Stage['forms'][number];
  const t = (u - a.u) / (b.u - a.u);
  const mix = (x: number, y: number) => x + (y - x) * t;
  return { u, height: [mix(a.height[0], b.height[0]), mix(a.height[1], b.height[1])], radius: mix(a.radius, b.radius) };
}

function lookQuat(eye: readonly number[], target: readonly number[]) {
  return quat.fromLookAt(quat.create(), eye as Triple, target as Triple, [0, 1, 0]);
}

function norm(v: readonly number[]): Triple {
  const l = Math.hypot(v[0] as number, v[1] as number, v[2] as number) || 1;
  return [(v[0] as number) / l, (v[1] as number) / l, (v[2] as number) / l];
}

function yaw(angle: number) {
  return quat.fromAxisAngle(quat.create(), [0, 1, 0], angle);
}

/** Camera rails around a subject of `radius` standing on the floor, centered at `center`. */
function rails(center: Triple, radius: number): Record<CameraRail, PreparedPath> {
  const r = Math.max(radius, 0.05);
  const ring = (distance: number, height: number, from: number, n = 8) =>
    Array.from({ length: n }, (_, i) => {
      const a = from + (2 * Math.PI * i) / n;
      return [center[0] + distance * Math.sin(a), center[1] + height, center[2] + distance * Math.cos(a)];
    }).flat();
  const make = (points: number[], closed: boolean) => {
    const prepared = preparePath({
      points: new Float32Array(points),
      closed,
      parameterization: PathParameterization.centripetal,
      subdivisions: 512,
      up: new Float32Array([0, 1, 0]),
    });
    if (!prepared.ok) throw prepared.error;
    return prepared.value;
  };
  return {
    orbit: make(ring(3.1 * r, 1.25 * r, Math.PI / 4), true),
    low: make(ring(2.7 * r, 0.35 * r, Math.PI / 3), true),
    // Front three-quarter, low across the side, high over the top, round to the other side.
    cinematic: make(
      [
        [2.6, 0.9, 2.2],
        [3.2, 0.35, 0.4],
        [2.0, 1.8, -1.6],
        [-0.6, 2.4, -2.4],
        [-2.6, 1.2, -0.8],
        [-2.4, 0.6, 1.9],
      ].flatMap(([x, y, z]) => [center[0] + (x as number) * r, center[1] + (y as number) * r, center[2] + (z as number) * r]),
      false,
    ),
  };
}

/**
 * Assemble the Show in `world`: studio lighting from a procedural HDR environment, a
 * polished floor with a turntable disc, one camera on code-driven Path rails, and every
 * subject on its own turntable (only the current one is visible). Each frame the
 * current cue's stage pose drives the ordinary owners: Scene transforms (turntable,
 * explode), the AnimationPlayer (transformation path), Camera ClippingPlanes (section),
 * MeshRenderer materials (X-ray) and history step meshes.
 */
export function createShow(world: World, assets: AssetRegistry, options: ShowOptions): Show {
  const { segments } = options;
  if (segments.some((s) => options.subjects[s.subject] === undefined)) {
    throw new Error('every Show segment names an existing subject');
  }
  const create = <T>(asset: Parameters<AssetRegistry['create']>[0]) => assets.create(asset).unwrap() as T;
  const looks = new Map<string, MaterialHandle>();
  const look = (slot: string, subject?: ShowSubject): MaterialHandle => {
    const own = subject?.palette?.[slot];
    const key = own === undefined ? slot : `${subject?.name}:${slot}`;
    let handle = looks.get(key);
    if (handle === undefined) {
      const l = own ?? PALETTE[slot] ?? (PALETTE.Default as NonNullable<(typeof PALETTE)[string]>);
      handle = create<MaterialHandle>(
        Materials.standard({ baseColor: [...l.color, 1], metallic: l.metallic ?? 0, roughness: l.roughness ?? 0.5 }),
      );
      looks.set(key, handle);
    }
    return handle;
  };
  const xrayMaterial = create<MaterialHandle>(
    Materials.standard({
      baseColor: [0.35, 0.75, 1, 0.16],
      emissive: [0.08, 0.25, 0.45],
      emissiveIntensity: 1,
      roughness: 0.3,
      queue: RenderQueue.Transparent,
      renderState: BLEND,
    } as never),
  );
  const spawn = (...components: ComponentData[]) => world.spawn(...components).unwrap();

  // Studio: environment light, key and rim lights, floor, camera.
  const environment = studioEnvironment({ width: 512, softbox: 1.6, wall: 0.1, floor: 0.02 });
  if (!environment.ok) throw environment.error;
  const equirect = create<AssetHandle<'equirect'>>(environment.value);
  const owned: EntityHandle[] = [];
  owned.push(spawn({ component: Skylight, data: { equirect, intensity: 1.15 } as never }));
  owned.push(
    spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.45, -0.8, -0.4],
        color: [1, 0.97, 0.92],
        intensity: 2.0,
        castShadow: true,
        shadowDistance: 20,
        mapSize: 2048,
      } as never,
    }),
  );
  // The renderer takes one directional light; a soft fill from the camera side and a rim from
  // behind are point lights, so the shadow side stays readable.
  owned.push(
    spawn({ component: Transform, data: { pos: [-5, 3, 6] } }, { component: PointLight, data: { color: [0.85, 0.9, 1], intensity: 25 } as never }),
    spawn({ component: Transform, data: { pos: [1, 4.5, -7] } }, { component: PointLight, data: { color: [1, 0.95, 0.9], intensity: 55 } as never }),
  );
  // A round plate (the 16-sided primitive reads as an octagon in close shots).
  const disc = create<AssetHandle<'mesh'>>(createCylinderGeometry(0.5, 0.5, 1, 96, 1).unwrap() as MeshAsset);
  const discTop = (assets.read(disc).unwrap() as MeshAsset).aabb?.[4] ?? 0.5;
  const mirrored = options.disc !== undefined && options.renderTargets !== undefined;
  const discMaterial = mirrored
    ? (options.disc as MaterialHandle)
    : create<MaterialHandle>(Materials.standard({ baseColor: [0.05, 0.052, 0.058, 1], metallic: 0, roughness: 0.65 }));
  // A low kicker on the left flank: its reflection slides along the doors as the camera tracks.
  const kicker = spawn(
    { component: Transform, data: { pos: [6, 0.9, 1.5] } },
    { component: PointLight, data: { color: [1, 0.97, 0.94], intensity: KICKER } as never },
  );
  owned.push(kicker);
  let kickerOn = 1;
  // A cyclorama: the floor is the bottom of a large matte sphere seen from inside, so it curves
  // up into the backdrop without a seam (dense enough to be flat under the turntable).
  const dome = create<AssetHandle<'mesh'>>(createSphereGeometry(1, 512, 256).unwrap() as MeshAsset);
  const domeMaterial = create<MaterialHandle>(
    Materials.standard({ baseColor: [0.06, 0.062, 0.068, 1], metallic: 0, roughness: 1, renderState: { cullMode: 'front' } } as never),
  );
  const floor = spawn(
      { component: Name, data: { value: 'show.floor' } },
      { component: Transform, data: { pos: [0, CYC_RADIUS - 0.01, 0], scale: [CYC_RADIUS, CYC_RADIUS, CYC_RADIUS] } },
      { component: MeshFilter, data: { assetHandle: dome } },
      { component: MeshRenderer, data: { materials: [domeMaterial] } },
      // It receives the subject's shadow but casts none (the lights are outside it).
      { component: ShadowParticipation, data: { cast: false } },
  );
  owned.push(floor);
  const discs: EntityHandle[] = [];
  const camera = spawn(
    { component: Name, data: { value: 'show.camera' } },
    { component: Transform, data: { pos: [3, 1.5, 3], quat: lookQuat([3, 1.5, 3], [0, 0.4, 0]) } },
    {
      component: Camera,
      data: {
        ...perspective({ fov: FOV, aspect: options.aspect ?? 16 / 9, near: 0.02, far: 1000 }),
        clearColor: [0.025, 0.026, 0.03, 1],
        tonemap: TONEMAP_ACES_FILMIC,
        exposure: 1,
        antialias: ANTIALIAS_FXAA,
        bloom: BLOOM_ENABLED,
        bloomThreshold: 2,
        bloomIntensity: 0.1,
      } as never,
    },
  );
  owned.push(camera);
  world.addComponent(camera, { component: ClippingPlanes, data: clippingPlanesData({ planes: [] }) }).unwrap();
  // Every disc top (y = -0.012 + 0.02 * top of the unit cylinder) lies on the reflection plane.
  let reflection: RenderTarget | undefined;
  let reflectionData: ComponentData | undefined;
  if (mirrored) {
    const created = (options.renderTargets as RenderTargetAuthoring).createRenderTarget({
      shape: '2d',
      width: 960,
      height: 540,
      format: 'rgba16float',
      sampleCount: 1,
      mipLevels: 1,
      sampled: true,
      readback: false,
    });
    if (!created.ok) throw created.error;
    reflection = created.value;
    reflectionData = {
      component: PlanarReflection,
      data: { target: world.allocSharedRef('RenderTarget', reflection), distance: -(DISC_Y + DISC_THICKNESS * discTop) },
    };
    world.addComponent(camera, reflectionData).unwrap();
  }

  const scenes: EntityHandle[] = [];
  const stages = options.subjects.map((subject) => stageSubject(subject));

  function stageSubject(subject: ShowSubject): Stage {
    const turntable = spawn(
      { component: Name, data: { value: `show.turntable.${subject.name}` } },
      { component: Transform, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    );
    owned.push(turntable);
    // One holder moves build space onto the turntable; every Pack output hangs under it.
    const content = spawn({ component: Name, data: { value: subject.name } }, { component: Transform, data: {} });
    owned.push(content);
    world.addComponent(content, { component: ChildOf, data: { parent: turntable } }).unwrap();
    const players: { readonly entity: EntityHandle; readonly duration: number }[] = [];
    const partEntities: EntityHandle[] = [];
    for (const scene of subject.scenes ?? []) {
      const root = assets.instantiate(scene, world).unwrap();
      scenes.push(root);
      world.addComponent(root, { component: ChildOf, data: { parent: content } }).unwrap();
      const mapping = world.get(root, SceneInstance).unwrap().mapping;
      const spawned = [...mapping].filter((e) => e !== ENTITY_NULL_RAW).map((e) => e as EntityHandle);
      const targets = spawned.filter((e) => world.hasComponent(e, AnimationTargetId));
      for (const entity of spawned.filter((e) => world.hasComponent(e, AnimationPlayer))) {
        bindAnimationTargets(world, entity, targets).unwrap();
        const clip = world.get(entity, AnimationPlayer).unwrap().clips[0];
        const duration = clip === undefined ? 0 : (assets.read(clip as never).unwrap() as { duration: number }).duration;
        world.set(entity, AnimationPlayer, { paused: true, times: [0] } as never).unwrap();
        players.push({ entity, duration });
      }
      partEntities.push(...spawned.filter((e) => world.hasComponent(e, MeshFilter)));
    }
    for (const mesh of subject.meshes ?? []) {
      const entity = spawn(
        { component: Name, data: { value: mesh.name } },
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent: content } },
        { component: MeshFilter, data: { assetHandle: mesh.handle } },
        { component: MeshRenderer, data: { materials: [] } },
      );
      owned.push(entity);
      partEntities.push(entity);
    }
    if (partEntities.length === 0) throw new Error(`Show subject ${subject.name} has no mesh in its scenes or meshes`);
    // Authored scene materials stay unless the subject overrides their slot.
    const slotMaterials = (mesh: MeshAsset, authored: readonly unknown[]) =>
      mesh.materialSlots.map(
        (slot, i) =>
          subject.materials?.[slot.slotName] ??
          (authored.length === mesh.materialSlots.length ? (authored[i] as MaterialHandle) : undefined) ??
          look(slot.slotName, subject),
      );
    const partMeshes = partEntities.map((entity) => {
      const handle = world.get(entity, MeshFilter).unwrap().assetHandle as AssetHandle<'mesh'>;
      const mesh = assets.read(handle).unwrap() as MeshAsset;
      const materials = slotMaterials(mesh, world.get(entity, MeshRenderer).unwrap().materials as readonly unknown[]);
      world.set(entity, MeshRenderer, { materials } as never).unwrap();
      return { entity, mesh, handle, materials };
    });
    // Bounds in the content frame from the propagated part transforms at path parameter u.
    const measure = (u: number) => {
      for (const p of players) world.set(p.entity, AnimationPlayer, { paused: true, times: [u * p.duration] } as never).unwrap();
      world.update(0);
      const min: Triple = [Infinity, Infinity, Infinity];
      const max: Triple = [-Infinity, -Infinity, -Infinity];
      const centers = partMeshes.map(({ entity, mesh }) => {
        const m = world.get(entity, GlobalTransform).unwrap().world;
        const box = mesh.aabb;
        const lo = [box?.[0] ?? 0, box?.[1] ?? 0, box?.[2] ?? 0];
        const hi = [box?.[3] ?? 0, box?.[4] ?? 0, box?.[5] ?? 0];
        const c: Triple = [0, 0, 0];
        for (let corner = 0; corner < 8; corner++) {
          const p = [corner & 1 ? hi[0] : lo[0], corner & 2 ? hi[1] : lo[1], corner & 4 ? hi[2] : lo[2]] as Triple;
          for (let k = 0; k < 3; k++) {
            const w =
              (m[k] as number) * p[0] + (m[4 + k] as number) * p[1] + (m[8 + k] as number) * p[2] + (m[12 + k] as number);
            min[k] = Math.min(min[k] as number, w);
            max[k] = Math.max(max[k] as number, w);
            c[k] = (c[k] as number) + w / 8;
          }
        }
        return c;
      });
      return { min, max, centers };
    };
    // The camera frames every form along the transformation; explode works from rest.
    const samples = players.length === 0 ? [] : Array.from({ length: 20 }, (_, i) => (i + 1) / 20);
    const path = samples.map(measure);
    const rest = measure(0);
    const { centers } = rest;
    const min: Triple = [...rest.min];
    const max: Triple = [...rest.max];
    for (const b of path) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] as number, b.min[k] as number);
        max[k] = Math.max(max[k] as number, b.max[k] as number);
      }
    }
    // Stand the subject on the floor, centered over the turntable axis.
    // The lowest point over the path stands on the floor, so no form sinks into it.
    const offset: Triple = [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2];
    world.set(content, Transform, { pos: offset } as never).unwrap();
    // The turntable disc: a thin plate just under the subject's footprint.
    const footprint = 0.62 * Math.hypot(max[0] - min[0], max[2] - min[2]);
    const discEntity = spawn(
      { component: Name, data: { value: `show.disc.${subject.name}` } },
      { component: Transform, data: { pos: [0, DISC_Y, 0], scale: [2 * footprint, DISC_THICKNESS, 2 * footprint] } },
      { component: ChildOf, data: { parent: turntable } },
      { component: MeshFilter, data: { assetHandle: disc } },
      { component: MeshRenderer, data: { materials: [discMaterial] } },
    );
    owned.push(discEntity);
    discs.push(discEntity);
    const lo: Triple = [min[0] + offset[0], min[1] + offset[1], min[2] + offset[2]];
    const hi: Triple = [max[0] + offset[0], max[1] + offset[1], max[2] + offset[2]];
    const center: Triple = [0, (lo[1] + hi[1]) / 2, 0];
    const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
    // The form's own height and size along the path, so the camera frames the current form.
    const forms = [{ u: 0, ...rest }, ...path.map((b, i) => ({ u: samples[i] as number, ...b }))].map((b) => ({
      u: b.u,
      height: [b.min[1] + offset[1], b.max[1] + offset[1]] as const,
      radius: Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2,
    }));
    const parts = partMeshes.map(({ entity, handle, mesh, materials }, i): Part => {
      const cleanSlots = mesh.materialSlots.map((slot, k) => subject.clean?.[slot.slotName] ?? (materials[k] as MaterialHandle));
      const clean = cleanSlots.some((m, k) => m !== materials[k]) ? cleanSlots : undefined;
      // The clean finish is the default.
      if (clean !== undefined) world.set(entity, MeshRenderer, { materials: clean } as never).unwrap();
      const c = centers[i] as Triple;
      const d: Triple = [c[0] + offset[0] - center[0], c[1] + offset[1] - center[1], c[2] + offset[2] - center[2]];
      const length = Math.hypot(...d);
      const world3: Triple = length < 1e-6 ? [0, 1, 0] : [d[0] / length, d[1] / length, d[2] / length];
      // The part Transform is local to its parent: rotate the world direction into it.
      const parent = world.get(entity, ChildOf);
      const pm = parent.ok ? world.get(parent.value.parent as EntityHandle, GlobalTransform).unwrap().world : undefined;
      const away: Triple = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const axis = pm === undefined ? [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0] : [pm[k * 4], pm[k * 4 + 1], pm[k * 4 + 2]];
        const n = Math.hypot(...(axis as number[])) || 1;
        away[k] = ((axis[0] as number) * world3[0] + (axis[1] as number) * world3[1] + (axis[2] as number) * world3[2]) / n / n;
      }
      const name = world.get(entity, Name);
      const rest = [...world.get(entity, Transform).unwrap().pos] as Triple;
      return {
        entity,
        name: name.ok ? name.value.value : subject.name,
        materials,
        ...(clean === undefined ? {} : { clean }),
        mesh: handle,
        ...bakeLevel(subject, name.ok ? name.value.value : subject.name, materials.length),
        views: new Map(),
        shownView: 'off',
        rest,
        away,
      };
    });
    const stage: Stage = {
      subject,
      turntable,
      offset,
      content,
      parts,
      players,
      min: lo,
      max: hi,
      radius,
      center,
      forms,
      rails: rails(center, radius),
      xray: true,
      historyOn: true,
      historyMeshes: new Map(),
      hidden: new Set(),
    };
    return stage;
  }

  let time = 0;
  let playing = true;
  let shown: Stage | undefined;
  let cue: ShowCue = cueAt(segments, 0);
  let step: ShowState['step'];
  const sample = createPathSample();
  /** The user's view; undefined while the choreography holds the camera. */
  let held: ShowView | undefined;
  let view: ShowView = { yaw: 0, pitch: 0, distance: 1, pan: [0, 0, 0] };
  let spin = 0;
  let analysis: ShowAnalysis = 'off';
  let finish: ShowFinish = 'clean';
  /** The part's materials in the current finish. */
  let bakeMesh: ShowBakeMesh = 'low';
  let bakeMaterial: ShowBakeMaterial = 'baked';
  const ownMaterials = (part: Part) =>
    bakeMaterial === 'plain' && part.plain !== undefined
      ? part.plain
      : finish === 'clean' && part.clean !== undefined
        ? part.clean
        : part.materials;
  /** Whether the bake level of the part is the one on stage (parts outside a bake case always are). */
  const onLevel = (part: Part) => part.level === undefined || part.level === bakeMesh;
  let analysisMaterials: { readonly surface: MaterialHandle; readonly edges: MaterialHandle } | undefined;
  /** Part view budget per frame: surface analysis is CPU work on the World realm. */
  const ANALYSIS_BUDGET_MS = 25;
  // A fixed light-tube frame for zebra stripes (front, slightly above), in world space.
  const ZEBRA_WORLD = { direction: norm([0.25, 0.45, 0.86]), right: norm([0.96, 0, -0.28]), up: [0, 1, 0] as Triple };

  /** Turn a world direction into the part's local frame (inverse rotation of its world matrix). */
  function localDirection(entity: EntityHandle, d: Triple): Triple {
    const m = world.get(entity, GlobalTransform).unwrap().world;
    const out = [0, 1, 2].map((k) => {
      const axis = [m[k * 4] as number, m[k * 4 + 1] as number, m[k * 4 + 2] as number];
      const n = Math.hypot(axis[0] as number, axis[1] as number, axis[2] as number) || 1;
      return ((axis[0] as number) * d[0] + (axis[1] as number) * d[1] + (axis[2] as number) * d[2]) / n;
    }) as Triple;
    return norm(out);
  }

  /** Shows `mode` on one part, computing its view on first use; false when the view failed. */
  function showView(part: Part, mode: ShowAnalysis): boolean {
    let view = mode === 'off' ? null : part.views.get(mode);
    if (mode !== 'off' && view === undefined) {
      const mesh = assets.read(part.mesh).unwrap() as MeshAsset;
      const built = analysisMesh(mesh, mode, {
        direction: localDirection(part.entity, ZEBRA_WORLD.direction),
        right: localDirection(part.entity, ZEBRA_WORLD.right),
        up: localDirection(part.entity, ZEBRA_WORLD.up),
      });
      view = built.ok ? create<AssetHandle<'mesh'>>(built.value) : null;
      part.views.set(mode, view);
    }
    analysisMaterials ??= {
      surface: create<MaterialHandle>(Materials.unlit([1, 1, 1, 1])),
      edges: create<MaterialHandle>(Materials.unlit([0.02, 0.02, 0.025, 1])),
    };
    const surface = mode === 'curvature' || mode === 'zebra' ? view : null;
    world.set(part.entity, MeshFilter, { assetHandle: surface ?? part.mesh } as never).unwrap();
    world.set(part.entity, MeshRenderer, { materials: surface ? [analysisMaterials.surface] : ownMaterials(part) } as never).unwrap();
    const edges = mode === 'edges' ? view : null;
    if (edges && part.overlay === undefined) {
      part.overlay = spawn(
        { component: Name, data: { value: `show.edges.${part.name}` } },
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent: part.entity } },
        { component: MeshFilter, data: { assetHandle: edges } },
        { component: MeshRenderer, data: { materials: [analysisMaterials.edges] } },
        { component: Visibility, data: { state: VisibilityStateValue.inherited } },
      );
      owned.push(part.overlay);
    } else if (part.overlay !== undefined) {
      visible(part.overlay, edges ? VisibilityStateValue.inherited : VisibilityStateValue.hidden);
    }
    part.shownView = mode;
    return view !== null || mode === 'off';
  }

  /** Brings the parts of the subject on stage to the requested view within the frame budget. */
  function advanceAnalysis(stage: Stage) {
    const start = performance.now();
    for (const part of stage.parts) {
      if (part.shownView === analysis || !onLevel(part)) continue;
      if (performance.now() - start > ANALYSIS_BUDGET_MS) return;
      showView(part, analysis);
    }
  }
  let floorVisible = true;
  let dragFrom: { readonly x: number; readonly y: number } | undefined;

  function setFloor(on: boolean) {
    if (on === floorVisible) return;
    floorVisible = on;
    const state = on ? VisibilityStateValue.inherited : VisibilityStateValue.hidden;
    for (const entity of [floor, ...discs]) visible(entity, state);
    // Without a disc nothing samples the mirror; drop its capture too.
    if (reflectionData === undefined) return;
    if (on) world.addComponent(camera, reflectionData).unwrap();
    else world.removeComponent(camera, PlanarReflection).unwrap();
  }

  /** One frame of canvas gestures from the frozen input snapshot (none without the input plugin). */
  function gestures(): OrbitInput | undefined {
    if (!world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)) return undefined;
    const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    const position = snap.mouse.position;
    const pan = snap.mouse.button(2) || (snap.mouse.button(0) && snap.keyboard.down('Shift'));
    const dragging = snap.mouse.button(0) || snap.mouse.button(2);
    const from = dragFrom;
    dragFrom = dragging && position !== undefined ? { x: position.x, y: position.y } : undefined;
    const dx = from === undefined || dragFrom === undefined ? 0 : dragFrom.x - from.x;
    const dy = from === undefined || dragFrom === undefined ? 0 : dragFrom.y - from.y;
    const wheel = snap.mouse.wheelDelta;
    return dx === 0 && dy === 0 && wheel === 0 ? undefined : { dx, dy, pan, wheel };
  }

  function visible(entity: EntityHandle, state: number) {
    if (world.hasComponent(entity, Visibility)) world.set(entity, Visibility, { state } as never).unwrap();
    else world.addComponent(entity, { component: Visibility, data: { state } as never }).unwrap();
  }

  function showHistory(stage: Stage, u: number | undefined) {
    const history = stage.subject.history;
    if (u === undefined || history === undefined) {
      if (stage.historyEntity !== undefined) {
        visible(stage.historyEntity, VisibilityStateValue.hidden);
      }
      step = undefined;
      return false;
    }
    const index = Math.min(history.steps.length - 1, Math.floor(u * history.steps.length));
    let handle = stage.historyMeshes.get(index);
    const mesh = history.mesh(index);
    if (handle === undefined) {
      handle = create<AssetHandle<'mesh'>>(mesh);
      stage.historyMeshes.set(index, handle);
    }
    const data = {
      materials: mesh.materialSlots.map((slot) => stage.subject.materials?.[slot.slotName] ?? look(slot.slotName)),
    };
    if (stage.historyEntity === undefined) {
      stage.historyEntity = spawn(
        { component: Name, data: { value: `show.history.${stage.subject.name}` } },
        { component: Transform, data: { pos: stage.offset } },
        { component: ChildOf, data: { parent: stage.turntable } },
        { component: MeshFilter, data: { assetHandle: handle } },
        { component: MeshRenderer, data: data as never },
        // Inherited, not visible: `visible` would override the hidden turntable of a subject off stage.
        { component: Visibility, data: { state: VisibilityStateValue.inherited } },
      );
      owned.push(stage.historyEntity);
    } else {
      world.set(stage.historyEntity, MeshFilter, { assetHandle: handle } as never).unwrap();
      world.set(stage.historyEntity, MeshRenderer, data as never).unwrap();
      visible(stage.historyEntity, VisibilityStateValue.inherited);
    }
    const s = history.steps[index] as NonNullable<ShowHistory['steps'][number]>;
    step = {
      stage: s.stage,
      index,
      count: history.steps.length,
      opIndex: s.opIndex,
      op: s.op,
      ...(s.label === undefined ? {} : { label: s.label }),
      ...(s.source === undefined ? {} : { source: { path: s.source.path, line: s.source.line } }),
      faces: s.faces,
    };
    return true;
  }

  function apply(stage: Stage, pose: StagePose) {
    if (shown !== stage) {
      if (shown !== undefined) {
        visible(shown.turntable, VisibilityStateValue.hidden);
      }
      visible(stage.turntable, VisibilityStateValue.inherited);
      shown = stage;
    }
    world.set(stage.turntable, Transform, { quat: yaw(pose.spin) } as never).unwrap();
    if ((pose.kicker ?? 1) !== kickerOn) {
      kickerOn = pose.kicker ?? 1;
      world.set(kicker, PointLight, { intensity: KICKER * kickerOn } as never).unwrap();
    }
    // Every form along the transformation stands on the floor (no hovering car, no sunk robot).
    const resting = formAt(stage, pose.transform);
    const lift = -resting.height[0];
    world
      .set(stage.content, Transform, { pos: [stage.offset[0], stage.offset[1] + lift, stage.offset[2]] } as never)
      .unwrap();
    spin = pose.spin;
    for (const player of stage.players) {
      world.set(player.entity, AnimationPlayer, { paused: true, times: [pose.transform * player.duration] } as never).unwrap();
    }
    const historyOn = showHistory(stage, pose.history);
    const reach = 0.45 * stage.radius * pose.explode;
    const looksChanged = stage.xray !== pose.xray || stage.historyOn !== historyOn;
    for (const [i, part] of stage.parts.entries()) {
      world.set(part.entity, Transform, { pos: part.away.map((a, k) => (part.rest[k] as number) + a * reach) } as never).unwrap();
      const onStage = !historyOn && !stage.hidden.has(i) && onLevel(part);
      if (part.shown !== onStage) {
        visible(part.entity, onStage ? VisibilityStateValue.inherited : VisibilityStateValue.hidden);
        part.shown = onStage;
      }
      if (!looksChanged) continue;
      // X-ray and history looks start from the part's own surface; the view returns after.
      if (part.shownView !== 'off') showView(part, 'off');
      world
        .set(part.entity, MeshRenderer, {
          materials:
            pose.xray && stage.subject.xray?.includes(part.name) === true ? part.materials.map(() => xrayMaterial) : ownMaterials(part),
        } as never)
        .unwrap();
    }
    stage.xray = pose.xray;
    stage.historyOn = historyOn;
    // Section: cut away x > plane above the floor (the planes clip their intersection).
    const planes: [number, number, number, number][] = [];
    if (pose.section !== undefined) {
      const x = stage.max[0] - pose.section * (stage.max[0] - stage.min[0]);
      planes.push([-1, 0, 0, x], [0, -1, 0, 0.002]);
    }
    // Caps shade the cut as a solid section instead of the hollow inside.
    world.set(camera, ClippingPlanes, clippingPlanesData({ planes, intersection: true, caps: true }) as never).unwrap();
    const rail = stage.rails[pose.camera.rail];
    rail.sample(sample, (((pose.camera.u % 1) + 1) % 1) * rail.length);
    // Frame the form on stage now; a user view replaces the choreographed camera.
    const form = { ...resting, height: [0, resting.height[1] + lift] as const };
    const choreographed = pose.shot === undefined ? railPose(stage, form, pose.camera.zoom) : shoot(form, pose.shot, pose.spin);
    const input = gestures();
    if (input !== undefined) held = orbitView(held ?? view, input, [0.3 * stage.radius, 8 * stage.radius]);
    view = held ?? viewOf(choreographed.eye, choreographed.target, choreographed.target);
    const { eye, target } = held === undefined ? choreographed : viewPose(held, choreographed.target);
    world.set(camera, Transform, { pos: eye, quat: lookQuat(eye, target) } as never).unwrap();
  }

  let lens = FOV;
  function setLens(fov: number) {
    if (fov === lens) return;
    lens = fov;
    world.set(camera, Camera, { fov } as never).unwrap();
  }

  /** The rail camera at the sampled position, aimed at the form's middle and scaled to its size. */
  function railPose(stage: Stage, form: Stage['forms'][number], railZoom: number | undefined) {
    setLens(FOV);
    const target: Triple = [0, form.height[0] + (form.height[1] - form.height[0]) * 0.48, 0];
    const zoom = (railZoom ?? 1) * Math.max(0.35, form.radius / stage.radius);
    const eye = [0, 1, 2].map((k) => (target[k] as number) + ((sample.position[k] as number) - (stage.center[k] as number)) * zoom) as Triple;
    return { eye, target };
  }

  function shoot(form: Stage['forms'][number], shot: NonNullable<StagePose['shot']>, spin: number) {
    const fov = 2 * Math.atan(12 / shot.lensMm);
    setLens(fov);
    const height = form.height[1] - form.height[0];
    const target: Triple = [0, form.height[0] + height * shot.aim, 0];
    const aspect = options.aspect ?? 16 / 9;
    // Fit the height, and the footprint diameter across the (wider) horizontal field.
    const tall = height / shot.fill / 2 / Math.tan(fov / 2);
    // The fill sets the height; the width only needs to stay inside the frame.
    const wide = (1.6 * form.radius) / Math.min(0.9, shot.fill * 2) / 2 / (Math.tan(fov / 2) * aspect);
    const distance = shot.crop === true ? tall : Math.max(tall, wide);
    const azimuth = shot.azimuth + spin;
    const dir = [Math.cos(shot.pitch) * Math.sin(azimuth), Math.sin(shot.pitch), Math.cos(shot.pitch) * Math.cos(azimuth)];
    const eye = [0, 1, 2].map((k) => (target[k] as number) + (dir[k] as number) * distance) as Triple;
    return { eye, target };
  }

  const show: Show = {
    command(command) {
      switch (command.kind) {
        case 'play':
          playing = true;
          return;
        case 'pause':
          playing = false;
          return;
        case 'seek':
          time = timeOf(segments, Math.max(0, Math.min(segments.length - 1, command.segment)), command.u);
          return;
        case 'view':
          held = command.view;
          return;
        case 'analysis':
          analysis = command.mode;
          return;
        case 'finish':
          finish = command.mode;
          // Parts showing their own surface take the new finish now; surface views keep theirs.
          for (const stage of stages)
            for (const part of stage.parts)
              if (part.shownView === 'off' || part.shownView === 'edges')
                world.set(part.entity, MeshRenderer, { materials: ownMaterials(part) } as never).unwrap();
          return;
        case 'floor':
          setFloor(command.visible);
          return;
        case 'bake':
          bakeMesh = command.mesh ?? bakeMesh;
          bakeMaterial = command.material ?? bakeMaterial;
          for (const stage of stages)
            for (const part of stage.parts)
              if (part.level !== undefined && (part.shownView === 'off' || part.shownView === 'edges'))
                world.set(part.entity, MeshRenderer, { materials: ownMaterials(part) } as never).unwrap();
          return;
        case 'hide': {
          const stage = stages[command.subject];
          if (stage !== undefined) stage.hidden = new Set(command.parts);
          return;
        }
      }
    },
    state() {
      const subject = options.subjects[cue.segment.subject] as ShowSubject;
      return {
        playing,
        time,
        segment: cue.index,
        kind: cue.segment.kind,
        subject: subject.name,
        u: cue.u,
        view,
        spin,
        free: held !== undefined,
        finish: { mode: finish, available: (stages[cue.segment.subject] as Stage).parts.some((p) => p.clean !== undefined) },
        analysis: {
          mode: analysis,
          done: (stages[cue.segment.subject] as Stage).parts.filter((p) => onLevel(p) && p.shownView === analysis).length,
          total: (stages[cue.segment.subject] as Stage).parts.filter(onLevel).length,
        },
        floor: floorVisible,
        hidden: [...(stages[cue.segment.subject] as Stage).hidden],
        bake: {
          mesh: bakeMesh,
          material: bakeMaterial,
          available: (stages[cue.segment.subject] as Stage).parts.some((p) => p.level !== undefined),
        },
        ...(step === undefined ? {} : { step }),
      };
    },
    subjects() {
      return stages.map((stage) => ({
        name: stage.subject.name,
        legend: stage.subject.legend ?? '',
        source: stage.subject.source ?? '',
        parts: stage.parts.map((part) => part.name),
        controls: applicableControls(stage.subject.controls ?? COMMON_CONTROLS, {
          parts: stage.parts.length,
          clean: stage.parts.some((part) => part.clean !== undefined),
          mechanism: stage.players.length > 0,
        }),
      }));
    },
    update(dt) {
      if (playing) time += dt;
      cue = cueAt(segments, time);
      const stage = stages[cue.segment.subject] as Stage;
      apply(stage, cuePose(cue.segment, cue.u, options.pose, cue.index));
      advanceAnalysis(stage);
      options.observe?.(show.state());
    },
    dispose() {
      world.removeSystem(Update, SYSTEM);
      for (const root of scenes) worldDespawnScene(world, root).unwrap();
      for (const entity of owned.reverse()) world.despawn(entity).unwrap();
      if (reflection !== undefined) options.renderTargets?.destroyRenderTarget(reflection);
    },
  };
  const SYSTEM = 'modeling-show.director';
  world
    .addSystem(Update, {
      name: SYSTEM,
      queries: [],
      // Gestures read the snapshot the input plugin froze this frame (when the realm has one).
      after: [FRAME_START_SCAN_SYSTEM_NAME],
      before: [ADVANCE_ANIMATION_PLAYER_SYSTEM],
      fn: (world) => show.update(world.getResource(Time).delta),
    })
    .unwrap();
  return show;
}
