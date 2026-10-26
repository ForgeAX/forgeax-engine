import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { type Handle, toShared } from '@forgeax/engine-types';
import { stereoEyeViewport } from '../components/stereo-camera';
import { CameraViewInvalidError } from '../errors/render';
import type { CameraSnapshot } from '../render-contract';
import { resolveCameraTarget } from '../render-system-extract';
import type { RenderTarget } from '../targets/contracts';
import { RenderPrepare } from './render-world';

/** Eye column of a composed view: a mono CameraView or one stereo eye of it. */
export const ViewEyeValue = Object.freeze({ mono: 0, left: 1, right: 2 } as const);
/** Composite channel column: every channel, or one anaglyph eye's channels. */
export const ViewChannelsValue = Object.freeze({ all: 0, red: 1, cyan: 2 } as const);

/**
 * A view in the Render World: one CameraView, or one stereo eye of it, with
 * its authored (eye-derived) rectangle, cadence and target; or a capture view
 * (`capture`), an auxiliary Camera that writes its RenderTarget as a raw
 * linear scene capture and is never composited.
 */
export const RenderView = defineComponent('RenderView', {
  capture: 'bool',
  camera: 'u32',
  eye: { type: 'enum', default: ViewEyeValue.mono, labels: ViewEyeValue },
  viewport: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 1, 1]) },
  order: 'i32',
  resolutionScale: { type: 'f32', default: 1 },
  updateInterval: { type: 'u32', default: 1 },
  enabled: { type: 'bool', default: true },
  channels: { type: 'enum', default: ViewChannelsValue.all, labels: ViewChannelsValue },
  viewGeneration: 'u32',
  attachment: 'string',
  target: 'shared<RenderTarget>',
});

/**
 * The view's private recording state (its RenderSystem, device scope, output
 * and history). Present only while the view is enabled; removal or despawn
 * releases it through the payload's own retirement.
 */
export const ViewRecorder = defineComponent('ViewRecorder', { state: 'unique<ViewRecorder>' });

type ViewFacts = {
  capture: boolean;
  camera: number;
  eye: number;
  viewport: Float32Array;
  order: number;
  resolutionScale: number;
  updateInterval: number;
  enabled: boolean;
  channels: number;
  viewGeneration: number;
  attachment: string;
  target: Handle<'RenderTarget', 'shared'>;
};

const NO_TARGET = toShared<'RenderTarget'>(0);

/** A capture view covers its whole target every frame. */
const CAPTURE_VIEW = Object.freeze({
  viewport: new Float32Array([0, 0, 1, 1]),
  order: 0,
  resolutionScale: 1,
  updateInterval: 1,
  enabled: true,
});

interface DeclaredView {
  readonly entity: EntityHandle;
  /** Last sync that declared this view; older entries are despawned. */
  seen: number;
}

export interface RenderViewSource {
  readonly cameras: readonly CameraSnapshot[];
  /** Auxiliary RenderTarget cameras (non-planar); each becomes one capture view. */
  readonly captures: readonly CameraSnapshot[];
  attachment(camera: CameraSnapshot): string | undefined;
}

/** Throws the structured CameraView failure before any Render World write. */
export function assertViewCameras(cameras: readonly CameraSnapshot[]): void {
  for (const camera of cameras)
    if (camera.view !== undefined && camera.entityKey === undefined)
      throw new CameraViewInvalidError('entityKey', camera.entityKey, 'a camera entity identity');
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
    current.updateInterval === next.updateInterval &&
    current.enabled === next.enabled &&
    current.channels === next.channels &&
    current.viewGeneration === next.viewGeneration &&
    current.attachment === next.attachment
  );
}

/**
 * Source-driven view entities. The `render-views` RenderPrepare system turns
 * the frame's camera snapshots into one entity per CameraView or stereo eye
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
  private pending: RenderViewSource | undefined;
  private syncs = 0;
  private orderDirty = false;
  private readonly facts: ViewFacts = {
    capture: false,
    camera: 0,
    eye: 0,
    viewport: new Float32Array(4),
    order: 0,
    resolutionScale: 1,
    updateInterval: 1,
    enabled: true,
    channels: 0,
    viewGeneration: 0,
    attachment: '',
    target: NO_TARGET,
  };

  constructor(readonly world: World) {
    world
      .addSystem(RenderPrepare, {
        name: 'render-views',
        queries: [],
        fn: () => this.apply(),
      })
      .unwrap();
  }

  /** Any view declared by the last sync. */
  get size(): number {
    return this.declared.size;
  }

  /** Reconcile the view entities with this frame's cameras inside `RenderPrepare`. */
  sync(source: RenderViewSource): void {
    assertViewCameras(source.cameras);
    this.pending = source;
    const ran = this.world.run(RenderPrepare);
    this.pending = undefined;
    if (!ran.ok) throw ran.error;
  }

  /** Despawn every view; each recorder retires through its release. */
  clear(): void {
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

  private apply(): void {
    const source = this.pending;
    if (source === undefined) return;
    this.pending = undefined;
    const frame = ++this.syncs;
    let declaredNow = 0;
    for (const camera of source.cameras) {
      if (camera.view === undefined) continue;
      const attachment = source.attachment(camera) ?? '';
      if (camera.stereo === undefined) {
        this.write(camera, ViewEyeValue.mono, attachment, frame, false);
        declaredNow += 1;
      } else {
        this.write(camera, ViewEyeValue.left, attachment, frame, false);
        this.write(camera, ViewEyeValue.right, attachment, frame, false);
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
  }

  private write(
    camera: CameraSnapshot,
    eye: number,
    attachment: string,
    frame: number,
    capture: boolean,
  ): void {
    const world = this.world;
    const facts = this.facts;
    facts.capture = capture;
    facts.camera = camera.entityKey as number;
    facts.eye = eye;
    const authored = capture ? CAPTURE_VIEW : (camera.view as NonNullable<CameraSnapshot['view']>);
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
    facts.updateInterval = authored.updateInterval;
    facts.enabled = authored.enabled;
    facts.channels = capture ? ViewChannelsValue.all : eyeChannels(camera, eye);
    facts.viewGeneration = camera.historyVersion ?? 0;
    facts.attachment = attachment;
    const key = capture ? -1 - facts.camera : facts.camera * 3 + eye;
    const declared = this.declared.get(key);
    if (declared === undefined) {
      facts.target = this.acquireTarget(camera.target);
      const entity = world.spawn({ component: RenderView, data: facts }).unwrap();
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
    facts.target = sameTarget ? current.target : this.acquireTarget(camera.target);
    world.set(declared.entity, RenderView, facts).unwrap();
    if (!sameTarget) this.releaseTarget(facts.target);
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
