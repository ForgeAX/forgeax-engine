import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import {
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  Camera,
  createRenderPublisher,
  type FrameReceipt,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  RenderPublicationTargetOwner,
  renderPublicationTransfers,
  StereoCamera,
  type StereoCameraData,
  StereoLayoutValue,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  encodeTape,
  openReplay,
  type RecorderAttachment,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { renderValue } from './standard-gbuffer-replay.fixture';

export type StereoSave = (name: string, bytes: Uint8Array) => void | Promise<void>;
export interface StereoSize {
  readonly width: number;
  readonly height: number;
}
export interface StereoPublication {
  readonly assets: AssetRegistry;
  readonly identity: { readonly source: string; readonly epoch: number };
}

const FOV = Math.PI / 3;
const NEAR = 0.1;
const FAR = 50;
const SEPARATION = 0.4;
const CONVERGENCE = 5;
const HALF_DEPTH = 0.01;
/** Near (above), convergence (centre), and far (below) boxes; each has every channel lit. */
const OBJECTS = [
  { name: 'near', z: -2, y: 0.5, size: 0.3, color: [1, 0.35, 0.35, 1] },
  { name: 'convergence', z: -CONVERGENCE, y: 0, size: 0.75, color: [0.35, 1, 0.35, 1] },
  { name: 'far', z: -15, y: -3.75, size: 2.25, color: [0.35, 0.35, 1, 1] },
] as const;
type ObjectName = (typeof OBJECTS)[number]['name'];
/** Row bands (fraction of eye height) that contain exactly one object each. */
const BANDS: Record<ObjectName, readonly [number, number]> = {
  near: [0, 0.39],
  convergence: [0.39, 0.61],
  far: [0.61, 1],
};

interface Image {
  readonly width: number;
  readonly height: number;
  /** Tightly packed RGBA8. */
  readonly rgba: Uint8Array;
}
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Three.js StereoCamera screen disparity (left minus right) in eye pixels at view depth `d`. */
export function expectedDisparityPixels(
  distance: number,
  eyeWidth: number,
  eyeHeight: number,
  separation = SEPARATION,
): number {
  const aspect = eyeWidth / eyeHeight;
  const ndc = (separation / (Math.tan(FOV / 2) * aspect)) * (1 / distance - 1 / CONVERGENCE);
  return (ndc * eyeWidth) / 2;
}

function stereoData(overrides: Partial<StereoCameraData> = {}): StereoCameraData {
  return {
    eyeSeparation: SEPARATION,
    convergence: CONVERGENCE,
    layout: StereoLayoutValue['side-by-side'],
    swapEyes: false,
    ...overrides,
  };
}

function buildScene(
  world: World,
  stereo: StereoCameraData | undefined,
  antialias: number,
): EntityHandle {
  const mesh = (size: number) =>
    world.allocSharedRef('MeshAsset', createBoxGeometry(size, size, HALF_DEPTH * 2).unwrap());
  for (const object of OBJECTS)
    world
      .spawn(
        { component: Transform, data: { pos: [0, object.y, object.z] } },
        { component: MeshFilter, data: { assetHandle: mesh(object.size) } },
        {
          component: MeshRenderer,
          data: {
            materials: [world.allocSharedRef('MaterialAsset', Materials.unlit([...object.color]))],
          },
        },
      )
      .unwrap();
  return world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      {
        component: Camera,
        data: {
          fov: FOV,
          near: NEAR,
          far: FAR,
          antialias,
          clearColor: [0.02, 0.02, 0.02, 1],
        },
      },
      ...(stereo === undefined ? [] : [{ component: StereoCamera, data: stereo } as never]),
    )
    .unwrap();
}

/** One World or publication draw loop over the same renderer. */
function createDriver(
  renderer: Renderer,
  world: World,
  publication: StereoPublication | undefined,
) {
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
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
  let time = 0;
  const draw = async (): Promise<FrameReceipt> => {
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
      const result = renderer.draw(
        packet === undefined
          ? {
              leases: [required(lease)],
              camera: { lease: required(lease) },
              environment: { lease: required(lease) },
            }
          : { publication: packet },
      );
      if (!result.ok) throw new Error(JSON.stringify({ failure: result.error, errors }));
      renderValue(await result.value.completed);
      return result.value;
    } finally {
      if (packet !== undefined)
        required(publisher).recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    }
  };
  return {
    draw,
    errors,
    dispose() {
      off();
      lease?.dispose();
      publisher?.dispose();
      targetOwner?.dispose();
    },
  };
}

async function observeFinal(
  renderer: Renderer,
  receipt: FrameReceipt,
  size: StereoSize,
): Promise<Image> {
  const observation = required(
    required(
      renderValue(await renderer.observe(receipt, { include: ['final-display'] })).observations,
    ).find((o) => o.domain === 'final-display'),
  );
  return packRgba(
    observation.bytes,
    observation.metadata.bytesPerRow,
    observation.metadata.format,
    size,
  );
}

function packRgba(
  bytes: Uint8Array,
  bytesPerRow: number,
  format: string | undefined,
  size: StereoSize,
): Image {
  const bgra = format?.startsWith('bgra') === true;
  const rgba = new Uint8Array(size.width * size.height * 4);
  for (let y = 0; y < size.height; y++)
    for (let x = 0; x < size.width; x++) {
      const from = y * bytesPerRow + x * 4,
        to = (y * size.width + x) * 4;
      rgba[to] = required(bytes[from + (bgra ? 2 : 0)]);
      rgba[to + 1] = required(bytes[from + 1]);
      rgba[to + 2] = required(bytes[from + (bgra ? 0 : 2)]);
      rgba[to + 3] = required(bytes[from + 3]);
    }
  return { width: size.width, height: size.height, rgba };
}

/** Foreground centroid of each object band inside one eye rectangle, in eye-local pixels. */
function eyeCentroids(
  image: Image,
  rect: Rect,
  channel: 'any' | 0 | 1,
): Record<ObjectName, { x: number; y: number; count: number }> {
  const out = {} as Record<ObjectName, { x: number; y: number; count: number }>;
  for (const object of OBJECTS) {
    const [from, to] = BANDS[object.name];
    let sx = 0,
      sy = 0,
      count = 0;
    for (let y = Math.floor(from * rect.height); y < Math.ceil(to * rect.height); y++)
      for (let x = 0; x < rect.width; x++) {
        const i = ((rect.y + y) * image.width + rect.x + x) * 4;
        const r = required(image.rgba[i]),
          g = required(image.rgba[i + 1]),
          b = required(image.rgba[i + 2]);
        const value = channel === 'any' ? Math.max(r, g, b) : channel === 0 ? r : g;
        if (value > 100) {
          sx += x + 0.5;
          sy += y + 0.5;
          count++;
        }
      }
    out[object.name] = { x: sx / Math.max(count, 1), y: sy / Math.max(count, 1), count };
  }
  return out;
}

interface Disparity {
  readonly layout: 'side-by-side' | 'top-bottom' | 'anaglyph';
  readonly eye: { readonly width: number; readonly height: number };
  readonly measured: Record<ObjectName, number>;
  readonly expected: Record<ObjectName, number>;
  readonly pixels: Record<ObjectName, readonly [number, number]>;
}

function measureDisparity(
  image: Image,
  layout: Disparity['layout'],
  separation: number,
): Disparity {
  const { width, height } = image;
  const [slot0, slot1]: [Rect, Rect] =
    layout === 'side-by-side'
      ? [
          { x: 0, y: 0, width: width / 2, height },
          { x: width / 2, y: 0, width: width / 2, height },
        ]
      : layout === 'top-bottom'
        ? [
            { x: 0, y: 0, width, height: height / 2 },
            { x: 0, y: height / 2, width, height: height / 2 },
          ]
        : [
            { x: 0, y: 0, width, height },
            { x: 0, y: 0, width, height },
          ];
  const first = eyeCentroids(image, slot0, layout === 'anaglyph' ? 0 : 'any');
  const second = eyeCentroids(image, slot1, layout === 'anaglyph' ? 1 : 'any');
  const measured = {} as Record<ObjectName, number>;
  const expected = {} as Record<ObjectName, number>;
  const pixels = {} as Record<ObjectName, readonly [number, number]>;
  for (const object of OBJECTS) {
    measured[object.name] = first[object.name].x - second[object.name].x;
    expected[object.name] = expectedDisparityPixels(
      -object.z - HALF_DEPTH,
      slot0.width,
      slot0.height,
      separation,
    );
    pixels[object.name] = [first[object.name].count, second[object.name].count];
  }
  return { layout, eye: { width: slot0.width, height: slot0.height }, measured, expected, pixels };
}

function expectDisparity(disparity: Disparity, sign: 1 | -1, tolerance: number) {
  for (const object of OBJECTS) {
    const [a, b] = disparity.pixels[object.name];
    expect(a, `${disparity.layout} ${object.name} visible in slot 0`).toBeGreaterThan(8);
    expect(b, `${disparity.layout} ${object.name} visible in slot 1`).toBeGreaterThan(8);
    expect(
      Math.abs(disparity.measured[object.name] - sign * disparity.expected[object.name]),
      `${disparity.layout} ${object.name} disparity ${disparity.measured[object.name]} vs ${
        sign * disparity.expected[object.name]
      }`,
    ).toBeLessThanOrEqual(tolerance);
  }
}

function halfDelta(image: Image): number {
  let delta = 0;
  const half = image.width / 2;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < half; x++)
      for (let c = 0; c < 4; c++) {
        const a = required(image.rgba[(y * image.width + x) * 4 + c]);
        const b = required(image.rgba[(y * image.width + x + half) * 4 + c]);
        delta = Math.max(delta, Math.abs(a - b));
      }
  return delta;
}

function cropRgba(image: Image, rect: Rect): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++)
    out.set(
      image.rgba.subarray(
        ((rect.y + y) * image.width + rect.x) * 4,
        ((rect.y + y) * image.width + rect.x + rect.width) * 4,
      ),
      y * rect.width * 4,
    );
  return out;
}

/** Expected unjittered viewProj of one eye at the identity camera pose. */
function expectedEyeViewProjection(eye: 'left' | 'right', aspect: number): Float32Array {
  const projection = mat4.perspectiveReverseZ(mat4.create(), FOV, aspect, NEAR, FAR);
  const sign = eye === 'left' ? 1 : -1;
  projection[8] = (sign * SEPARATION * 0.5) / (CONVERGENCE * Math.tan(FOV / 2) * aspect);
  const view = mat4.identity(mat4.create());
  view[12] = eye === 'left' ? SEPARATION / 2 : -SEPARATION / 2;
  return mat4.multiply(mat4.create(), projection, view);
}

export interface StereoSummary {
  readonly mode: 'world' | 'publication';
  readonly size: StereoSize;
  readonly frames: number;
  readonly disparity: readonly Disparity[];
  readonly falsifiers: Record<string, unknown>;
  readonly taa: unknown;
  readonly views: unknown;
  readonly rhi: unknown;
}

export async function verifyStereo(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: StereoSave,
  size: StereoSize,
  publication?: StereoPublication,
  settleFrames = 60,
): Promise<StereoSummary> {
  const world = new World();
  const requestObservation = required(renderer.requestObservation).bind(renderer);
  const camera = buildScene(world, stereoData(), ANTIALIAS_NONE);
  const driver = createDriver(renderer, world, publication);
  const observe = async () => {
    renderValue(requestObservation(['final-display']));
    return observeFinal(renderer, await driver.draw(), size);
  };
  const setStereo = async (overrides: Partial<StereoCameraData>) => {
    world.set(camera, StereoCamera, stereoData(overrides)).unwrap();
    for (let i = 0; i < 2; i++) await driver.draw();
    return observe();
  };
  try {
    let frames = 0;
    for (; frames < settleFrames; frames++) await driver.draw();
    expect(driver.errors).toEqual([]);
    const views = required(renderer.inspect().views).map((view) => ({
      entityKey: view.entityKey,
      eye: view.eye,
      viewport: view.viewport,
      width: view.width,
      height: view.height,
      renderedFrames: view.renderedFrames,
    }));
    expect(views.map((view) => view.eye)).toEqual(['left', 'right']);
    expect(views.map((view) => view.viewport)).toEqual([
      [0, 0, size.width / 2, size.height],
      [size.width / 2, 0, size.width / 2, size.height],
    ]);
    for (const view of views) expect(view.renderedFrames).toBeGreaterThanOrEqual(settleFrames);

    // RHI Debug: the SBS observation frame is captured, replayed, and inspected per eye.
    renderValue(requestObservation(['final-display']));
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const receipt = await driver.draw();
    (await recorder.frameBoundary()).unwrap();
    const capture = (await pending).unwrap();
    const sbs = await observeFinal(renderer, receipt, size);
    await save('sbs.rhitape', capture.bytes);
    await save('sbs.rgba', sbs.rgba);
    const eyeRect = (slot: 0 | 1): Rect => ({
      x: (slot * size.width) / 2,
      y: 0,
      width: size.width / 2,
      height: size.height,
    });
    await save('eye-left.rgba', cropRgba(sbs, eyeRect(0)));
    await save('eye-right.rgba', cropRgba(sbs, eyeRect(1)));
    const sideBySide = measureDisparity(sbs, 'side-by-side', SEPARATION);
    expectDisparity(sideBySide, 1, 1);
    expect(sideBySide.measured.near).toBeGreaterThan(8);
    expect(Math.abs(sideBySide.measured.convergence)).toBeLessThanOrEqual(0.5);
    expect(sideBySide.measured.far).toBeLessThan(-3);
    const rhi = await inspectTape(capture.bytes, capture.digest, sbs, size, save);

    const swapped = await setStereo({ swapEyes: true });
    await save('sbs-swapped.rgba', swapped.rgba);
    const swappedDisparity = measureDisparity(swapped, 'side-by-side', SEPARATION);
    expectDisparity(swappedDisparity, -1, 1);

    const zero = await setStereo({ eyeSeparation: 0 });
    await save('sbs-zero-separation.rgba', zero.rgba);
    const zeroDelta = halfDelta(zero);
    expect(zeroDelta).toBeLessThanOrEqual(1);
    expect(halfDelta(sbs)).toBeGreaterThan(100);

    const topBottom = await setStereo({ layout: StereoLayoutValue['top-bottom'] });
    await save('tb.rgba', topBottom.rgba);
    const tbDisparity = measureDisparity(topBottom, 'top-bottom', SEPARATION);
    expectDisparity(tbDisparity, 1, 1);
    const tbViews = required(renderer.inspect().views).map((view) => view.viewport);
    expect(tbViews).toEqual([
      [0, 0, size.width, size.height / 2],
      [0, size.height / 2, size.width, size.height / 2],
    ]);

    const anaglyph = await setStereo({ layout: StereoLayoutValue.anaglyph });
    await save('anaglyph.rgba', anaglyph.rgba);
    const anaglyphDisparity = measureDisparity(anaglyph, 'anaglyph', SEPARATION);
    expectDisparity(anaglyphDisparity, 1, 1);

    // TAA keeps an independent history per eye across the settling window.
    world.set(camera, Camera, { antialias: ANTIALIAS_TAA }).unwrap();
    world.set(camera, StereoCamera, stereoData()).unwrap();
    for (let i = 0; i < settleFrames; i++) await driver.draw();
    frames += settleFrames;
    const taaImage = await observe();
    await save('sbs-taa.rgba', taaImage.rgba);
    const taaViews = required(renderer.inspect().views);
    const taa = taaViews.map((view) => ({
      eye: view.eye,
      status: view.temporal.status,
      historyValid: view.temporal.historyValid,
      frameIndex: view.temporal.frameIndex,
      historyBytes: view.temporal.historyBytes,
    }));
    expect(taa.map((row) => row.eye)).toEqual(['left', 'right']);
    for (const row of taa) {
      expect(row.historyValid).toBe(true);
      expect(row.frameIndex).toBeGreaterThanOrEqual(settleFrames - 1);
      expect(row.historyBytes).toBeGreaterThan(0);
    }
    const taaDisparity = measureDisparity(taaImage, 'side-by-side', SEPARATION);
    expectDisparity(taaDisparity, 1, 1.5);
    expect(driver.errors).toEqual([]);
    return {
      mode: publication === undefined ? 'world' : 'publication',
      size: { width: size.width, height: size.height },
      frames,
      disparity: [sideBySide, swappedDisparity, tbDisparity, anaglyphDisparity, taaDisparity],
      falsifiers: {
        zeroSeparationMaxHalfDelta: zeroDelta,
        stereoMaxHalfDelta: halfDelta(sbs),
        swappedNear: swappedDisparity.measured.near,
      },
      taa,
      views,
      rhi,
    };
  } finally {
    driver.dispose();
  }
}

async function inspectTape(
  bytes: Uint8Array,
  digest: string,
  live: Image,
  size: StereoSize,
  save: StereoSave,
) {
  const tape = decodeTape(bytes).unwrap();
  const model = buildFrameModel(tape);
  const composites = model.works.filter((work) =>
    work.pipeline.shaders.some((shader) => shader.source?.includes('var picture: texture_2d')),
  );
  expect(composites).toHaveLength(2);
  expect(tape.events.filter((event) => event.kind === 'submit')).toHaveLength(1);
  const viewports = composites.map((work) => {
    const event = tape.events
      .slice(0, work.eventIndex)
      .reverse()
      .find((candidate) => candidate.kind === 'setViewport');
    if (event?.kind !== 'setViewport') throw new Error('composite has no viewport');
    return [event.x, event.y, event.w, event.h];
  });
  expect(viewports).toEqual([
    [0, 0, size.width / 2, size.height],
    [size.width / 2, 0, size.width / 2, size.height],
  ]);
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
  ).unwrap();
  const replay = (
    await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  const eyeUniforms: {
    eye: 'left' | 'right';
    workIndex: number;
    position: number[];
    near: number;
    far: number;
    viewProjectionMaxError: number;
  }[] = [];
  let replayDelta = 0;
  try {
    const seen = new Set<string>();
    for (const work of model.works) {
      if (eyeUniforms.length === 2) break;
      if (work.attachments?.depthStencilViewHandleId == null) continue;
      for (const binding of work.bindings) {
        if (binding.resourceKind !== 'buffer' || binding.resourceId === null) continue;
        if ((binding.bufferSize ?? 0) < 232 * 4) continue;
        const offset = (binding.bufferOffset ?? 0) + (binding.dynamicOffset ?? 0);
        const key = `${binding.resourceId}@${offset}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const read = await replay.readResourceAtWork(binding.resourceId, work.workIndex, {
          offset,
          size: 232 * 4,
        });
        if (!read.ok) continue;
        const floats = new Float32Array(
          read.value.bytes.buffer.slice(
            read.value.bytes.byteOffset,
            read.value.bytes.byteOffset + 232 * 4,
          ),
        );
        if (Math.abs(required(floats[228]) - NEAR) > 1e-6) continue;
        if (Math.abs(required(floats[229]) - FAR) > 1e-4) continue;
        const x = required(floats[24]);
        const eye = x < 0 ? 'left' : 'right';
        if (eyeUniforms.some((row) => row.eye === eye)) continue;
        const expected = expectedEyeViewProjection(eye, size.width / 2 / size.height);
        let error = 0;
        for (let i = 0; i < 16; i++)
          error = Math.max(error, Math.abs(required(floats[196 + i]) - required(expected[i])));
        eyeUniforms.push({
          eye,
          workIndex: work.workIndex,
          position: [x, required(floats[25]), required(floats[26])],
          near: required(floats[228]),
          far: required(floats[229]),
          viewProjectionMaxError: error,
        });
        break;
      }
    }
    eyeUniforms.sort((a, b) => a.eye.localeCompare(b.eye));
    expect(eyeUniforms.map((row) => row.eye)).toEqual(['left', 'right']);
    for (const row of eyeUniforms) {
      expect(row.position[0]).toBeCloseTo(row.eye === 'left' ? -SEPARATION / 2 : SEPARATION / 2, 5);
      expect(row.viewProjectionMaxError).toBeLessThan(1e-4);
    }
    const inspection = (
      await replay.inspectWork(required(composites.at(-1)).workIndex, ['pipeline', 'pixels'])
    ).unwrap();
    const attachment = required(inspection.attachment);
    const replayed = packRgba(attachment.bytes, size.width * 4, attachment.format, size);
    await save('sbs-replay.rgba', replayed.rgba);
    for (let i = 0; i < replayed.rgba.length; i++)
      replayDelta = Math.max(
        replayDelta,
        Math.abs(required(replayed.rgba[i]) - required(live.rgba[i])),
      );
    expect(replayDelta).toBeLessThanOrEqual(1);
  } finally {
    (await replay.dispose()).unwrap();
  }
  // Falsifier: dropping the right-eye composite draw must blank the right half on replay.
  const last = required(composites.at(-1));
  const falsified = encodeTape({
    ...tape,
    events: tape.events.map((event, index) =>
      index === last.eventIndex && event.kind === 'draw' ? { ...event, vertexCount: 0 } : event,
    ),
  }).unwrap();
  const falsifierAdapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const falsifierDevice = (
    await falsifierAdapter.requestDevice(
      replayDeviceRequest(tape, falsifierAdapter.features, falsifierAdapter.limits),
    )
  ).unwrap();
  const falsifier = (
    await openReplay(decodeTape(falsified).unwrap(), {
      device: falsifierDevice,
      createShaderModule: webgpu.createShaderModule,
    })
  ).unwrap();
  let falsifierRightMax = 0;
  try {
    const result = (await falsifier.inspectWork(last.workIndex, ['pixels'])).unwrap();
    const attachment = required(result.attachment);
    const image = packRgba(attachment.bytes, size.width * 4, attachment.format, size);
    await save('sbs-missing-right-eye.falsifier.rgba', image.rgba);
    for (let y = 0; y < size.height; y++)
      for (let x = size.width / 2; x < size.width; x++)
        for (let c = 0; c < 3; c++)
          falsifierRightMax = Math.max(
            falsifierRightMax,
            required(image.rgba[(y * size.width + x) * 4 + c]),
          );
    expect(falsifierRightMax).toBeLessThanOrEqual(1);
  } finally {
    (await falsifier.dispose()).unwrap();
  }
  return {
    digest,
    compositeWorks: composites.map((work) => work.workIndex),
    compositeViewports: viewports,
    eyeUniforms,
    liveVsReplayMaxDelta: replayDelta,
    missingRightEyeFalsifierMax: falsifierRightMax,
  };
}

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error('Expected stereo evidence');
  return value;
}
