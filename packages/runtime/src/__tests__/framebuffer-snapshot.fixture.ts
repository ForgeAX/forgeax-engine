import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  CameraView,
  createRenderPublisher,
  type FramebufferSnapshotRegion,
  type FrameDomainObservation,
  type FrameReceipt,
  Materials,
  MeshFilter,
  MeshRenderer,
  orthographic,
  type Renderer,
  RenderPublicationTargetOwner,
  type RenderTarget,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  openReplay,
  type RecorderAttachment,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { renderValue } from './standard-gbuffer-replay.fixture';

/** Square canvas; the orthographic display camera maps one world unit to 16 pixels. */
export const SNAPSHOT_CANVAS = 128;
const SNAPSHOT = 32;
const RED = [1, 0.02, 0.01, 1] as const;
const BLUE = [0.01, 0.03, 1, 1] as const;
/** The red source box covers exactly this scene-color region at frame N. */
export const SOURCE_REGION: FramebufferSnapshotRegion = { x: 16, y: 16, width: 32, height: 32 };
/** Background-only region used by the wrong-region falsifier. */
const WRONG_REGION: FramebufferSnapshotRegion = { x: 48, y: 48, width: 32, height: 32 };
/** Screen squares of the sampling quads: correct copy, wrong region, never copied. */
const QUADS = {
  correct: { x: 80, y: 16 },
  wrong: { x: 16, y: 80 },
  missing: { x: 80, y: 80 },
} as const;
/** Max per-channel final-sRGB mean distance a retained quad may show, in [0, 1]. */
export const SNAPSHOT_EPSILON = 0.05;
export const RETAINED_FRAMES = 60;

/** `size` is present for square RGBA8 images a caller may encode as PNG. */
export type SnapshotSave = (name: string, bytes: Uint8Array, size?: number) => void | Promise<void>;
type Rgb = readonly [number, number, number];

function required<T>(value: T | undefined | null, message = 'framebuffer snapshot evidence'): T {
  if (value === undefined || value === null) throw new Error(message);
  return value;
}

export function snapshotTargetDescriptor(size = SNAPSHOT) {
  return {
    shape: '2d',
    width: size,
    height: size,
    format: 'rgba16float',
    mipLevels: 1,
    sampleCount: 1,
    sampled: true,
    readback: true,
  } as const;
}

const cameraData = (half: { readonly x: number; readonly y: number }) => ({
  ...orthographic({
    left: -half.x,
    right: half.x,
    bottom: -half.y,
    top: half.y,
    near: 0.1,
    far: 30,
  }),
  tonemap: 1,
  clearColor: [0.02, 0.025, 0.04, 1],
});

/** Tightly packed RGBA8 of a final-sRGB observation, in RGBA channel order. */
function packedRgba(observation: FrameDomainObservation): Uint8Array {
  const { width, height, bytesPerRow, format } = observation.metadata;
  const out = new Uint8Array(width * height * 4);
  const bgra = format.startsWith('bgra');
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from = y * bytesPerRow + x * 4;
      const to = (y * width + x) * 4;
      out[to] = observation.bytes[from + (bgra ? 2 : 0)] ?? 0;
      out[to + 1] = observation.bytes[from + 1] ?? 0;
      out[to + 2] = observation.bytes[from + (bgra ? 0 : 2)] ?? 0;
      out[to + 3] = observation.bytes[from + 3] ?? 0;
    }
  return out;
}

/** Mean RGB over the inner 16 px of a 32 px square whose top-left is `origin`. */
function meanInner(rgba: Uint8Array, width: number, origin: { x: number; y: number }): Rgb {
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = origin.y + 8; y < origin.y + 24; y++)
    for (let x = origin.x + 8; x < origin.x + 24; x++) {
      const at = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (rgba[at + c] ?? 0);
      count++;
    }
  return [(sum[0] ?? 0) / count / 255, (sum[1] ?? 0) / count / 255, (sum[2] ?? 0) / count / 255];
}

function distance(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/** Rows of `region` inside a linear-HDR observation, packed at 8 bytes per texel. */
function hdrRegion(observation: FrameDomainObservation, region: FramebufferSnapshotRegion) {
  expect(observation.metadata.format).toBe('rgba16float');
  const out = new Uint8Array(region.width * region.height * 8);
  for (let y = 0; y < region.height; y++) {
    const from = (region.y + y) * observation.metadata.bytesPerRow + region.x * 8;
    out.set(observation.bytes.subarray(from, from + region.width * 8), y * region.width * 8);
  }
  return out;
}

function tightRows(bytes: Uint8Array, width: number, height: number, bytesPerRow: number) {
  const row = width * 8;
  const out = new Uint8Array(row * height);
  for (let y = 0; y < height; y++)
    out.set(bytes.subarray(y * bytesPerRow, y * bytesPerRow + row), y * row);
  return out;
}

function mismatches(a: Uint8Array, b: Uint8Array): number {
  let count = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) count++;
  return count;
}

function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
  if (exponent === 31) return mantissa === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

/** Mean linear RGB of tightly packed rgba16float texels. */
function meanHalf(bytes: Uint8Array): Rgb {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sum = [0, 0, 0];
  const texels = bytes.byteLength / 8;
  for (let i = 0; i < texels; i++)
    for (let c = 0; c < 3; c++)
      sum[c] = (sum[c] ?? 0) + halfToFloat(view.getUint16(i * 8 + c * 2, true));
  return [(sum[0] ?? 0) / texels, (sum[1] ?? 0) / texels, (sum[2] ?? 0) / texels];
}

/** Display-referred RGBA8 preview of rgba16float texels, for evidence images only. */
function halfPreview(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint8Array((bytes.byteLength / 8) * 4);
  for (let i = 0; i < out.length / 4; i++) {
    for (let c = 0; c < 3; c++) {
      const linear = Math.min(1, Math.max(0, halfToFloat(view.getUint16(i * 8 + c * 2, true))));
      out[i * 4 + c] = Math.round(linear ** (1 / 2.2) * 255);
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

interface SnapshotScene {
  readonly world: World;
  readonly source: EntityHandle;
  readonly camera: EntityHandle;
  /** CPU time of the last `renderer.draw` call and its submit-to-completion latency. */
  readonly timing: { cpuMs: number; completionMs: number };
  readonly draw: () => Promise<FrameReceipt>;
  readonly dispose: () => void;
}

function buildSnapshotScene(
  renderer: Renderer,
  quadTextures: readonly unknown[],
  publication?: {
    readonly assets: AssetRegistry;
    readonly identity: { readonly source: string; readonly epoch: number };
  },
): SnapshotScene {
  const world = new World();
  const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(2, 2, 2).unwrap());
  const box = (x: number, y: number, material: unknown) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x, y, -5] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material as never] } },
      )
      .unwrap();
  const source = box(-2, 2, world.allocSharedRef('MaterialAsset', Materials.unlit([...RED])));
  const quadPositions = [
    [2, 2],
    [-2, -2],
    [2, -2],
  ] as const;
  for (const [index, texture] of quadTextures.entries()) {
    const [x, y] = required(quadPositions[index]);
    const sourceRef = world.allocSharedRef('RenderTargetTextureSource', texture as never);
    box(
      x,
      y,
      world.allocSharedRef(
        'MaterialAsset',
        Materials.unlit([1, 1, 1, 1], { baseColorTexture: sourceRef as never }),
      ),
    );
  }
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: Camera, data: cameraData({ x: 4, y: 4 }) },
    )
    .unwrap();
  const targetOwner = publication === undefined ? undefined : new RenderPublicationTargetOwner();
  const publisher =
    publication === undefined
      ? undefined
      : createRenderPublisher(
          world,
          publication.assets,
          publication.identity,
          renderer.inspect().capabilities,
          [],
          targetOwner,
        );
  const lease = publisher === undefined ? renderValue(renderer.attach(world)) : undefined;
  const timing = { cpuMs: 0, completionMs: 0 };
  let time = 0;
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    time += 1 / 60;
    const candidate = publisher?.prepare(time).unwrap();
    const packet =
      candidate === undefined
        ? undefined
        : structuredClone(candidate.packet, {
            transfer: renderPublicationTransfers(candidate.packet),
          });
    candidate?.accept();
    try {
      const start = performance.now();
      const result = renderer.draw(
        packet === undefined
          ? {
              leases: [required(lease)],
              camera: { lease: required(lease) },
              environment: { lease: required(lease) },
            }
          : { publication: packet },
      );
      timing.cpuMs = performance.now() - start;
      if (!result.ok) throw result.error;
      renderValue(await result.value.completed);
      timing.completionMs = performance.now() - start;
      return result.value;
    } finally {
      if (packet !== undefined)
        required(publisher).recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    }
  };
  return {
    world,
    source,
    camera,
    timing,
    draw,
    dispose: () => {
      lease?.dispose();
      publisher?.dispose();
      targetOwner?.dispose();
    },
  };
}

function recolorSource(scene: SnapshotScene, color: readonly number[]) {
  const material = scene.world.allocSharedRef(
    'MaterialAsset',
    Materials.unlit([...color] as [number, number, number, number]),
  );
  scene.world.set(scene.source, MeshRenderer, { materials: [material] }).unwrap();
}

async function readTarget(
  renderer: Renderer,
  scene: SnapshotScene,
  target: RenderTarget,
  size = SNAPSHOT,
) {
  const ticket = renderValue(renderer.requestTargetReadback(target, { mipLevel: 0 }));
  const data = required(
    renderValue(
      await renderer.observe(await scene.draw(), {
        include: ['target-readbacks'],
        targetReadbacks: [ticket],
      }),
    ).targetReadbacks?.[0],
  );
  return tightRows(data.bytes, size, size, data.bytesPerRow);
}

async function freshReplay(bytes: Uint8Array) {
  const tape = decodeTape(bytes).unwrap();
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
  ).unwrap();
  return (
    await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
}

export interface FramebufferSnapshotEvidence {
  readonly frameN: number;
  readonly sourceColor: Rgb;
  readonly changedSourceColor: Rgb;
  readonly quadColors: { readonly correct: Rgb; readonly wrong: Rgb; readonly missing: Rgb };
  readonly retainedFrames: number;
  readonly epsilon: number;
  readonly worstRetainedDistance: number;
  readonly falsifierDistances: { readonly wrongRegion: number; readonly noCopy: number };
  readonly liveTargetMismatchBytes: number;
  readonly replayTargetMismatchBytes: number;
  readonly replayFinalMaxDelta: number;
  readonly copy: {
    readonly eventIndex: number;
    readonly source: unknown;
    readonly destination: unknown;
    readonly copySize: unknown;
    readonly submitCount: number;
    readonly readAtWork: number;
  };
  readonly cameraView: { readonly camera: number; readonly linearMean: Rgb };
}

/**
 * Render a scene, snapshot its source region at frame N, change the scene, and
 * prove over 60 frames that a quad sampling the snapshot still shows frame N.
 * Wrong-region and no-copy quads are live falsifiers of the same predicate.
 */
export async function verifyFramebufferSnapshot(input: {
  readonly renderer: Renderer;
  readonly recorder: RecorderAttachment;
  readonly save: SnapshotSave;
}): Promise<FramebufferSnapshotEvidence> {
  const { renderer, recorder, save } = input;
  const requestObservation = required(renderer.requestObservation).bind(renderer);
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const targets = {
    correct: renderValue(renderer.createRenderTarget(snapshotTargetDescriptor())),
    wrong: renderValue(renderer.createRenderTarget(snapshotTargetDescriptor())),
    missing: renderValue(renderer.createRenderTarget(snapshotTargetDescriptor())),
  };
  const textureSource = (target: RenderTarget) =>
    renderValue(
      renderer.createRenderTargetTextureSource(target, {
        aspect: 'color',
        dimension: '2d',
        mipLevel: 0,
      }),
    );
  const scene = buildSnapshotScene(renderer, [
    textureSource(targets.correct),
    textureSource(targets.wrong),
    textureSource(targets.missing),
  ]);
  try {
    for (let frame = 0; frame < testQuality.staticFrames; frame++) await scene.draw();
    expect(errors).toEqual([]);

    const tickets = [
      renderValue(renderer.requestFramebufferSnapshot(targets.correct, { region: SOURCE_REGION })),
      renderValue(renderer.requestFramebufferSnapshot(targets.wrong, { region: WRONG_REGION })),
    ];
    renderValue(requestObservation(['linear-hdr', 'final-display']));
    const capturing = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const receiptN = await scene.draw();
    (await recorder.frameBoundary()).unwrap();
    const captured = (await capturing).unwrap();
    const observedN = renderValue(
      await renderer.observe(receiptN, {
        include: ['linear-hdr', 'final-display'],
        framebufferSnapshots: tickets,
      }),
    );
    const snapshots = required(observedN.framebufferSnapshots);
    expect(snapshots.map((row) => row.frameId)).toEqual([receiptN.frameId, receiptN.frameId]);
    expect(snapshots[0]?.region).toEqual(SOURCE_REGION);
    const hdrN = required(observedN.observations?.find((row) => row.domain === 'linear-hdr'));
    const finalN = packedRgba(
      required(observedN.observations?.find((row) => row.domain === 'final-display')),
    );
    expect(snapshots[0]?.sourceExtent).toEqual({
      width: hdrN.metadata.width,
      height: hdrN.metadata.height,
    });
    const expectedTarget = hdrRegion(hdrN, SOURCE_REGION);
    const sourceColor = meanInner(finalN, SNAPSHOT_CANVAS, SOURCE_REGION);
    expect(sourceColor[0]).toBeGreaterThan(0.5);
    expect(sourceColor[2]).toBeLessThan(0.2);
    await save('source-frame.rgba', finalN, SNAPSHOT_CANVAS);
    await save('snapshot-frame.rhitape', captured.bytes);

    recolorSource(scene, BLUE);
    const liveBytes = await readTarget(renderer, scene, targets.correct);
    const liveTargetMismatchBytes = mismatches(liveBytes, expectedTarget);
    expect(liveTargetMismatchBytes).toBe(0);
    await save('snapshot.rgba', halfPreview(liveBytes), SNAPSHOT);

    let worstRetainedDistance = 0;
    let wrongRegion = Number.POSITIVE_INFINITY;
    let noCopy = Number.POSITIVE_INFINITY;
    let later: Uint8Array | undefined;
    let quadColors: FramebufferSnapshotEvidence['quadColors'] | undefined;
    let changedSourceColor: Rgb = [0, 0, 0];
    for (let frame = 0; frame < RETAINED_FRAMES; frame++) {
      renderValue(requestObservation(['final-display']));
      const receipt = await scene.draw();
      const pixels = packedRgba(
        required(
          renderValue(await renderer.observe(receipt, { include: ['final-display'] }))
            .observations?.[0],
        ),
      );
      changedSourceColor = meanInner(pixels, SNAPSHOT_CANVAS, SOURCE_REGION);
      expect(changedSourceColor[2]).toBeGreaterThan(0.5);
      expect(changedSourceColor[0]).toBeLessThan(0.2);
      const colors = {
        correct: meanInner(pixels, SNAPSHOT_CANVAS, QUADS.correct),
        wrong: meanInner(pixels, SNAPSHOT_CANVAS, QUADS.wrong),
        missing: meanInner(pixels, SNAPSHOT_CANVAS, QUADS.missing),
      };
      worstRetainedDistance = Math.max(
        worstRetainedDistance,
        distance(colors.correct, sourceColor),
      );
      wrongRegion = Math.min(wrongRegion, distance(colors.wrong, sourceColor));
      noCopy = Math.min(noCopy, distance(colors.missing, sourceColor));
      later = pixels;
      quadColors = colors;
    }
    expect(worstRetainedDistance).toBeLessThanOrEqual(SNAPSHOT_EPSILON);
    // FALSIFIER: the same predicate rejects a snapshot of the wrong region and a target never copied.
    expect(wrongRegion).toBeGreaterThan(SNAPSHOT_EPSILON);
    expect(noCopy).toBeGreaterThan(SNAPSHOT_EPSILON);
    await save('later-frame.rgba', required(later), SNAPSHOT_CANVAS);
    expect(errors).toEqual([]);

    const tape = decodeTape(captured.bytes).unwrap();
    const model = buildFrameModel(tape);
    const copyIndex = tape.events.findIndex(
      (event) =>
        event.kind === 'copyTextureToTexture' &&
        JSON.stringify(event.source.origin).includes(`${SOURCE_REGION.x}`) &&
        JSON.stringify(event.copySize).includes(`${SOURCE_REGION.width}`),
    );
    const copy = tape.events[copyIndex];
    if (copy?.kind !== 'copyTextureToTexture') throw new Error('snapshot copy was not recorded');
    const submitCount = tape.events.filter((event) => event.kind === 'submit').length;
    expect(submitCount).toBe(1);
    const workAfterCopy = required(
      model.works.find((work) => work.eventIndex > copyIndex),
      'a work item after the snapshot copy',
    );
    const lastWork = required(model.works.at(-1));
    const replay = await freshReplay(captured.bytes);
    let replayTargetMismatchBytes: number;
    let replayFinalMaxDelta = 0;
    try {
      const replayed = (
        await replay.readResourceAtWork(copy.destination.textureHandleId, workAfterCopy.workIndex)
      ).unwrap();
      const replayBytes = tightRows(
        replayed.bytes,
        SNAPSHOT,
        SNAPSHOT,
        replayed.bytes.length / SNAPSHOT,
      );
      replayTargetMismatchBytes = mismatches(replayBytes, expectedTarget);
      expect(replayTargetMismatchBytes).toBe(0);
      const final = required(
        (await replay.inspectWork(lastWork.workIndex, ['pixels'])).unwrap().attachment,
      );
      const bgra = required(final.format).startsWith('bgra');
      const replayRgba = new Uint8Array(final.bytes.length);
      for (let i = 0; i < final.bytes.length; i += 4) {
        replayRgba[i] = final.bytes[i + (bgra ? 2 : 0)] ?? 0;
        replayRgba[i + 1] = final.bytes[i + 1] ?? 0;
        replayRgba[i + 2] = final.bytes[i + (bgra ? 0 : 2)] ?? 0;
        replayRgba[i + 3] = final.bytes[i + 3] ?? 0;
      }
      expect(replayRgba.length).toBe(finalN.length);
      for (let i = 0; i < replayRgba.length; i++)
        replayFinalMaxDelta = Math.max(
          replayFinalMaxDelta,
          Math.abs((replayRgba[i] ?? 0) - (finalN[i] ?? 0)),
        );
      expect(replayFinalMaxDelta).toBeLessThanOrEqual(1);
      await save('replay-frame.rgba', replayRgba, SNAPSHOT_CANVAS);
    } finally {
      (await replay.dispose()).unwrap();
    }

    const cameraView = await verifyCameraViewSnapshot(renderer, scene, targets.correct);
    expect(errors).toEqual([]);
    return {
      frameN: receiptN.frameId,
      sourceColor,
      changedSourceColor,
      quadColors: required(quadColors),
      retainedFrames: RETAINED_FRAMES,
      epsilon: SNAPSHOT_EPSILON,
      worstRetainedDistance,
      falsifierDistances: { wrongRegion, noCopy },
      liveTargetMismatchBytes,
      replayTargetMismatchBytes,
      replayFinalMaxDelta,
      copy: {
        eventIndex: copyIndex,
        source: copy.source,
        destination: copy.destination,
        copySize: copy.copySize,
        submitCount,
        readAtWork: workAfterCopy.workIndex,
      },
      cameraView,
    };
  } finally {
    off();
    scene.dispose();
    for (const target of Object.values(targets)) renderer.destroyRenderTarget(target);
  }
}

/** Split the display into two CameraViews and snapshot only the right view's scene color. */
async function verifyCameraViewSnapshot(
  renderer: Renderer,
  scene: SnapshotScene,
  target: RenderTarget,
): Promise<{ camera: number; linearMean: Rgb }> {
  const { world, camera } = scene;
  world
    .addComponent(camera, { component: CameraView, data: { viewport: [0, 0, 0.5, 1] } })
    .unwrap();
  // The right view frames only the (now blue) source box.
  const right = world
    .spawn(
      { component: Transform, data: { pos: [-2, 0, 0] } },
      { component: Camera, data: cameraData({ x: 2, y: 4 }) },
      { component: CameraView, data: { viewport: [0.5, 0, 0.5, 1], order: 1 } },
    )
    .unwrap();
  try {
    for (let frame = 0; frame < 3; frame++) await scene.draw();
    const view = required(
      renderer.inspect().views?.find((row) => row.entityKey === Number(right)),
      'right CameraView inspection',
    );
    const region = { x: 16, y: 16, width: 32, height: 32 };
    const display = renderValue(renderer.requestFramebufferSnapshot(target, { region }));
    const displayResult = await renderer.observe(await scene.draw(), {
      include: [],
      framebufferSnapshots: [display],
    });
    // A composite frame has no display-role scene color; the request must name a view.
    if (displayResult.ok || displayResult.error.code !== 'framebuffer-snapshot-failed')
      throw new Error('expected source-unavailable for an unnamed composite snapshot');
    expect(displayResult.error.detail.reason).toBe('source-unavailable');
    const ticket = renderValue(
      renderer.requestFramebufferSnapshot(target, { region, camera: Number(right) }),
    );
    const observed = renderValue(
      await renderer.observe(await scene.draw(), { include: [], framebufferSnapshots: [ticket] }),
    );
    expect(observed.framebufferSnapshots?.[0]).toMatchObject({
      camera: Number(right),
      sourceExtent: { width: view.width, height: view.height },
    });
    const linearMean = meanHalf(await readTarget(renderer, scene, target));
    expect(linearMean[2]).toBeGreaterThan(0.5);
    expect(linearMean[0]).toBeLessThan(0.2);
    return { camera: Number(right), linearMean };
  } finally {
    world.despawn(right).unwrap();
    world.removeComponent(camera, CameraView).unwrap();
  }
}

/**
 * Publication-mode frames still copy into renderer-local targets: the snapshot
 * is bit-exact with frame-N scene color and survives 60 later changed frames.
 */
export async function verifyPublicationSnapshot(input: {
  readonly renderer: Renderer;
  readonly assets: AssetRegistry;
  readonly identity: { readonly source: string; readonly epoch: number };
}): Promise<{ readonly mismatchBytes: number; readonly retainedMismatchBytes: number }> {
  const { renderer } = input;
  const target = renderValue(renderer.createRenderTarget(snapshotTargetDescriptor()));
  const scene = buildSnapshotScene(renderer, [], input);
  try {
    for (let frame = 0; frame < 10; frame++) await scene.draw();
    const ticket = renderValue(
      renderer.requestFramebufferSnapshot(target, { region: SOURCE_REGION }),
    );
    renderValue(required(renderer.requestObservation).call(renderer, ['linear-hdr']));
    const observed = renderValue(
      await renderer.observe(await scene.draw(), {
        include: ['linear-hdr'],
        framebufferSnapshots: [ticket],
      }),
    );
    expect(observed.framebufferSnapshots).toHaveLength(1);
    const expected = hdrRegion(required(observed.observations?.[0]), SOURCE_REGION);
    expect(meanHalf(expected)[0]).toBeGreaterThan(0.5);
    recolorSource(scene, BLUE);
    const mismatchBytes = mismatches(await readTarget(renderer, scene, target), expected);
    expect(mismatchBytes).toBe(0);
    for (let frame = 0; frame < RETAINED_FRAMES; frame++) await scene.draw();
    const retainedMismatchBytes = mismatches(await readTarget(renderer, scene, target), expected);
    expect(retainedMismatchBytes).toBe(0);
    return { mismatchBytes, retainedMismatchBytes };
  } finally {
    scene.dispose();
    renderer.destroyRenderTarget(target);
  }
}

export interface SnapshotCost {
  readonly size: number;
  readonly frames: number;
  readonly cpuDrawMedianMs: { readonly without: number; readonly with: number };
  readonly completionMedianMs: { readonly without: number; readonly with: number };
}

/**
 * Median CPU time of `renderer.draw` and submit-to-completion latency with and
 * without a full-canvas `size`² snapshot armed each frame.
 */
export async function measureSnapshotCost(
  renderer: Renderer,
  size: number,
  frames = 40,
): Promise<SnapshotCost> {
  const target = renderValue(renderer.createRenderTarget(snapshotTargetDescriptor(size)));
  const scene = buildSnapshotScene(renderer, []);
  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  const sample = async (snapshot: boolean) => {
    const cpu: number[] = [];
    const completion: number[] = [];
    for (let frame = 0; frame < frames; frame++) {
      const ticket = snapshot
        ? renderValue(
            renderer.requestFramebufferSnapshot(target, {
              region: { x: 0, y: 0, width: size, height: size },
            }),
          )
        : undefined;
      const receipt = await scene.draw();
      cpu.push(scene.timing.cpuMs);
      completion.push(scene.timing.completionMs);
      if (ticket !== undefined)
        renderValue(
          await renderer.observe(receipt, { include: [], framebufferSnapshots: [ticket] }),
        );
    }
    return { cpu: median(cpu), completion: median(completion) };
  };
  try {
    for (let frame = 0; frame < 10; frame++) await scene.draw();
    const without = await sample(false);
    const withSnapshot = await sample(true);
    const again = await sample(false);
    return {
      size,
      frames,
      cpuDrawMedianMs: { without: Math.min(without.cpu, again.cpu), with: withSnapshot.cpu },
      completionMedianMs: {
        without: Math.min(without.completion, again.completion),
        with: withSnapshot.completion,
      },
    };
  } finally {
    scene.dispose();
    renderer.destroyRenderTarget(target);
  }
}
