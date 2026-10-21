import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  Fog,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  type RenderResult,
} from '@forgeax/engine-render';
import type { EncodedTape, RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { testAssets } from './helpers/runtime-assets';

export const TRANSLUCENT_FOG_SIZE = 64;
export const TRANSLUCENT_FOG_DENSITY = 0.05;
export const TRANSLUCENT_FOG_PANE_DISTANCE = 2;
export const TRANSLUCENT_FOG_WALL_DISTANCE = 40;
export const TRANSLUCENT_FOG_COLOR = [1, 1, 1] as const;
const PANE_COLOR = [1, 0, 0] as const;
const PANE_ALPHA = 0.5;
export const TRANSLUCENT_FOG_WALL_COLOR = [0, 0, 0.25] as const;
const TOLERANCE = 0.03;

export type TranslucentFogPath = 'forward' | 'deferred';

export interface LinearImage {
  readonly bytes: Uint8Array;
  readonly metadata: { readonly bytesPerRow: number; readonly format: string };
}

function unwrap<T>(result: RenderResult<T, unknown> | undefined): T {
  if (result === undefined) throw new Error('required Renderer operation is unavailable');
  if (!result.ok) throw result.error;
  return result.value;
}

export function halfToFloat(bits: number): number {
  const exponent = (bits >>> 10) & 31;
  const fraction = bits & 1023;
  const sign = bits & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -24 * fraction;
  if (exponent === 31) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export function readRgba(image: LinearImage, x: number, y: number): [number, number, number] {
  const data = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
  const offset = y * image.metadata.bytesPerRow;
  if (image.metadata.format === 'rgba16float') {
    const base = offset + x * 8;
    return [0, 2, 4].map((lane) => halfToFloat(data.getUint16(base + lane, true))) as [
      number,
      number,
      number,
    ];
  }
  const base = offset + x * 4;
  return [0, 1, 2].map((lane) => data.getUint8(base + lane) / 255) as [number, number, number];
}

/** Camera-ray length to a plane `planeDistance` ahead, through the pixel center. */
export function rayDistance(planeDistance: number, x: number, y: number): number {
  const tanHalf = Math.tan(Math.PI / 8);
  const ndcX = (((x + 0.5) / TRANSLUCENT_FOG_SIZE) * 2 - 1) * tanHalf;
  const ndcY = (((y + 0.5) / TRANSLUCENT_FOG_SIZE) * 2 - 1) * tanHalf;
  return planeDistance * Math.hypot(ndcX, ndcY, 1);
}

export const PANE_PIXEL = [TRANSLUCENT_FOG_SIZE / 2, TRANSLUCENT_FOG_SIZE / 2] as const;
export const WALL_PIXEL = [2, 2] as const;

/** Analytic exponential-fog opacity for a camera ray with zero height falloff. */
export function uniformFogOpacity(distance: number): number {
  return 1 - Math.exp(-TRANSLUCENT_FOG_DENSITY * distance);
}

function mix3(a: readonly number[], b: readonly number[], t: number): [number, number, number] {
  return [0, 1, 2].map((i) => (a[i] ?? 0) * (1 - t) + (b[i] ?? 0) * t) as [number, number, number];
}

/**
 * The depth-correct oracle: the far wall is fogged at its own distance, the
 * pane is fogged at the pane distance, then the pane blends over the wall.
 */
export function expectedPanePixel(): [number, number, number] {
  const [x, y] = PANE_PIXEL;
  const wall = mix3(
    TRANSLUCENT_FOG_WALL_COLOR,
    TRANSLUCENT_FOG_COLOR,
    uniformFogOpacity(rayDistance(TRANSLUCENT_FOG_WALL_DISTANCE, x, y)),
  );
  const pane = mix3(
    PANE_COLOR,
    TRANSLUCENT_FOG_COLOR,
    uniformFogOpacity(rayDistance(TRANSLUCENT_FOG_PANE_DISTANCE, x, y)),
  );
  return mix3(wall, pane, PANE_ALPHA);
}

/** The pre-fix post-pass result: the blended pane inherits the wall's fog. */
export function wallDepthFoggedPanePixel(): [number, number, number] {
  const [x, y] = PANE_PIXEL;
  const unfogged = mix3(TRANSLUCENT_FOG_WALL_COLOR, PANE_COLOR, PANE_ALPHA);
  return mix3(
    unfogged,
    TRANSLUCENT_FOG_COLOR,
    uniformFogOpacity(rayDistance(TRANSLUCENT_FOG_WALL_DISTANCE, x, y)),
  );
}

export function expectedWallPixel(): [number, number, number] {
  const [x, y] = WALL_PIXEL;
  return mix3(
    TRANSLUCENT_FOG_WALL_COLOR,
    TRANSLUCENT_FOG_COLOR,
    uniformFogOpacity(rayDistance(TRANSLUCENT_FOG_WALL_DISTANCE, x, y)),
  );
}

/** The far wall, the camera, and (unless disabled) the uniform Fog. */
export function spawnFogBackdrop(world: World, fog = true): void {
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -TRANSLUCENT_FOG_WALL_DISTANCE - 0.5] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: testAssets(world)
            .create(createBoxGeometry(200, 200, 1).unwrap())
            .unwrap(),
        },
      },
      {
        component: MeshRenderer,
        data: {
          materials: [
            testAssets(world)
              .create(Materials.unlit([...TRANSLUCENT_FOG_WALL_COLOR, 1]))
              .unwrap(),
          ],
        },
      },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 100,
          tonemap: 0,
          antialias: 0,
          bloom: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  if (fog) spawnUniformFog(world);
}

/** Uniform exponential fog with zero height falloff (see `uniformFogOpacity`). */
export function spawnUniformFog(world: World) {
  return world
    .spawn({
      component: Fog,
      data: {
        color: [...TRANSLUCENT_FOG_COLOR],
        density: TRANSLUCENT_FOG_DENSITY,
        heightFalloff: 0,
        maxOpacity: 1,
      },
    })
    .unwrap();
}

function spawnPane(world: World, paneMaterial: 'unlit' | 'standard'): void {
  const blend: GPUBlendState = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  const pane =
    paneMaterial === 'unlit'
      ? Materials.unlit([...PANE_COLOR, PANE_ALPHA], {
          renderState: { depthWriteEnabled: false, blend },
        })
      : Materials.standard({
          baseColor: [0, 0, 0, PANE_ALPHA],
          emissive: [...PANE_COLOR],
          emissiveIntensity: 1,
          metallic: 0,
          roughness: 1,
          renderState: { depthWriteEnabled: false, blend },
        });
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -TRANSLUCENT_FOG_PANE_DISTANCE - 0.005] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: testAssets(world)
            .create(createBoxGeometry(1, 1, 0.01).unwrap())
            .unwrap(),
        },
      },
      {
        component: MeshRenderer,
        data: { materials: [testAssets(world).create(pane).unwrap()] },
      },
    )
    .unwrap();
}

/**
 * Draw `frames` frames of a built World and read the last frame's linear
 * image, optionally capturing that frame as an RHI Debug tape.
 */
export async function renderFogFrames(
  renderer: Renderer,
  world: World,
  options: {
    readonly path: TranslucentFogPath;
    readonly frames?: number;
    readonly domain?: 'linear-ldr' | 'linear-hdr';
    readonly recorder?: RecorderAttachment;
    readonly capture?: (tape: EncodedTape) => void | Promise<void>;
  },
): Promise<LinearImage> {
  const frames = options.frames ?? 6;
  const domain = options.domain ?? 'linear-ldr';
  const lease = unwrap(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const original = renderer.inspect().profile;
  unwrap(renderer.setProfile({ ...original, renderPath: options.path, ssao: false }));
  try {
    let image: LinearImage | undefined;
    for (let index = 0; index < frames; index++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const last = index === frames - 1;
      if (last) unwrap(renderer.requestObservation?.([domain]));
      const pending = last ? options.recorder?.captureFrame() : undefined;
      if (pending !== undefined) (await options.recorder?.frameBoundary())?.unwrap();
      const frame = unwrap(
        renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
      );
      unwrap(await frame.completed);
      if (pending !== undefined) {
        (await options.recorder?.frameBoundary())?.unwrap();
        await options.capture?.((await pending).unwrap());
      }
      if (!last) continue;
      const observation = unwrap(
        await renderer.observe(frame, { include: [domain] }),
      ).observations?.find((value) => value.domain === domain);
      if (observation === undefined) throw new Error('missing translucent-fog readback');
      image = observation;
    }
    expect(errors, JSON.stringify(errors)).toEqual([]);
    if (image === undefined) throw new Error('no translucent-fog sample');
    return image;
  } finally {
    unsubscribe();
    lease.dispose();
    unwrap(renderer.setProfile(original));
  }
}

export interface TranslucentFogSample {
  readonly path: TranslucentFogPath;
  readonly material: 'unlit' | 'standard';
  readonly pane: readonly [number, number, number];
  readonly wall: readonly [number, number, number];
  readonly image: LinearImage;
}

/** Render the fogged pane scene and read the post-fog linear image. */
export async function sampleTranslucentFog(
  renderer: Renderer,
  options: {
    readonly path: TranslucentFogPath;
    readonly material?: 'unlit' | 'standard';
    readonly recorder?: RecorderAttachment;
    readonly capture?: (tape: EncodedTape) => void | Promise<void>;
  },
): Promise<TranslucentFogSample> {
  const material = options.material ?? 'unlit';
  const world = new World();
  spawnFogBackdrop(world);
  spawnPane(world, material);
  const image = await renderFogFrames(renderer, world, options);
  return {
    path: options.path,
    material,
    pane: readRgba(image, PANE_PIXEL[0], PANE_PIXEL[1]),
    wall: readRgba(image, WALL_PIXEL[0], WALL_PIXEL[1]),
    image,
  };
}

export function assertTranslucentFog(sample: TranslucentFogSample): void {
  const summary = JSON.stringify({
    path: sample.path,
    material: sample.material,
    pane: sample.pane,
    wall: sample.wall,
    expectedPane: expectedPanePixel(),
    wallDepthFoggedPane: wallDepthFoggedPanePixel(),
    expectedWall: expectedWallPixel(),
  });
  const expectedWall = expectedWallPixel();
  const expectedPane = expectedPanePixel();
  for (let channel = 0; channel < 3; channel++) {
    expect(
      Math.abs((sample.wall[channel] ?? 0) - (expectedWall[channel] ?? 0)),
      summary,
    ).toBeLessThan(TOLERANCE);
    expect(
      Math.abs((sample.pane[channel] ?? 0) - (expectedPane[channel] ?? 0)),
      summary,
    ).toBeLessThan(TOLERANCE);
  }
}
