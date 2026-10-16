import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createPlaneGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  orthographic,
  perspective,
  type Renderer,
  type RenderResult,
  type RenderTarget,
  type RenderTargetDescriptor,
  type RenderTargetReadbackData,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  type EncodedTape,
  encodeTape,
  openReplay,
  type RecorderAttachment,
  replayDeviceRequest,
  type Tape,
} from '@forgeax/engine-rhi-debug';
import type * as webgpuBackend from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { halfToFloat } from './contact-shadow.fixture';

/** Module id of `fixtures/layered-target/layered-target.wgsl`. */
export const LAYERED_TARGET_SHADER = 'layered_fixture::layered_target';
export const LAYERED_CANVAS_SIZE = 128;
export const LAYERED_TARGET_SIZE = 32;
export const VOLUME_SLICES = 4;
export const ARRAY_LAYERS = 3;
/** Linear sampled-value tolerance for 8-bit targets through one material sample. */
export const LAYERED_EPSILON = 0.05;

type Rgb = readonly [number, number, number];
/** Distinct clear color per volume slice; slice 3 is also the feedback probe. */
export const VOLUME_COLORS: readonly Rgb[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 0],
];
export const ARRAY_COLORS: readonly Rgb[] = [
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];
/** Unlit marker every non-feedback writer draws at its view center. */
export const MARKER_COLOR: Rgb = [0.25, 0.5, 0.75];

function unwrap<T>(result: RenderResult<T, unknown> | undefined): T {
  if (result === undefined) throw new Error('required Renderer operation is unavailable');
  if (!result.ok) throw result.error;
  return result.value;
}

function descriptor(
  shape: '3d' | '2d-array' | '2d',
  layers: number,
  readback = true,
): RenderTargetDescriptor {
  const facts = {
    width: LAYERED_TARGET_SIZE,
    height: LAYERED_TARGET_SIZE,
    format: 'rgba8unorm' as const,
    sampleCount: 1 as const,
    mipLevels: 1 as const,
    sampled: true,
    readback,
  };
  return shape === '2d' ? { ...facts, shape } : { ...facts, shape, depthOrArrayLayers: layers };
}

const WRITER_EYE: readonly [number, number, number] = [0, 0, 1];
const DISPLAY_EYE: readonly [number, number, number] = [0, 0, 5];

function spawnWriter(
  world: World,
  target: RenderTarget,
  layer: number,
  color: Rgb,
  facing: 'marker' | 'display',
): EntityHandle {
  const eye = facing === 'marker' ? WRITER_EYE : DISPLAY_EYE;
  const at: [number, number, number] = facing === 'marker' ? [0, 0, 10] : [0, 0, 0];
  return world
    .spawn(
      {
        component: Transform,
        data: { pos: [...eye], quat: quat.fromLookAt(quat.create(), [...eye], at, [0, 1, 0]) },
      },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 40, autoAspect: false }),
          clearColor: [color[0], color[1], color[2], 1],
          target: world.allocSharedRef('RenderTarget', target),
          targetLayer: layer,
        },
      },
    )
    .unwrap();
}

function spawnMarker(world: World): void {
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 10] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: world.allocSharedRef('MeshAsset', createBoxGeometry(2, 2, 2).unwrap()),
        },
      },
      {
        component: MeshRenderer,
        data: {
          materials: [world.allocSharedRef('MaterialAsset', Materials.unlit([...MARKER_COLOR, 1]))],
        },
      },
    )
    .unwrap();
}

/** Quad world centers: slices on the top row, array layers on the bottom row. */
export function displayQuadCenter(kind: 'volume' | 'array', index: number): [number, number] {
  return kind === 'volume' ? [-3 + 2 * index, 1.5] : [-2 + 2 * index, -1.5];
}
const QUAD_SIZE = 1.6;
const ORTHO_HALF = 4;

function worldToPixel(x: number, y: number): [number, number] {
  const scale = LAYERED_CANVAS_SIZE / (2 * ORTHO_HALF);
  return [Math.floor((x + ORTHO_HALF) * scale), Math.floor((ORTHO_HALF - y) * scale)];
}

interface LayeredScene {
  readonly world: World;
  readonly volume: RenderTarget;
  readonly array: RenderTarget;
}

/**
 * Slice 3 looks at the consumer quads, which all sample the volume: feedback
 * exclusion must omit them, leaving that slice its pure clear color.
 * `layers[i]` is the slice writer `i` targets (the falsifier permutes it).
 */
function spawnVolumeWriters(scene: LayeredScene, layers: readonly number[]): EntityHandle[] {
  return VOLUME_COLORS.map((color, writer) =>
    spawnWriter(
      scene.world,
      scene.volume,
      layers[writer] ?? writer,
      color,
      writer === 3 ? 'display' : 'marker',
    ),
  );
}

function spawnArrayWriters(scene: LayeredScene): EntityHandle[] {
  return ARRAY_COLORS.map((color, layer) =>
    spawnWriter(scene.world, scene.array, layer, color, 'marker'),
  );
}

function despawnAll(world: World, entities: readonly EntityHandle[]): void {
  for (const entity of entities) world.despawn(entity).unwrap();
}

function buildLayeredScene(renderer: Renderer): LayeredScene {
  const world = new World();
  const volume = unwrap(renderer.createRenderTarget(descriptor('3d', VOLUME_SLICES)));
  const array = unwrap(renderer.createRenderTarget(descriptor('2d-array', ARRAY_LAYERS)));
  const volumeSource = unwrap(
    renderer.createRenderTargetTextureSource(volume, {
      aspect: 'color',
      dimension: '3d',
      mipLevel: 0,
    }),
  );
  const arraySource = unwrap(
    renderer.createRenderTargetTextureSource(array, {
      aspect: 'color',
      dimension: '2d-array',
      mipLevel: 0,
    }),
  );
  spawnMarker(world);
  const volumeHandle = world.allocSharedRef('RenderTargetTextureSource', volumeSource);
  const arrayHandle = world.allocSharedRef('RenderTargetTextureSource', arraySource);
  const plane = world.allocSharedRef(
    'MeshAsset',
    createPlaneGeometry(QUAD_SIZE, QUAD_SIZE).unwrap(),
  );
  const quad = (kind: 'volume' | 'array', index: number) => {
    const material: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: {
            module: LAYERED_TARGET_SHADER,
            vertexEntry: 'vs_main',
            fragmentEntry: 'fs_main',
          },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      parameters: [
        { name: 'slice', type: 'f32' },
        { name: 'layer', type: 'f32' },
        { name: 'mode', type: 'f32' },
        { name: 'volumeTexture', type: 'texture_3d' },
        { name: 'layerTexture', type: 'texture_2d_array' },
      ],
      values: {
        slice: kind === 'volume' ? (index + 0.5) / VOLUME_SLICES : 0,
        layer: kind === 'array' ? index : 0,
        mode: kind === 'array' ? 1 : 0,
        volumeTexture: volumeHandle,
        layerTexture: arrayHandle,
      },
    };
    const [x, y] = displayQuadCenter(kind, index);
    world
      .spawn(
        { component: Transform, data: { pos: [x, y, 0] } },
        { component: MeshFilter, data: { assetHandle: plane } },
        {
          component: MeshRenderer,
          data: { materials: [world.allocSharedRef('MaterialAsset', material)] },
        },
      )
      .unwrap();
  };
  for (let slice = 0; slice < VOLUME_SLICES; slice++) quad('volume', slice);
  for (let layer = 0; layer < ARRAY_LAYERS; layer++) quad('array', layer);
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [...DISPLAY_EYE],
          quat: quat.fromLookAt(quat.create(), [...DISPLAY_EYE], [0, 0, 0], [0, 1, 0]),
        },
      },
      {
        component: Camera,
        data: {
          ...orthographic({
            left: -ORTHO_HALF,
            right: ORTHO_HALF,
            bottom: -ORTHO_HALF,
            top: ORTHO_HALF,
            near: 0.1,
            far: 40,
          }),
          autoAspect: false,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  return { world, volume, array };
}

export interface LinearImage {
  readonly width: number;
  readonly height: number;
  /** Row-major linear RGBA. */
  readonly rgba: Float32Array;
}

function decodeHdr(bytes: Uint8Array, size: number, bytesPerRow: number): LinearImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rgba = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      for (let c = 0; c < 4; c++)
        rgba[(y * size + x) * 4 + c] = halfToFloat(
          view.getUint16(y * bytesPerRow + x * 8 + c * 2, true),
        );
  return { width: size, height: size, rgba };
}

function decodeUnorm(bytes: Uint8Array, size: number, bytesPerRow: number): LinearImage {
  const rgba = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      for (let c = 0; c < 4; c++)
        rgba[(y * size + x) * 4 + c] = (bytes[y * bytesPerRow + x * 4 + c] ?? 0) / 255;
  return { width: size, height: size, rgba };
}

export function pixel(image: LinearImage, x: number, y: number): Rgb {
  const base = (y * image.width + x) * 4;
  return [
    image.rgba[base] ?? Number.NaN,
    image.rgba[base + 1] ?? Number.NaN,
    image.rgba[base + 2] ?? Number.NaN,
  ];
}

export function matches(actual: Rgb, expected: Rgb, epsilon = LAYERED_EPSILON): boolean {
  return actual.every((value, channel) => Math.abs(value - (expected[channel] ?? 0)) <= epsilon);
}

/** Region-level target content: clear color at the corner, marker at the center. */
export interface LayerContent {
  readonly corner: Rgb;
  readonly center: Rgb;
}

function layerContent(image: LinearImage): LayerContent {
  return {
    corner: pixel(image, 2, 2),
    center: pixel(image, LAYERED_TARGET_SIZE / 2, LAYERED_TARGET_SIZE / 2),
  };
}

function expectedVolume(slice: number): LayerContent {
  const clear = VOLUME_COLORS[slice] ?? [0, 0, 0];
  return { corner: clear, center: slice === 3 ? clear : MARKER_COLOR };
}

function expectedArray(layer: number): LayerContent {
  return { corner: ARRAY_COLORS[layer] ?? [0, 0, 0], center: MARKER_COLOR };
}

function contentMatches(actual: LayerContent, expected: LayerContent): boolean {
  return matches(actual.corner, expected.corner) && matches(actual.center, expected.center);
}

/** Canvas samples of one consumer quad: its corner region and its center. */
function quadContent(canvas: LinearImage, kind: 'volume' | 'array', index: number): LayerContent {
  const [x, y] = displayQuadCenter(kind, index);
  const offset = QUAD_SIZE * 0.3;
  const [cx, cy] = worldToPixel(x - offset, y - offset);
  const [mx, my] = worldToPixel(x, y);
  return { corner: pixel(canvas, cx, cy), center: pixel(canvas, mx, my) };
}

export interface LayeredEvidence {
  readonly frames: number;
  readonly canvas: LinearImage;
  /** Volume slices read back on the frame that wrote them. */
  readonly volumeLayers: readonly LinearImage[];
  /** Array layers read back on the frame that wrote them. */
  readonly arrayLayers: readonly LinearImage[];
  readonly canvasQuads: {
    readonly volume: readonly LayerContent[];
    readonly array: readonly LayerContent[];
  };
  /** Final-frame readback of every layer: array written live, volume retained. */
  readonly readbackLayers: {
    readonly volume: readonly LayerContent[];
    readonly array: readonly LayerContent[];
  };
  readonly falsifier: {
    readonly swappedSlice0: LayerContent;
    readonly swappedQuad0: LayerContent;
    readonly originalExpectationRejected: boolean;
  };
  readonly volumeTape: EncodedTape;
  readonly arrayTape: EncodedTape;
  readonly errors: readonly unknown[];
}

type Readbacks = 'none' | 'volume' | 'all';

async function drawObserved(
  renderer: Renderer,
  scene: LayeredScene,
  lease: Parameters<Renderer['draw']>[0]['leases'][number],
  readbacks: Readbacks,
  recorder?: RecorderAttachment,
): Promise<{
  canvas?: LinearImage;
  volume: LinearImage[];
  array: LinearImage[];
  tape?: EncodedTape;
}> {
  scene.world.update(1 / 60).unwrap();
  propagateTransforms(scene.world).unwrap();
  const arrayLayers = readbacks === 'all' ? ARRAY_LAYERS : 0;
  const tickets =
    readbacks === 'none'
      ? []
      : [
          ...Array.from({ length: VOLUME_SLICES }, (_, layer) =>
            unwrap(renderer.requestTargetReadback(scene.volume, { mipLevel: 0, layer })),
          ),
          ...Array.from({ length: arrayLayers }, (_, layer) =>
            unwrap(renderer.requestTargetReadback(scene.array, { mipLevel: 0, layer })),
          ),
        ];
  if (readbacks !== 'none') unwrap(renderer.requestObservation?.(['linear-hdr']));
  const pending = recorder?.captureFrame();
  if (pending !== undefined) (await recorder?.frameBoundary())?.unwrap();
  const frame = unwrap(
    renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
  );
  unwrap(await frame.completed);
  let tape: EncodedTape | undefined;
  if (pending !== undefined) {
    (await recorder?.frameBoundary())?.unwrap();
    tape = (await pending).unwrap();
  }
  if (readbacks === 'none')
    return { volume: [], array: [], ...(tape === undefined ? {} : { tape }) };
  const observed = unwrap(
    await renderer.observe(frame, {
      include: ['linear-hdr', 'target-readbacks'],
      targetReadbacks: tickets,
    }),
  );
  const hdr = observed.observations?.find((value) => value.domain === 'linear-hdr');
  if (hdr === undefined) throw new Error('missing linear-hdr canvas observation');
  const byTicket = new Map<unknown, RenderTargetReadbackData>(
    (observed.targetReadbacks ?? []).map((data) => [data.ticket, data]),
  );
  const decode = (index: number, layer: number) => {
    const data = byTicket.get(tickets[index]);
    if (data === undefined) throw new Error(`missing target readback ${index}`);
    expect(data.layer ?? 0).toBe(layer);
    return decodeUnorm(data.bytes, LAYERED_TARGET_SIZE, data.bytesPerRow);
  };
  return {
    canvas: decodeHdr(hdr.bytes, LAYERED_CANVAS_SIZE, hdr.metadata.bytesPerRow),
    volume: Array.from({ length: VOLUME_SLICES }, (_, layer) => decode(layer, layer)),
    array: Array.from({ length: arrayLayers }, (_, layer) => decode(VOLUME_SLICES + layer, layer)),
    ...(tape === undefined ? {} : { tape }),
  };
}

type Observed = Awaited<ReturnType<typeof drawObserved>>;

/**
 * Sixty frames with seven layered writers consumed by one custom material.
 * The Camera.target budget writes one target per frame, so the four volume
 * writers own frames 0-29 and the three array writers frames 30-59; the
 * volume's promoted image must survive its writers leaving. The falsifier then
 * swaps writers 0 and 1: slice 0 must change to writer 1's content.
 */
export async function verifyLayeredTargets(
  renderer: Renderer,
  recorder: RecorderAttachment,
): Promise<LayeredEvidence> {
  const scene = buildLayeredScene(renderer);
  const lease = unwrap(renderer.attach(scene.world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  try {
    const frames = 60;
    let writers = spawnVolumeWriters(scene, [0, 1, 2, 3]);
    let volumeFrame: Observed | undefined;
    let final: Observed | undefined;
    for (let index = 0; index < frames; index++) {
      if (index === 30) {
        despawnAll(scene.world, writers);
        writers = spawnArrayWriters(scene);
      }
      const readbacks: Readbacks = index === 29 ? 'volume' : index === frames - 1 ? 'all' : 'none';
      const result = await drawObserved(
        renderer,
        scene,
        lease,
        readbacks,
        readbacks === 'none' ? undefined : recorder,
      );
      if (index === 29) volumeFrame = result;
      if (index === frames - 1) final = result;
    }
    if (final?.canvas === undefined || final.tape === undefined || volumeFrame?.tape === undefined)
      throw new Error('missing layered frame evidence');
    const canvas = final.canvas;
    const readbackLayers = {
      volume: final.volume.map(layerContent),
      array: final.array.map(layerContent),
    };
    const canvasQuads = {
      volume: Array.from({ length: VOLUME_SLICES }, (_, slice) =>
        quadContent(canvas, 'volume', slice),
      ),
      array: Array.from({ length: ARRAY_LAYERS }, (_, layer) =>
        quadContent(canvas, 'array', layer),
      ),
    };
    despawnAll(scene.world, writers);
    writers = spawnVolumeWriters(scene, [1, 0, 2, 3]);
    let swapped: Observed | undefined;
    for (let index = 0; index < 4; index++)
      swapped = await drawObserved(renderer, scene, lease, index === 3 ? 'volume' : 'none');
    const swappedSlice = swapped?.volume[0];
    if (swapped?.canvas === undefined || swappedSlice === undefined)
      throw new Error('missing falsifier frame');
    const swappedSlice0 = layerContent(swappedSlice);
    const swappedQuad0 = quadContent(swapped.canvas, 'volume', 0);
    return {
      frames,
      canvas,
      volumeLayers: volumeFrame.volume,
      arrayLayers: final.array,
      canvasQuads,
      readbackLayers,
      falsifier: {
        swappedSlice0,
        swappedQuad0,
        originalExpectationRejected:
          !contentMatches(swappedSlice0, expectedVolume(0)) &&
          !contentMatches(swappedQuad0, expectedVolume(0)),
      },
      volumeTape: volumeFrame.tape,
      arrayTape: final.tape,
      errors,
    };
  } finally {
    unsubscribe();
    lease.dispose();
    unwrap(renderer.destroyRenderTarget(scene.volume));
    unwrap(renderer.destroyRenderTarget(scene.array));
  }
}

export function assertLayeredEvidence(evidence: LayeredEvidence): void {
  expect(evidence.errors, JSON.stringify(evidence.errors)).toEqual([]);
  evidence.readbackLayers.volume.forEach((content, slice) => {
    expect(content, `volume slice ${slice} readback`).toSatisfy((value: LayerContent) =>
      contentMatches(value, expectedVolume(slice)),
    );
  });
  evidence.readbackLayers.array.forEach((content, layer) => {
    expect(content, `array layer ${layer} readback`).toSatisfy((value: LayerContent) =>
      contentMatches(value, expectedArray(layer)),
    );
  });
  evidence.canvasQuads.volume.forEach((content, slice) => {
    expect(content, `volume slice ${slice} material sample`).toSatisfy((value: LayerContent) =>
      contentMatches(value, expectedVolume(slice)),
    );
  });
  evidence.canvasQuads.array.forEach((content, layer) => {
    expect(content, `array layer ${layer} material sample`).toSatisfy((value: LayerContent) =>
      contentMatches(value, expectedArray(layer)),
    );
  });
  // Falsifier: after swapping writers 0 and 1, slice 0 holds writer 1's clear.
  expect(evidence.falsifier.originalExpectationRejected).toBe(true);
  expect(matches(evidence.falsifier.swappedSlice0.corner, VOLUME_COLORS[1] ?? [0, 0, 0])).toBe(
    true,
  );
  expect(matches(evidence.falsifier.swappedSlice0.center, MARKER_COLOR)).toBe(true);
  expect(matches(evidence.falsifier.swappedQuad0.corner, VOLUME_COLORS[1] ?? [0, 0, 0])).toBe(true);
}

interface LayerWrite {
  readonly workIndex: number;
  readonly beginEventIndex: number;
  readonly textureId: string;
  readonly layer: number;
  readonly shape: '3d' | '2d-array';
}

/** Resolve every layered attachment write in a captured frame. */
export function layeredWrites(tape: Tape, model: ReturnType<typeof buildFrameModel>): LayerWrite[] {
  const views = new Map<string, { source: string; baseArrayLayer: number; dimension?: string }>();
  // Views created before the capture live in the bootstrap as `texture-view`
  // records; views created inside the frame are ordinary events.
  const creations = [
    ...tape.bootstrap.flatMap((record) =>
      record.kind === 'texture-view' ? [(record as { create: unknown }).create] : [],
    ),
    ...tape.events,
  ] as readonly {
    kind?: string;
    resultHandleId?: string;
    sourceHandleId?: string;
    desc?: unknown;
  }[];
  for (const event of creations) {
    if (event.kind !== 'createTextureView' || event.resultHandleId === undefined) continue;
    const desc = (event.desc ?? {}) as { baseArrayLayer?: number; dimension?: string };
    views.set(event.resultHandleId, {
      source: event.sourceHandleId ?? '',
      baseArrayLayer: desc.baseArrayLayer ?? 0,
      ...(desc.dimension === undefined ? {} : { dimension: desc.dimension }),
    });
  }
  const writes: LayerWrite[] = [];
  for (const pass of model.passes) {
    const viewId = pass.colorAttachmentViewHandleIds[0];
    const workIndex = pass.workIndices[pass.workIndices.length - 1];
    if (viewId === undefined || workIndex === undefined) continue;
    const view = views.get(viewId);
    if (view === undefined) continue;
    const depthSlice = pass.colorAttachmentDepthSlices[0];
    if (typeof depthSlice === 'number') {
      writes.push({
        workIndex,
        beginEventIndex: pass.beginEventIndex,
        textureId: view.source,
        layer: depthSlice,
        shape: '3d',
      });
    } else if (view.dimension === '2d' && view.baseArrayLayer >= 0) {
      writes.push({
        workIndex,
        beginEventIndex: pass.beginEventIndex,
        textureId: view.source,
        layer: view.baseArrayLayer,
        shape: '2d-array',
      });
    }
  }
  return writes;
}

export interface ReplayEvidence {
  readonly volumeDigest: string;
  readonly arrayDigest: string;
  readonly volumeWrites: readonly { readonly workIndex: number; readonly depthSlice: number }[];
  readonly arrayWrites: readonly { readonly workIndex: number; readonly layer: number }[];
  readonly replayLayers: {
    readonly volume: readonly LayerContent[];
    readonly array: readonly LayerContent[];
  };
  readonly replayVolumeImages: readonly LinearImage[];
  readonly replayArrayImages: readonly LinearImage[];
  readonly maxLiveReplayDelta: number;
  readonly falsifier: {
    readonly mutatedWork: number;
    readonly fromSlice: number;
    readonly toSlice: number;
    readonly unmutatedCorner: Rgb;
    readonly mutatedCorner: Rgb;
  };
}

type Replay = Awaited<ReturnType<typeof openReplay>>;

async function readLayer(
  session: Replay,
  id: string,
  work: number,
  layer: number,
): Promise<LinearImage> {
  if (!session.ok) throw new Error(`replay open failed: ${JSON.stringify(session.error)}`);
  const result = (
    await session.value.readResourceAtWork(id, work, { mipLevel: 0, arrayLayer: layer })
  ).unwrap();
  return decodeUnorm(
    result.bytes,
    LAYERED_TARGET_SIZE,
    result.bytes.byteLength / LAYERED_TARGET_SIZE,
  );
}

async function disposeReplay(session: Replay): Promise<void> {
  if (session.ok) (await session.value.dispose()).unwrap();
}

function maxDelta(left: readonly LinearImage[], right: readonly LinearImage[]): number {
  let maximum = 0;
  left.forEach((image, layer) => {
    const other = right[layer];
    if (other === undefined) return;
    for (let i = 0; i < image.rgba.length; i++)
      maximum = Math.max(maximum, Math.abs((image.rgba[i] ?? 0) - (other.rgba[i] ?? 0)));
  });
  return maximum;
}

/** The one texture every write of `shape` in the frame targets, with its writes. */
function layeredTexture(tape: Tape, shape: '3d' | '2d-array', layers: number): LayerWrite[] {
  const writes = layeredWrites(tape, buildFrameModel(tape)).filter(
    (write) => write.shape === shape,
  );
  const byTexture = new Map<string, LayerWrite[]>();
  for (const write of writes)
    byTexture.set(write.textureId, [...(byTexture.get(write.textureId) ?? []), write]);
  const expected = Array.from({ length: layers }, (_, layer) => layer).join(',');
  const group = [...byTexture.values()].find(
    (candidate) =>
      candidate
        .map((write) => write.layer)
        .sort((a, b) => a - b)
        .join(',') === expected,
  );
  if (group === undefined) throw new Error(`missing ${shape} layer writes in tape`);
  return group;
}

/**
 * Replay both captured frames on a fresh device, read every layer they wrote,
 * and prove the recorded depth slice is load-bearing by retargeting one volume
 * pass inside the tape.
 */
export async function replayLayeredTapes(
  webgpu: typeof webgpuBackend,
  live: LayeredEvidence,
): Promise<ReplayEvidence> {
  const volumeTape = decodeTape(live.volumeTape.bytes).unwrap();
  const arrayTape = decodeTape(live.arrayTape.bytes).unwrap();
  const volumeWrites = layeredTexture(volumeTape, '3d', VOLUME_SLICES);
  const arrayWrites = layeredTexture(arrayTape, '2d-array', ARRAY_LAYERS);
  const volumeTexture = volumeWrites[0]?.textureId ?? '';
  const arrayTexture = arrayWrites[0]?.textureId ?? '';
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(volumeTape, adapter.features, adapter.limits))
  ).unwrap();
  const open = (tape: Tape) =>
    openReplay(tape, { device, createShaderModule: webgpu.createShaderModule });
  const readAll = async (tape: Tape, id: string, layers: number) => {
    const session = await open(tape);
    try {
      const last = buildFrameModel(tape).works.length - 1;
      const images: LinearImage[] = [];
      for (let layer = 0; layer < layers; layer++)
        images.push(await readLayer(session, id, last, layer));
      return images;
    } finally {
      await disposeReplay(session);
    }
  };
  const replayVolumeImages = await readAll(volumeTape, volumeTexture, VOLUME_SLICES);
  const replayArrayImages = await readAll(arrayTape, arrayTexture, ARRAY_LAYERS);
  // Falsifier: retarget the slice-2 pass at slice 1. Right after that work,
  // slice 1 must hold slice 2's clear color instead of its own.
  const moved = volumeWrites.find((write) => write.layer === 2);
  if (moved === undefined) throw new Error('missing slice-2 write');
  const unmutated = await open(volumeTape);
  const unmutatedCorner = pixel(
    await readLayer(unmutated, volumeTexture, moved.workIndex, 1),
    2,
    2,
  );
  await disposeReplay(unmutated);
  const mutatedBytes = encodeTape({
    ...volumeTape,
    events: volumeTape.events.map((event, index) => {
      if (index !== moved.beginEventIndex || event.kind !== 'beginRenderPass') return event;
      const desc = event.desc as { colorAttachments: readonly Record<string, unknown>[] };
      return {
        ...event,
        desc: {
          ...desc,
          colorAttachments: desc.colorAttachments.map((attachment, slot) =>
            slot === 0 ? { ...attachment, depthSlice: 1 } : attachment,
          ),
        },
      } as typeof event;
    }),
  }).unwrap();
  const mutated = await open(decodeTape(mutatedBytes).unwrap());
  const mutatedCorner = pixel(await readLayer(mutated, volumeTexture, moved.workIndex, 1), 2, 2);
  await disposeReplay(mutated);
  return {
    volumeDigest: live.volumeTape.digest,
    arrayDigest: live.arrayTape.digest,
    volumeWrites: volumeWrites.map((write) => ({
      workIndex: write.workIndex,
      depthSlice: write.layer,
    })),
    arrayWrites: arrayWrites.map((write) => ({ workIndex: write.workIndex, layer: write.layer })),
    replayLayers: {
      volume: replayVolumeImages.map(layerContent),
      array: replayArrayImages.map(layerContent),
    },
    replayVolumeImages,
    replayArrayImages,
    maxLiveReplayDelta: Math.max(
      maxDelta(replayVolumeImages, live.volumeLayers),
      maxDelta(replayArrayImages, live.arrayLayers),
    ),
    falsifier: {
      mutatedWork: moved.workIndex,
      fromSlice: 2,
      toSlice: 1,
      unmutatedCorner,
      mutatedCorner,
    },
  };
}

export function assertReplayEvidence(replay: ReplayEvidence): void {
  replay.replayLayers.volume.forEach((content, slice) => {
    expect(contentMatches(content, expectedVolume(slice)), `replay slice ${slice}`).toBe(true);
  });
  replay.replayLayers.array.forEach((content, layer) => {
    expect(contentMatches(content, expectedArray(layer)), `replay layer ${layer}`).toBe(true);
  });
  expect(replay.maxLiveReplayDelta).toBeLessThanOrEqual(2 / 255);
  expect(matches(replay.falsifier.unmutatedCorner, VOLUME_COLORS[1] ?? [0, 0, 0])).toBe(true);
  expect(matches(replay.falsifier.mutatedCorner, VOLUME_COLORS[2] ?? [0, 0, 0])).toBe(true);
}

/** Linear -> sRGB 8-bit RGBA for review PNGs. */
export function toSrgbBytes(image: LinearImage): Uint8Array {
  const out = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, Math.max(0, image.rgba[i * 4 + c] ?? 0));
      const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
      out[i * 4 + c] = Math.round(s * 255);
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** 128x128 contact sheet: volume slices on row 0, array layers on row 1. */
export function layerSheet(
  volume: readonly LinearImage[],
  array: readonly LinearImage[],
): LinearImage {
  const size = LAYERED_CANVAS_SIZE;
  const rgba = new Float32Array(size * size * 4);
  const blit = (image: LinearImage, column: number, row: number) => {
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++)
        for (let c = 0; c < 4; c++)
          rgba[
            ((row * LAYERED_TARGET_SIZE + y) * size + column * LAYERED_TARGET_SIZE + x) * 4 + c
          ] = image.rgba[(y * image.width + x) * 4 + c] ?? 0;
  };
  for (const [index, image] of volume.entries()) blit(image, index, 0);
  for (const [index, image] of array.entries()) blit(image, index, 1);
  return { width: size, height: size, rgba };
}

export type LayeredCostShape = '2d' | '3d' | '2d-array';

export interface LayeredCost {
  readonly shape: LayeredCostShape;
  readonly frames: number;
  readonly cpuDrawMilliseconds: readonly number[];
  readonly gpuFrameNanoseconds: readonly number[];
  readonly timingStatus: string;
}

/**
 * One marker writer into a 2D target, into slice 2 of a 3D target, or into
 * layer 2 of an array target, plus a display camera. The per-frame CPU draw()
 * time and GPU pass total isolate what a layered attachment costs over the
 * equivalent 2D capture.
 */
export async function measureLayeredCost(
  renderer: Renderer,
  shape: LayeredCostShape,
  frames = 40,
): Promise<LayeredCost> {
  const world = new World();
  spawnMarker(world);
  const layers = shape === '2d' ? 1 : VOLUME_SLICES;
  const target = unwrap(renderer.createRenderTarget(descriptor(shape, layers, false)));
  spawnWriter(world, target, shape === '2d' ? 0 : 2, VOLUME_COLORS[2] ?? [0, 0, 0], 'marker');
  world
    .spawn(
      { component: Transform, data: { pos: [...DISPLAY_EYE] } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 40 }),
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  const lease = unwrap(renderer.attach(world));
  const cpu: number[] = [];
  const gpu: number[] = [];
  let timingStatus = 'unrequested';
  try {
    for (let index = 0; index < frames + 8; index++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const start = performance.now();
      const frame = unwrap(
        renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
      );
      const cpuMs = performance.now() - start;
      unwrap(await frame.completed);
      const timings = unwrap(await renderer.observe(frame, { include: ['timings'] })).timings;
      timingStatus = timings?.status ?? 'missing';
      if (index < 8) continue;
      cpu.push(cpuMs);
      if (timings === undefined || (timings.status !== 'complete' && timings.status !== 'partial'))
        continue;
      let total = 0;
      for (const pass of timings.frame.passes)
        if (pass.status === 'measured') total += pass.durationNanoseconds;
      gpu.push(total);
    }
  } finally {
    lease.dispose();
    unwrap(renderer.destroyRenderTarget(target));
  }
  return { shape, frames, cpuDrawMilliseconds: cpu, gpuFrameNanoseconds: gpu, timingStatus };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? Number.NaN : (sorted[Math.floor(sorted.length / 2)] ?? Number.NaN);
}
