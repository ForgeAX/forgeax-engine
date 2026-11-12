import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import { type Handle, toShared } from '@forgeax/engine-types';
import { selectCaptureViewCamera } from '../capture/capture-view';
import {
  assertCameraViewData,
  assertRenderShortSide,
  CAMERA_VIEW_DEFAULTS,
  cameraViewExtent,
} from '../components/camera-view';
import { type StereoEye, stereoEyeViewport } from '../components/stereo-camera';
import { CameraViewInvalidError } from '../errors/render';
import type { PreparedRenderPublication, RenderPublicationReceiver } from '../publication/receiver';
import type {
  CameraSnapshot,
  DrawOwnerOptions,
  PhysicalViewExtent,
  ResolvedViewCamera,
} from '../render-contract';
import { cameraForView, resolveCameraTarget, selectCameraRoles } from '../render-system-extract';
import type { RenderTarget } from '../targets/contracts';
import { RenderCommit, RenderExtract, renderSubmission } from './render-world';
import { requireViewField } from './view-field';

/** Eye column of a composed view: a mono CameraView or one stereo eye of it. */
export const ViewEyeValue = Object.freeze({ mono: 0, left: 1, right: 2 } as const);
/** Composite channel column: every channel, or one anaglyph eye's channels. */
export const ViewChannelsValue = Object.freeze({ all: 0, red: 1, cyan: 2 } as const);

/**
 * A view in the Render World: one CameraView, or one stereo eye of it, with
 * its authored (eye-derived) rectangle, cadence and target; or a capture view
 * (`capture`), an auxiliary Camera that writes its RenderTarget as a raw
 * linear scene capture and is never composited; or the primary view
 * (`primary`), the Renderer's own recorder. The primary view records the
 * display while no display CameraView is declared; otherwise it is the shared
 * capture view (`capture`): the scene captures every composed view samples,
 * recorded from the first enabled composed view's camera.
 */
export const RenderView = defineComponent('RenderView', {
  capture: 'bool',
  /** The primary recorder's view: the display, or the shared capture view (`capture`). */
  primary: 'bool',
  camera: 'u32',
  eye: { type: 'enum', default: ViewEyeValue.mono, labels: ViewEyeValue },
  viewport: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 1, 1]) },
  order: 'i32',
  resolutionScale: { type: 'f32', default: 1 },
  maxRenderShortSide: { type: 'u32', default: 0 },
  updateInterval: { type: 'u32', default: 1 },
  enabled: { type: 'bool', default: true },
  channels: { type: 'enum', default: ViewChannelsValue.all, labels: ViewChannelsValue },
  viewGeneration: 'u32',
  attachment: 'string',
  target: 'shared<RenderTarget>',
});

/** A view's canvas rectangle in physical pixels and its scaled recording size. */
export type ViewViewport = ReturnType<typeof cameraViewExtent>;

/**
 * Payload of a view's {@link ViewCamera}: its recording extent, canvas
 * rectangle and final camera, resolved by the `render-view-cameras`
 * RenderExtract system before RenderPrepare. `extent` is replaced only when
 * its size changes. An unresident RenderTarget keeps the last extent; the
 * recording then fails on residency.
 */
export interface ViewCameraState extends ResolvedViewCamera {
  extent: PhysicalViewExtent;
  viewport: ViewViewport;
  camera: CameraSnapshot | undefined;
}

/** Every view entity's resolved camera; written only by `render-view-cameras`. */
export const ViewCamera = defineComponent('ViewCamera', { state: 'unique<ViewCamera>' });

/** The resolved camera of a view entity; undefined once the entity retired. */
export function viewCameraOf(
  world: World,
  entity: EntityHandle | undefined,
): ViewCameraState | undefined {
  if (entity === undefined || !world.hasComponent(entity, ViewCamera)) return undefined;
  return world
    .resolveUniqueRef<ViewCameraState>(requireViewField(world, entity, ViewCamera, 'state'))
    .unwrap();
}

/**
 * A composed view's resolved camera, which replaces its recording's display
 * camera selection; undefined for the primary and capture views, whose
 * recordings select their camera from the extracted frame.
 */
export function composedViewCamera(
  world: World,
  entity: EntityHandle | undefined,
): ViewCameraState | undefined {
  if (entity === undefined || !world.hasComponent(entity, RenderView)) return undefined;
  const view = world.get(entity, RenderView).unwrap();
  return view.primary || view.capture ? undefined : viewCameraOf(world, entity);
}

/**
 * The view's private recording state (its RenderSystem, device scope, output
 * and history). Present only while the view is enabled; removal or despawn
 * releases it through the payload's own retirement.
 */
export const ViewRecorder = defineComponent('ViewRecorder', { state: 'unique<ViewRecorder>' });

/**
 * The outcome of the view's last record attempt: `attempt` is the renderer
 * frame it ran in (the last attempt of a frame wins), `accepted` whether its
 * recording was submitted, `scene` whether that submission drew the scene
 * (not only a preparation barrier) and `temporal` whether it staged temporal
 * history. RenderCommit systems commit a view's own state only for an
 * accepted attempt of the current frame.
 */
export const ViewSubmission = defineComponent('ViewSubmission', {
  accepted: 'bool',
  attempt: 'u32',
  scene: 'bool',
  temporal: 'bool',
});

type ViewSubmissionFacts = {
  accepted: boolean;
  attempt: number;
  scene: boolean;
  temporal: boolean;
};

/**
 * The one accepted authority: the frame's `RenderSubmission` was accepted (queue
 * ok and every Feature scene input ready) and this view's attempt of this frame
 * was accepted. Every history commit reads this, never queue acceptance alone.
 */
export function viewAccepted(world: World, entity: EntityHandle | undefined): boolean {
  if (entity === undefined || !world.hasComponent(entity, ViewSubmission)) return false;
  const { accepted, frame } = renderSubmission(world);
  const submission = world.get(entity, ViewSubmission).unwrap();
  return accepted && submission.accepted && submission.attempt === frame;
}

/** Write a view's record-attempt outcome; a view entity that retired is skipped. */
export function recordViewSubmission(
  world: World,
  entity: EntityHandle | undefined,
  data: ViewSubmissionFacts,
): void {
  if (entity === undefined || !world.hasComponent(entity, RenderView)) return;
  if (world.hasComponent(entity, ViewSubmission)) world.set(entity, ViewSubmission, data).unwrap();
  else world.addComponent(entity, { component: ViewSubmission, data }).unwrap();
}

type ViewFacts = {
  capture: boolean;
  primary: boolean;
  camera: number;
  eye: number;
  viewport: Float32Array;
  order: number;
  resolutionScale: number;
  maxRenderShortSide: number;
  updateInterval: number;
  enabled: boolean;
  channels: number;
  viewGeneration: number;
  attachment: string;
  target: Handle<'RenderTarget', 'shared'>;
};

/** System names other Render World systems order against. */
export const RENDER_VIEWS_SYSTEM = 'render-views';
export const RENDER_VIEW_HISTORY_SYSTEM = 'render-view-history';
export const RENDER_VIEW_CAMERAS_SYSTEM = 'render-view-cameras';

const VIEW_EYES: readonly (StereoEye | undefined)[] = [undefined, 'left', 'right'];

/** A composed view recorder's cadence history (the `ViewRecorder` payload of a non-primary view). */
export interface ViewHistory {
  /** Whether this frame records a new picture (false: held). */
  readonly rendered: boolean;
  lastFrame: number;
  renderedFrames: number;
}

const NO_TARGET = toShared<'RenderTarget'>(0);

/** Explicit targets own their extent; display budgets combine using the stricter positive limit. */
export function displayShortSideLimit(
  authored: number,
  cap: number,
  target: RenderTarget | undefined,
): number {
  if (cap === 0 || target !== undefined) return authored;
  return authored === 0 ? cap : Math.min(cap, authored);
}

/** A capture view covers its whole target every frame. */
const CAPTURE_VIEW = Object.freeze({
  viewport: new Float32Array([0, 0, 1, 1]),
  order: 0,
  resolutionScale: 1,
  maxRenderShortSide: 0,
  updateInterval: 1,
  enabled: true,
});

interface DeclaredView {
  readonly entity: EntityHandle;
  /** Last sync that declared this view; older entries are despawned. */
  seen: number;
}

/** The frame's camera declarations; the frame entry writes it before `RenderExtract`. */
export interface RenderViewSource {
  readonly cameras: readonly CameraSnapshot[];
  /** Host-selected display budget; zero leaves implicit cameras on the primary path. */
  readonly maxRenderShortSide?: number | undefined;
  /** Auxiliary RenderTarget cameras (non-planar); each becomes one capture view. */
  readonly captures: readonly CameraSnapshot[];
  /** Whether the primary recorder records the display (no display CameraView is declared); otherwise the shared capture view. */
  readonly primary: boolean;
  /** Its display camera; undefined until the camera resolves (the frame then fails in extraction). */
  readonly primaryCamera: CameraSnapshot | undefined;
  /** The Renderer's drawing-buffer extent. */
  readonly canvas: { readonly width: number; readonly height: number };
  attachment(camera: CameraSnapshot): string | undefined;
  /** A resident RenderTarget's physical size; undefined while it is not resident. */
  targetExtent(
    target: RenderTarget,
  ): { readonly width: number; readonly height: number } | undefined;
}

/** World resource key of the frame's {@link RenderViewSource}. */
export const RenderViewInput = Object.freeze({ name: 'RenderViewSource' });

/**
 * The display camera of a primary view. An invalid camera leaves it
 * unresolved here: the recording's own extraction reports the structured failure.
 */
function primaryDisplayCamera(
  publication: PreparedRenderPublication | undefined,
  world: World | undefined,
  cameraEntityKey: number | undefined,
): CameraSnapshot | undefined {
  if (publication !== undefined) return publication.frame.cameras[0];
  if (world === undefined) return undefined;
  try {
    return selectCameraRoles(world, cameraEntityKey).display[0];
  } catch {
    return undefined;
  }
}

/** The identity of the source World a camera belongs to. */
export function cameraAttachmentId(
  camera: CameraSnapshot,
  world: World | undefined,
  worlds: readonly World[],
): string | undefined {
  return camera.worldId === undefined ? world?.identity : worlds[camera.worldId]?.identity;
}

/** A frame entry's retained {@link RenderViewSource}; it rewrites it before each frame. */
export class RenderViewFrameSource implements RenderViewSource {
  cameras: readonly CameraSnapshot[] = [];
  captures: readonly CameraSnapshot[] = [];
  primary = false;
  maxRenderShortSide = 0;
  primaryCamera: CameraSnapshot | undefined;
  /** The camera owner World; source Worlds name each attachment. */
  world: World | undefined;
  worlds: readonly World[] = [];
  /** The frame's draw options; each recording view stages its own camera over them. */
  opts: DrawOwnerOptions = { cameraOwner: 0, resourceOwner: 0 };
  leases: readonly RenderReadLease[] | undefined;
  publication: PreparedRenderPublication | undefined;
  /** Snapshots the publication for a view that cannot apply its delta; absent for a private frame. */
  receiver: RenderPublicationReceiver | undefined;

  constructor(
    private readonly host: {
      readonly canvas: { readonly width: number; readonly height: number };
      readonly getRenderTargetPhysical?:
        | ((
            target: RenderTarget,
          ) =>
            | { readonly descriptor: { readonly width: number; readonly height: number } }
            | undefined)
        | undefined;
    },
  ) {}

  get canvas(): { readonly width: number; readonly height: number } {
    return this.host.canvas;
  }

  /** Declare the frame's cameras; with no composed view, the primary records the display. */
  stage(
    cameras: readonly CameraSnapshot[],
    captures: readonly CameraSnapshot[],
    worlds: readonly World[],
    opts: DrawOwnerOptions,
    leases: readonly RenderReadLease[] | undefined,
    publication: PreparedRenderPublication | undefined,
    receiver?: RenderPublicationReceiver,
    maxRenderShortSide = 0,
  ): void {
    assertRenderShortSide(maxRenderShortSide);
    assertViewCameras(cameras, maxRenderShortSide > 0);
    this.maxRenderShortSide = maxRenderShortSide;
    const world = worlds[opts.cameraOwner];
    this.cameras = cameras;
    this.captures = captures;
    this.primary = maxRenderShortSide === 0 && !cameras.some((camera) => camera.view !== undefined);
    this.primaryCamera = this.primary
      ? primaryDisplayCamera(publication, world, opts.cameraEntityKey)
      : undefined;
    this.world = world;
    this.worlds = worlds;
    this.opts = opts;
    this.leases = leases;
    this.publication = publication;
    this.receiver = receiver;
  }

  clear(): void {
    this.cameras = this.captures = this.worlds = [];
    this.primary = false;
    this.primaryCamera = this.world = this.leases = this.publication = this.receiver = undefined;
  }

  attachment(camera: CameraSnapshot): string | undefined {
    return cameraAttachmentId(camera, this.world, this.worlds);
  }

  targetExtent(target: RenderTarget) {
    return this.host.getRenderTargetPhysical?.(target)?.descriptor;
  }
}

/** Throws the structured CameraView failure before any Render World write. */
export function assertViewCameras(
  cameras: readonly CameraSnapshot[],
  implicitDisplay = false,
): void {
  for (const camera of cameras) {
    if (
      (camera.view !== undefined || (implicitDisplay && camera.target === undefined)) &&
      camera.entityKey === undefined
    )
      throw new CameraViewInvalidError('entityKey', camera.entityKey, 'a camera entity identity');
    if (camera.view !== undefined) assertCameraViewData(camera.view);
  }
}

function setExtent(state: ViewCameraState, width: number, height: number, eye: number): void {
  const side = VIEW_EYES[eye];
  const current = state.extent;
  if (current.width === width && current.height === height && current.eye === side) return;
  state.extent = side === undefined ? { width, height } : { width, height, eye: side };
}

/** Resolve one view's extent, rectangle and final camera from the frame's source. */
export function resolveViewCamera(
  world: World,
  view: Readonly<
    Pick<
      ViewFacts,
      | 'primary'
      | 'capture'
      | 'camera'
      | 'eye'
      | 'target'
      | 'viewport'
      | 'resolutionScale'
      | 'maxRenderShortSide'
      | 'updateInterval'
      | 'enabled'
      | 'order'
    >
  >,
  state: ViewCameraState,
  source: RenderViewSource,
): void {
  const canvas = source.canvas;
  if (view.primary) {
    setExtent(state, canvas.width, canvas.height, ViewEyeValue.mono);
    state.viewport = cameraViewExtent(CAPTURE_VIEW, canvas.width, canvas.height);
    state.camera = view.capture
      ? source.cameras.find((camera) => camera.entityKey === view.camera)
      : source.primaryCamera;
    return;
  }
  const target = resolveCameraTarget(world, view.target);
  const physical = target === undefined ? undefined : source.targetExtent(target);
  if (view.capture) {
    if (physical !== undefined) {
      setExtent(state, physical.width, physical.height, ViewEyeValue.mono);
      state.viewport = cameraViewExtent(CAPTURE_VIEW, physical.width, physical.height);
    }
    state.camera = selectCaptureViewCamera(source.captures, view.camera);
    return;
  }
  state.viewport = cameraViewExtent(view, canvas.width, canvas.height);
  if (target === undefined)
    setExtent(state, state.viewport.renderWidth, state.viewport.renderHeight, view.eye);
  else if (physical !== undefined) setExtent(state, physical.width, physical.height, view.eye);
  state.camera = cameraForView(source.cameras, view.camera, state.extent);
}

function eyeChannels(camera: CameraSnapshot, eye: number): number {
  const stereo = camera.stereo;
  if (stereo === undefined || stereo.layout !== 'anaglyph') return ViewChannelsValue.all;
  return (eye === ViewEyeValue.left) !== stereo.swapEyes
    ? ViewChannelsValue.red
    : ViewChannelsValue.cyan;
}

function sameFacts(current: Readonly<ViewFacts>, next: ViewFacts): boolean {
  const a = current.viewport,
    b = next.viewport;
  return (
    a[0] === b[0] &&
    a[1] === b[1] &&
    a[2] === b[2] &&
    a[3] === b[3] &&
    current.order === next.order &&
    current.resolutionScale === next.resolutionScale &&
    current.maxRenderShortSide === next.maxRenderShortSide &&
    current.updateInterval === next.updateInterval &&
    current.enabled === next.enabled &&
    current.channels === next.channels &&
    current.viewGeneration === next.viewGeneration &&
    current.attachment === next.attachment
  );
}

/**
 * Source-driven view entities. The `render-views` RenderExtract system turns
 * the frame's camera snapshots ({@link RenderViewInput}) into one entity per CameraView or stereo eye
 * and one per auxiliary RenderTarget camera: a new declaration spawns, a
 * vanished one despawns, a changed one is rewritten, and a steady frame
 * writes nothing.
 */
export class RenderViews {
  /** Declared view entities: capture views first, then (order, camera, eye). */
  readonly ordered: EntityHandle[] = [];
  /** Enabled declared display (non-capture) views after the last sync. */
  enabledCount = 0;
  /** Declared display (non-capture) views after the last sync. */
  displayCount = 0;
  /** Declared capture views after the last sync. */
  captureCount = 0;
  /** Ingest identity translation: `camera * 3 + eye` (capture: `-1 - camera`) to its entity. */
  private readonly declared = new Map<number, DeclaredView>();
  /** The primary view entity; never part of `ordered`. */
  primary: EntityHandle | undefined;
  private syncs = 0;
  private orderDirty = false;
  private readonly facts: ViewFacts = {
    capture: false,
    primary: false,
    camera: 0,
    eye: 0,
    viewport: new Float32Array(4),
    order: 0,
    resolutionScale: 1,
    maxRenderShortSide: 0,
    updateInterval: 1,
    enabled: true,
    channels: 0,
    viewGeneration: 0,
    attachment: '',
    target: NO_TARGET,
  };

  constructor(readonly world: World) {
    world
      .addSystem(RenderExtract, {
        commands: 'none',
        name: RENDER_VIEWS_SYSTEM,
        queries: [],
        fn: (world) => {
          if (world.hasResource(RenderViewInput))
            this.apply(world.getResource<RenderViewSource>(RenderViewInput));
        },
      })
      .unwrap();
    world
      .addSystem(RenderExtract, {
        commands: 'none',
        name: RENDER_VIEW_CAMERAS_SYSTEM,
        after: [RENDER_VIEWS_SYSTEM],
        queries: [{ read: [RenderView, ViewCamera] }],
        // Each view's final camera (aspect, stereo eye) and recording extent
        // become World state before any RenderPrepare system reads them.
        fn: (world, [views]) => {
          if (!world.hasResource(RenderViewInput)) return;
          const source = world.getResource<RenderViewSource>(RenderViewInput);

          for (const span of views.spans().unwrap()) {
            const columns = span.get(RenderView);
            const states = span.get(ViewCamera).state;
            for (let index = 0; index < span.length; index++) {
              if (columns.enabled[index] === 0) continue;
              const view = this.facts;
              view.enabled = true;
              view.primary = columns.primary[index] !== 0;
              view.capture = columns.capture[index] !== 0;
              view.camera = columns.camera[index] as number;
              view.eye = columns.eye[index] as number;
              view.order = columns.order[index] as number;
              view.resolutionScale = columns.resolutionScale[index] as number;
              view.maxRenderShortSide = columns.maxRenderShortSide[index] as number;
              view.updateInterval = columns.updateInterval[index] as number;
              view.target = columns.target.get(index) as Handle<'RenderTarget', 'shared'>;
              const offset = index * 4;
              for (let axis = 0; axis < 4; axis++)
                view.viewport[axis] = columns.viewport[offset + axis] as number;
              const state = world
                .resolveUniqueRef<ViewCameraState>(
                  states.get(index) as Handle<'ViewCamera', 'unique'>,
                )
                .unwrap();
              resolveViewCamera(world, view, state, source);
            }
          }
        },
      })
      .unwrap();
    world
      .addSystem(RenderCommit, {
        commands: 'none',
        name: RENDER_VIEW_HISTORY_SYSTEM,
        queries: [{ read: [RenderView, ViewRecorder, ViewSubmission] }],
        // An accepted attempt of this frame that rendered a new picture advances
        // its view's cadence history; a held, rejected or stale view keeps it.
        fn: (world, [views]) => {
          const frame = renderSubmission(world).frame;

          views.forEach((row) => {
            const entity = row.entity;

            if (
              !requireViewField(world, entity, ViewSubmission, 'accepted') ||
              requireViewField(world, entity, ViewSubmission, 'attempt') !== frame ||
              requireViewField(world, entity, RenderView, 'primary')
            )
              return;
            const view = world
              .resolveUniqueRef<ViewHistory>(requireViewField(world, entity, ViewRecorder, 'state'))
              .unwrap();
            if (!view.rendered) return;
            view.lastFrame = frame;
            view.renderedFrames += 1;
          });
        },
      })
      .unwrap();
  }

  /** Any view declared by the last sync. */
  get size(): number {
    return this.declared.size;
  }

  /** Despawn every view; each recorder retires through its release. */
  clear(): void {
    this.despawnPrimary();
    for (const view of this.declared.values()) this.world.despawn(view.entity).unwrap();
    this.declared.clear();
    this.ordered.length = 0;
    this.enabledCount = 0;
    this.displayCount = 0;
    this.captureCount = 0;
  }

  /** The target a view records into; undefined for a display view. */
  target(view: { readonly target: number }): RenderTarget | undefined {
    return resolveCameraTarget(this.world, view.target);
  }

  private apply(source: RenderViewSource): void {
    assertRenderShortSide(source.maxRenderShortSide ?? 0);
    assertViewCameras(source.cameras, (source.maxRenderShortSide ?? 0) > 0);
    const frame = ++this.syncs;
    let declaredNow = 0;
    const cap = source.maxRenderShortSide ?? 0;
    for (const camera of source.cameras) {
      if (camera.view === undefined && (cap === 0 || camera.target !== undefined)) continue;
      const attachment = source.attachment(camera) ?? '';
      if (camera.stereo === undefined) {
        this.write(camera, ViewEyeValue.mono, attachment, frame, false, cap);
        declaredNow += 1;
      } else {
        this.write(camera, ViewEyeValue.left, attachment, frame, false, cap);
        this.write(camera, ViewEyeValue.right, attachment, frame, false, cap);
        declaredNow += 2;
      }
    }
    for (const camera of source.captures) {
      if (camera.entityKey === undefined || camera.target === undefined) continue;
      this.write(camera, ViewEyeValue.mono, source.attachment(camera) ?? '', frame, true);
      declaredNow += 1;
    }
    if (declaredNow !== this.declared.size) {
      for (const [key, view] of this.declared) {
        if (view.seen === frame) continue;
        this.world.despawn(view.entity).unwrap();
        this.declared.delete(key);
        this.orderDirty = true;
      }
    }
    if (this.orderDirty) this.reorder();
    this.reconcilePrimary(source);
  }

  private reconcilePrimary(source: RenderViewSource): void {
    if (source.primary) {
      const camera = source.primaryCamera;
      this.writePrimary(
        false,
        camera?.entityKey ?? 0,
        camera?.historyVersion ?? 0,
        camera === undefined ? '' : (source.attachment(camera) ?? ''),
      );
      return;
    }
    const shared = this.sharedCaptureCamera();
    if (shared === undefined) this.despawnPrimary();
    else this.writePrimary(true, shared.camera, shared.viewGeneration, '');
  }

  /** The first enabled composed view in composition order, else the first composed view. */
  private sharedCaptureCamera(): { camera: number; viewGeneration: number } | undefined {
    let first: { camera: number; viewGeneration: number } | undefined;
    for (const entity of this.ordered) {
      const view = this.world.get(entity, RenderView).unwrap();
      if (view.capture) continue;
      if (view.enabled) return view;
      first ??= view;
    }
    return first;
  }

  /**
   * The primary view covers its whole canvas every frame; a camera or role
   * switch rewrites it in place, so its per-view state survives the switch.
   */
  private writePrimary(
    capture: boolean,
    camera: number,
    viewGeneration: number,
    attachment: string,
  ): void {
    const world = this.world;
    const facts = this.facts;
    facts.capture = capture;
    facts.primary = true;
    facts.camera = camera;
    facts.eye = ViewEyeValue.mono;
    facts.viewport.set(CAPTURE_VIEW.viewport);
    facts.order = 0;
    facts.resolutionScale = 1;
    facts.maxRenderShortSide = 0;
    facts.updateInterval = 1;
    facts.enabled = true;
    facts.channels = ViewChannelsValue.all;
    facts.viewGeneration = viewGeneration;
    facts.attachment = attachment;
    facts.target = NO_TARGET;
    if (this.primary === undefined) {
      this.primary = world.spawn(...this.spawnData(facts)).unwrap();
      return;
    }
    const current = world.get(this.primary, RenderView).unwrap();
    if (
      current.camera !== facts.camera ||
      current.capture !== capture ||
      !sameFacts(current, facts)
    )
      world.set(this.primary, RenderView, facts).unwrap();
  }

  private despawnPrimary(): void {
    if (this.primary === undefined) return;
    this.world.despawn(this.primary).unwrap();
    this.primary = undefined;
  }

  private write(
    camera: CameraSnapshot,
    eye: number,
    attachment: string,
    frame: number,
    capture: boolean,
    cap = 0,
  ): void {
    const world = this.world;
    const facts = this.facts;
    facts.capture = capture;
    facts.primary = false;
    facts.camera = camera.entityKey as number;
    facts.eye = eye;
    const authored = capture ? CAPTURE_VIEW : (camera.view ?? CAMERA_VIEW_DEFAULTS);
    if (camera.stereo === undefined || capture) facts.viewport.set(authored.viewport);
    else
      stereoEyeViewport(
        authored.viewport,
        camera.stereo,
        eye === ViewEyeValue.left ? 'left' : 'right',
        facts.viewport,
      );
    facts.order = authored.order;
    facts.resolutionScale = authored.resolutionScale;
    facts.maxRenderShortSide = displayShortSideLimit(
      authored.maxRenderShortSide,
      cap,
      camera.target,
    );
    facts.updateInterval = authored.updateInterval;
    facts.enabled = authored.enabled;
    facts.channels = capture ? ViewChannelsValue.all : eyeChannels(camera, eye);
    facts.viewGeneration = camera.historyVersion ?? 0;
    facts.attachment = attachment;
    const key = capture ? -1 - facts.camera : facts.camera * 3 + eye;
    const declared = this.declared.get(key);
    if (declared === undefined) {
      facts.target = this.acquireTarget(camera.target);
      const entity = world.spawn(...this.spawnData(facts)).unwrap();
      this.releaseTarget(facts.target);
      this.declared.set(key, { entity, seen: frame });
      this.orderDirty = true;
      return;
    }
    declared.seen = frame;
    const current = world.get(declared.entity, RenderView).unwrap();
    const sameTarget = this.target(current) === camera.target;
    // A disabled view keeps its entity but not its recording state; a new
    // target needs a new recorder. Both seed again from the current scene.
    if ((!sameTarget || !facts.enabled) && world.hasComponent(declared.entity, ViewRecorder))
      world.removeComponent(declared.entity, ViewRecorder).unwrap();
    if (sameTarget && sameFacts(current, facts)) return;
    if (current.order !== facts.order || current.enabled !== facts.enabled) this.orderDirty = true;
    // Hold a grant across the write even for the same target: `set` releases
    // the column's reference before retaining the new value, and the column
    // may be the only holder.
    facts.target = this.acquireTarget(camera.target);
    world.set(declared.entity, RenderView, facts).unwrap();
    this.releaseTarget(facts.target);
  }

  /** A new view entity's components: its declaration and its (unresolved) camera. */
  private spawnData(facts: ViewFacts) {
    const state: ViewCameraState = {
      extent: { width: 1, height: 1 },
      viewport: { x: 0, y: 0, width: 1, height: 1, renderWidth: 1, renderHeight: 1 },
      camera: undefined,
    };
    return [
      { component: RenderView, data: facts },
      { component: ViewCamera, data: { state: this.world.allocUniqueRef('ViewCamera', state) } },
    ] as const;
  }

  /** One caller grant held across the write; the column retains its own reference. */
  private acquireTarget(target: RenderTarget | undefined): Handle<'RenderTarget', 'shared'> {
    return target === undefined ? NO_TARGET : this.world.sharedRefs.acquire('RenderTarget', target);
  }

  private releaseTarget(handle: Handle<'RenderTarget', 'shared'>): void {
    if (handle !== NO_TARGET) this.world.sharedRefs.release(handle).unwrap();
  }

  private reorder(): void {
    const world = this.world;
    const ordered = this.ordered;
    ordered.length = 0;
    let enabled = 0;
    let captures = 0;
    for (const view of this.declared.values()) {
      ordered.push(view.entity);
      const facts = world.get(view.entity, RenderView).unwrap();
      if (facts.capture) captures += 1;
      else if (facts.enabled) enabled += 1;
    }
    // Capture views record first: displays sample the targets they write.
    ordered.sort((left, right) => {
      const a = world.get(left, RenderView).unwrap();
      const b = world.get(right, RenderView).unwrap();
      return (
        Number(b.capture) - Number(a.capture) ||
        a.order - b.order ||
        a.camera - b.camera ||
        a.eye - b.eye
      );
    });
    this.enabledCount = enabled;
    this.captureCount = captures;
    this.displayCount = ordered.length - captures;
    this.orderDirty = false;
  }
}
