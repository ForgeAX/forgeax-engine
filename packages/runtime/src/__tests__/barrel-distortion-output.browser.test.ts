import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import {
  ANTIALIAS_FXAA,
  ANTIALIAS_NONE,
  Atmosphere,
  BarrelDistortion,
  Camera,
  DepthOfField,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  TONEMAP_LINEAR,
  TONEMAP_NONE,
  VolumetricFog,
} from '@forgeax/engine-render';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { createStandaloneRuntimeAssetBinding, type TextureAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { pickDisplay } from '../../../picking/src/display-picking';
import { constructRuntimeRendererHost } from '../renderer-host';

const WIDTH = 128;
const HEIGHT = 128;

type ObservationDomain = Parameters<NonNullable<Renderer['requestObservation']>>[0][number];
type DomainObservation = NonNullable<
  Extract<Awaited<ReturnType<Renderer['observe']>>, { readonly ok: true }>['value']['observations']
>[number];
type FrameObservationValue = Extract<
  Awaited<ReturnType<Renderer['observe']>>,
  { readonly ok: true }
>['value'];

interface FxaaEdgeEvidence {
  readonly x: number;
  readonly y: number;
  readonly lumaRange: number;
  readonly threshold: number;
}

const COLOR_DOMAINS = [
  'linear-hdr',
  'linear-ldr',
  'final-display',
] as const satisfies readonly ObservationDomain[];

let canvas: HTMLCanvasElement | undefined;
let renderer: Renderer | undefined;
let releaseLease: (() => void) | undefined;
let lastScreenshotExtent = { width: 0, height: 0 };

async function runBarrelBrowserStage<T>(
  stage: string,
  operation: () => Promise<T>,
  timeoutMs = 20_000,
): Promise<T> {
  const started = performance.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // biome-ignore lint/suspicious/noConsole: stage markers make a stalled real Browser fixture diagnosable.
  console.info(`[barrel-browser] start:${stage}`);
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`barrel browser stage timed out: ${stage}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    // biome-ignore lint/suspicious/noConsole: stage markers make a stalled real Browser fixture diagnosable.
    console.info(
      `[barrel-browser] end:${stage} elapsedMs=${Math.round(performance.now() - started)}`,
    );
  }
}

function activeCanvas(): HTMLCanvasElement {
  if (canvas === undefined) throw new Error('barrel browser canvas is not initialized');
  return canvas;
}

function browserRendererError(stage: string, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : JSON.stringify(cause);
  if (cause instanceof Error) return new Error(`${stage}: ${cause.message}`, { cause });
  return new Error(`${stage}: ${message}`);
}

async function screenshotPixels(target: HTMLCanvasElement): Promise<Uint8Array> {
  await runBarrelBrowserStage('request-animation-frame', async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  const shot = await runBarrelBrowserStage('canvas-screenshot', () =>
    page.elementLocator(target).screenshot({ base64: true, save: false }),
  );
  const base64 = typeof shot === 'string' ? shot : shot.base64;
  const binary = atob(base64);
  const png = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) png[index] = binary.charCodeAt(index);
  const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  lastScreenshotExtent = { width: bitmap.width, height: bitmap.height };
  const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = surface.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    bitmap.close();
    throw new Error('barrel browser readback has no 2D context');
  }
  context.drawImage(bitmap, 0, 0);
  const pixels = new Uint8Array(context.getImageData(0, 0, surface.width, surface.height).data);
  bitmap.close();
  return pixels;
}

function createChannelSwapLut(): TextureAsset {
  const values = new Uint16Array(2 * 2 * 2 * 4);
  for (let index = 0; index < 8; index += 1) {
    values.set(
      [index & 4 ? 0x3c00 : 0, index & 2 ? 0x3c00 : 0, index & 1 ? 0x3c00 : 0, 0x3c00],
      index * 4,
    );
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
    format: 'rgba16float',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(values.buffer),
  };
}

function createConstantVolumeDensity(): TextureAsset {
  const size = 8;
  return {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: size, height: size, depth: size } },
    format: 'r8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(size * size * size).fill(96),
  };
}

function halfToFloat(value: number): number {
  const sign = (value & 0x8000) === 0 ? 1 : -1;
  const exponent = (value >>> 10) & 0x1f;
  const fraction = value & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function observationPixel(
  observation: DomainObservation,
  x: number,
  y: number,
): readonly [number, number, number, number] {
  const { format, width, height, bytesPerRow } = observation.metadata;
  if (x < 0 || x >= width || y < 0 || y >= height) {
    throw new Error(`observation pixel ${x},${y} is outside ${width}x${height}`);
  }
  const halfFloat = format === 'rgba16float';
  const bytesPerPixel = halfFloat ? 8 : 4;
  const offset = y * bytesPerRow + x * bytesPerPixel;
  const view = new DataView(
    observation.bytes.buffer,
    observation.bytes.byteOffset,
    observation.bytes.byteLength,
  );
  if (halfFloat) {
    return [
      halfToFloat(view.getUint16(offset, true)),
      halfToFloat(view.getUint16(offset + 2, true)),
      halfToFloat(view.getUint16(offset + 4, true)),
      halfToFloat(view.getUint16(offset + 6, true)),
    ];
  }
  const blueFirst = format.startsWith('bgra');
  const red = view.getUint8(offset + (blueFirst ? 2 : 0));
  const green = view.getUint8(offset + 1);
  const blue = view.getUint8(offset + (blueFirst ? 0 : 2));
  return [red / 255, green / 255, blue / 255, view.getUint8(offset + 3) / 255];
}

function observationByDomain(
  result: FrameObservationValue,
  domain: ObservationDomain,
): DomainObservation {
  const observation = result.observations?.find((item) => item.domain === domain);
  if (observation === undefined) throw new Error(`missing ${domain} frame observation`);
  return observation;
}

function maxObservationRgbDelta(left: DomainObservation, right: DomainObservation): number {
  if (
    left.metadata.width !== right.metadata.width ||
    left.metadata.height !== right.metadata.height
  ) {
    throw new Error('observation extents differ');
  }
  let maximum = 0;
  for (let y = 0; y < left.metadata.height; y += 1) {
    for (let x = 0; x < left.metadata.width; x += 1) {
      const leftPixel = observationPixel(left, x, y);
      const rightPixel = observationPixel(right, x, y);
      maximum = Math.max(
        maximum,
        Math.abs(leftPixel[0] - rightPixel[0]),
        Math.abs(leftPixel[1] - rightPixel[1]),
        Math.abs(leftPixel[2] - rightPixel[2]),
      );
    }
  }
  return maximum;
}

function fxaaEdgeAt(
  observation: DomainObservation,
  x: number,
  y: number,
): FxaaEdgeEvidence | undefined {
  if (
    x <= 0 ||
    y <= 0 ||
    x >= observation.metadata.width - 1 ||
    y >= observation.metadata.height - 1
  ) {
    return undefined;
  }
  const pixels = [
    observationPixel(observation, x, y),
    observationPixel(observation, x, y + 1),
    observationPixel(observation, x, y - 1),
    observationPixel(observation, x - 1, y),
    observationPixel(observation, x + 1, y),
  ];
  const lumas = pixels.map(([red, green, blue]) =>
    Math.sqrt(Math.max(0, 0.299 * red + 0.587 * green + 0.114 * blue)),
  );
  const lumaMin = Math.min(...lumas);
  const lumaMax = Math.max(...lumas);
  const lumaRange = lumaMax - lumaMin;
  const threshold = Math.max(0.0312, lumaMax * 0.125);
  return lumaRange >= threshold ? { x, y, lumaRange, threshold } : undefined;
}

function findFxaaEdges(observation: DomainObservation): readonly FxaaEdgeEvidence[] {
  const edges: FxaaEdgeEvidence[] = [];
  for (let y = 1; y < observation.metadata.height - 1; y += 1) {
    for (let x = 1; x < observation.metadata.width - 1; x += 1) {
      const center = observationPixel(observation, x, y);
      if (Math.abs(center[3] - 0.5) > 0.02) continue;
      const edge = fxaaEdgeAt(observation, x, y);
      if (edge !== undefined) edges.push(edge);
    }
  }
  return edges;
}

function spawnScene(
  world: World,
  options: {
    readonly clearColor: readonly [number, number, number, number];
    readonly geometry: boolean;
    readonly geometryColor?: readonly [number, number, number, number];
    readonly edgeRods?: boolean;
    readonly edgeAlpha?: number;
    readonly highContrastEdge?: boolean;
    readonly antialias?: number;
    readonly tonemap?: number;
    readonly barrel?: {
      readonly strength: number;
      readonly centerX: number;
      readonly centerY: number;
    };
  },
) {
  const geometryMaterial =
    options.geometryColor === undefined
      ? undefined
      : world.allocSharedRef('MaterialAsset', Materials.unlit(options.geometryColor));
  if (options.geometry) {
    for (const position of [-1.15, 0, 1.15]) {
      world.spawn(
        { component: Transform, data: { pos: [position, 0, 0], scale: [0.7, 1.6, 0.35] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        {
          component: MeshRenderer,
          data: geometryMaterial === undefined ? {} : { materials: [geometryMaterial] },
        },
      );
    }
  }
  if (options.edgeRods === true) {
    for (const [x, y, color] of [
      [-2.2, 0.8, [0.95, 0.1, 0.1]],
      [2.2, 0.8, [0.1, 0.2, 0.95]],
      [0, 2.2, [0.1, 0.95, 0.2]],
      [0, -1.6, [0.95, 0.8, 0.1]],
    ] as const) {
      const material = world.allocSharedRef(
        'MaterialAsset',
        Materials.unlit([...color, options.edgeAlpha ?? 1]),
      );
      world.spawn(
        {
          component: Transform,
          data: { pos: [x, y, -0.4], scale: [0.08, 0.9, 0.08] },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [material] } },
      );
    }
  }
  if (options.highContrastEdge === true) {
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.unlit([1, 1, 1, options.edgeAlpha ?? 0.5]),
    );
    world.spawn(
      {
        component: Transform,
        data: { pos: [0, 0, 0], scale: [0.12, 2.6, 0.35] },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    );
  }
  const transform = {
    component: Transform,
    data: { pos: [0, 0, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
  } as const;
  const camera = {
    component: Camera,
    data: {
      fov: Math.PI / 3,
      aspect: WIDTH / HEIGHT,
      near: 0.1,
      far: 100,
      antialias: options.antialias ?? ANTIALIAS_NONE,
      tonemap: options.tonemap ?? TONEMAP_NONE,
      clearColor: options.clearColor,
    },
  } as const;
  return options.barrel === undefined
    ? world.spawn(transform, camera).unwrap()
    : world
        .spawn(transform, camera, { component: BarrelDistortion, data: options.barrel })
        .unwrap();
}

async function drawFrame(world: World) {
  if (renderer === undefined) throw new Error('barrel browser renderer is not initialized');
  releaseLease?.();
  releaseLease = undefined;
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  releaseLease = () => attached.value.dispose();
  const updated = world.update(1 / 60);
  if (!updated.ok) throw updated.error;
  const drawn = renderer.draw({
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  });
  if (!drawn.ok) throw drawn.error;
  const completed = await drawn.value.completed;
  if (!completed.ok) throw completed.error;
  return drawn.value;
}

// Reusing a renderer can retain its accepted graph while a new fullscreen
// pipeline compiles. Wait for the submitted mapping, never screenshot that LKG.
async function drawSettledBarrelFrame(world: World, strength: number) {
  let receipt: Awaited<ReturnType<typeof drawFrame>> | undefined;
  await expect
    .poll(
      async () => {
        receipt = await drawFrame(world);
        return {
          strength: receipt.barrelDistortion?.strength,
          lastKnownGood: renderer?.inspect().barrelDistortion.lastKnownGood,
        };
      },
      { timeout: 5_000 },
    )
    .toEqual({ strength: expect.closeTo(strength, 6), lastKnownGood: false });
  if (receipt === undefined) throw new Error('barrel mapping did not submit');
  return receipt;
}

async function drawObservedFrame(
  world: World,
  domains: readonly ObservationDomain[],
): Promise<{
  readonly receipt: Awaited<ReturnType<typeof drawFrame>>;
  readonly observation: Extract<
    Awaited<ReturnType<Renderer['observe']>>,
    { readonly ok: true }
  >['value'];
}> {
  if (renderer === undefined) throw new Error('barrel browser renderer is not initialized');
  let armed: ReturnType<NonNullable<Renderer['requestObservation']>> | undefined;
  try {
    armed = renderer.requestObservation?.(domains);
  } catch (cause) {
    throw browserRendererError('request-observation-throw', cause);
  }
  if (armed === undefined) {
    throw browserRendererError('request-observation', 'renderer has no observation owner');
  }
  if (!armed.ok) throw browserRendererError('request-observation', armed.error);
  let receipt: Awaited<ReturnType<typeof drawFrame>>;
  try {
    receipt = await drawFrame(world);
  } catch (cause) {
    throw browserRendererError('draw-observed-frame', cause);
  }
  let observed: Awaited<ReturnType<Renderer['observe']>>;
  try {
    observed = await renderer.observe(receipt, { include: domains });
  } catch (cause) {
    throw browserRendererError('observe-frame-throw', cause);
  }
  if (!observed.ok) throw browserRendererError('observe-frame', observed.error);
  return { receipt, observation: observed.value };
}

function rgbDifference(left: Uint8Array, right: Uint8Array): number {
  let changed = 0;
  for (let index = 0; index + 2 < Math.min(left.length, right.length); index += 4) {
    if (
      left[index] !== right[index] ||
      left[index + 1] !== right[index + 1] ||
      left[index + 2] !== right[index + 2]
    ) {
      changed += 1;
    }
  }
  return changed;
}

function spawnMarkerScene(world: World) {
  const markerMaterial = world.allocSharedRef(
    'MaterialAsset',
    Materials.unlit([0.95, 0.05, 0.05, 1]),
  );
  const marker = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0], scale: [0.9, 0.9, 0.9] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [markerMaterial] } },
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4], quat: [0, 0, 0, 1] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: WIDTH / HEIGHT,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_NONE,
          tonemap: TONEMAP_NONE,
          clearColor: [0.02, 0.02, 0.02, 1],
        },
      },
      {
        component: BarrelDistortion,
        data: { strength: 0.2, centerX: 0.5, centerY: 0.5 },
      },
    )
    .unwrap();
  return { camera, marker };
}

function findGpuMarker(pixels: Uint8Array): { readonly x: number; readonly y: number } {
  const { width, height } = lastScreenshotExtent;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const red = pixels[offset] ?? 0;
      const green = pixels[offset + 1] ?? 0;
      const blue = pixels[offset + 2] ?? 0;
      if (red < 180 || green > 140 || blue > 140) continue;
      sumX += x;
      sumY += y;
      count += 1;
    }
  }
  if (count === 0) throw new Error('Browser readback did not contain the GPU marker');
  return { x: sumX / count + 0.5, y: sumY / count + 0.5 };
}

describe('barrel distortion real output in Browser WebGPU', () => {
  afterEach(async () => {
    releaseLease?.();
    releaseLease = undefined;
    await runBarrelBrowserStage(
      'teardown-renderer-dispose',
      async () => {
        await renderer?.dispose();
      },
      5_000,
    );
    canvas?.remove();
    renderer = undefined;
    canvas = undefined;
  });

  it('warps geometry while keeping the disabled baseline and white source filled', {
    timeout: 120_000,
  }, async () => {
    canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvas.style.width = `${WIDTH}px`;
    canvas.style.height = `${HEIGHT}px`;
    document.body.append(canvas);
    const host = await runBarrelBrowserStage('construct-baseline-host', () =>
      constructRuntimeRendererHost(
        activeCanvas(),
        {},
        { shaderManifestUrl: '/shaders/manifest.json' },
      ),
    );
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    renderer = host.value.renderer;

    const world = new World();
    const camera = spawnScene(world, {
      clearColor: [0.02, 0.02, 0.02, 1],
      geometry: true,
      edgeRods: true,
    });
    const baselineReceipt = await runBarrelBrowserStage('draw-baseline', () => drawFrame(world));
    expect(baselineReceipt.barrelDistortion?.strength).toBe(0);
    const baseline = await runBarrelBrowserStage('read-baseline', () =>
      screenshotPixels(activeCanvas()),
    );

    world
      .addComponent(camera, {
        component: BarrelDistortion,
        data: { strength: 0.2, centerX: 0.5, centerY: 0.5 },
      })
      .unwrap();
    const warpedReceipt = await runBarrelBrowserStage('draw-warped', () => drawFrame(world));
    expect(warpedReceipt.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
    const warped = await runBarrelBrowserStage('read-warped', () =>
      screenshotPixels(activeCanvas()),
    );
    expect(rgbDifference(baseline, warped)).toBeGreaterThan(0);

    world.removeComponent(camera, BarrelDistortion).unwrap();
    await runBarrelBrowserStage('draw-disabled', () => drawFrame(world));
    const disabled = await runBarrelBrowserStage('read-disabled', () =>
      screenshotPixels(activeCanvas()),
    );
    expect(rgbDifference(baseline, disabled)).toBe(0);

    const offCenterWorld = new World();
    const offCenterCamera = spawnScene(offCenterWorld, {
      clearColor: [0.02, 0.02, 0.02, 1],
      geometry: true,
      edgeRods: true,
    });
    await runBarrelBrowserStage('draw-off-center-baseline', () => drawFrame(offCenterWorld));
    offCenterWorld
      .addComponent(offCenterCamera, {
        component: BarrelDistortion,
        data: { strength: 0.35, centerX: 0.31, centerY: 0.67 },
      })
      .unwrap();
    const offCenterReceipt = await runBarrelBrowserStage('draw-off-center-warped', () =>
      drawSettledBarrelFrame(offCenterWorld, 0.35),
    );
    expect(
      offCenterReceipt.barrelDistortion?.strength,
      JSON.stringify(renderer.inspect().barrelDistortion),
    ).toBeCloseTo(0.35, 6);
    expect(offCenterReceipt.barrelDistortion?.centerX).toBeCloseTo(0.31, 6);
    expect(offCenterReceipt.barrelDistortion?.centerY).toBeCloseTo(0.67, 6);
    expect(offCenterReceipt.barrelDistortion).toMatchObject({
      width: WIDTH,
      height: HEIGHT,
    });
    const offCenter = await runBarrelBrowserStage('read-off-center', () =>
      screenshotPixels(activeCanvas()),
    );
    expect(rgbDifference(baseline, offCenter)).toBeGreaterThan(16);

    // Switching leases keeps the white scene free of geometry while reusing
    // the same device and shader fleet. Every compositor pixel is still read.
    const whiteWorld = new World();
    const whiteCamera = spawnScene(whiteWorld, {
      clearColor: [1, 1, 1, 1],
      geometry: false,
    });
    await runBarrelBrowserStage('draw-white-baseline', () => drawFrame(whiteWorld));
    whiteWorld
      .addComponent(whiteCamera, {
        component: BarrelDistortion,
        data: { strength: 0.35, centerX: 0.5, centerY: 0.5 },
      })
      .unwrap();
    const whiteReceipt = await runBarrelBrowserStage('draw-white-warped', () =>
      drawSettledBarrelFrame(whiteWorld, 0.35),
    );
    expect(whiteReceipt.barrelDistortion?.strength).toBeCloseTo(0.35, 6);
    const white = await runBarrelBrowserStage('read-white-warped', () =>
      screenshotPixels(activeCanvas()),
    );
    let dimPixels = 0;
    for (let index = 0; index + 2 < white.length; index += 4) {
      if (
        (white[index] ?? 0) < 240 ||
        (white[index + 1] ?? 0) < 240 ||
        (white[index + 2] ?? 0) < 240
      ) {
        dimPixels += 1;
      }
    }
    expect(dimPixels).toBe(0);
  });

  it('captures HDR, LUT, barrel, FXAA, and final encoding from one Browser receipt', {
    timeout: 120_000,
  }, async () => {
    canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvas.style.width = `${WIDTH}px`;
    canvas.style.height = `${HEIGHT}px`;
    document.body.append(canvas);
    const host = await runBarrelBrowserStage('construct-observation-host', () =>
      constructRuntimeRendererHost(
        activeCanvas(),
        {},
        { shaderManifestUrl: '/shaders/manifest.json' },
      ),
    );
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    renderer = host.value.renderer;

    const lutGuid = 'dab53d78-d233-4c79-8cb3-c03f33130003';
    const lutSourceKey = 'test://barrel-distortion-output/browser-channel-swap-lut';
    const binding = createStandaloneRuntimeAssetBinding('barrel-distortion-output-browser-lut');
    const catalog = {
      schemaVersion: 'runtime-catalog-snapshot-v1',
      scopeId: binding.scopeId,
      generation: binding.generation,
      authority: 'authoritative',
      entries: [
        {
          guid: lutGuid,
          kind: 'texture',
          packageUrl: 'data:application/json,{}',
          sourceKey: lutSourceKey,
        },
      ],
    } as const;
    try {
      host.value.assets.configureRuntimeBinding({
        ...binding,
        catalogUrl: `data:application/json,${encodeURIComponent(JSON.stringify(catalog))}`,
      });
      expect(await host.value.assets.refreshCatalog()).toBe(true);
    } catch (cause) {
      throw browserRendererError('observation-assets-refresh', cause);
    }
    const lut = createChannelSwapLut();
    try {
      host.value.assets.catalog(lutGuid, lut).unwrap();
    } catch (cause) {
      throw browserRendererError('observation-assets-catalog', cause);
    }

    const world = new World();
    let camera: number;
    try {
      camera = spawnScene(world, {
        clearColor: [0, 0, 0, 1],
        geometry: true,
        // Keep a fractional source alpha through the full post chain while the
        // red channel exercises the HDR-to-LDR boundary.
        geometryColor: [1.5, 0.5, 0.25, 0.5],
        antialias: ANTIALIAS_FXAA,
        tonemap: TONEMAP_LINEAR,
        barrel: { strength: 0.2, centerX: 0.5, centerY: 0.5 },
      }) as number;
    } catch (cause) {
      throw browserRendererError('observation-spawn-scene', cause);
    }
    let lutHandle: ReturnType<World['allocSharedRef']>;
    try {
      lutHandle = world.allocSharedRef('TextureAsset', lut);
    } catch (cause) {
      throw browserRendererError('observation-world-lut-handle', cause);
    }
    try {
      world
        .set(camera, Camera, {
          colorLut: lutHandle,
          colorLutStrength: 1,
        })
        .unwrap();
    } catch (cause) {
      throw browserRendererError('observation-world-camera', cause);
    }

    const enabled = await drawObservedFrame(world, COLOR_DOMAINS);
    const enabledObservations = COLOR_DOMAINS.map((domain) =>
      observationByDomain(enabled.observation, domain),
    );
    for (const observation of enabledObservations) {
      expect(observation.metadata.frameId).toBe(enabled.receipt.frameId);
      expect(observation.metadata.deviceGeneration).toBe(enabled.receipt.deviceGeneration);
      expect(observation.metadata.graphGeneration).toBe(enabled.receipt.graphGeneration);
      expect(observation.metadata.width).toBe(WIDTH);
      expect(observation.metadata.height).toBe(HEIGHT);
      expect(observation.bytes.byteLength).toBeGreaterThanOrEqual(
        observation.metadata.bytesPerRow * HEIGHT,
      );
    }
    const enabledHdr = observationByDomain(enabled.observation, 'linear-hdr');
    const enabledLdr = observationByDomain(enabled.observation, 'linear-ldr');
    const enabledFinal = observationByDomain(enabled.observation, 'final-display');
    expect(enabledHdr.metadata.format).toBe('rgba16float');
    expect(enabledLdr.metadata.format).toBe('rgba16float');
    expect(['rgba8unorm', 'bgra8unorm']).toContain(enabledFinal.metadata.format);
    const hdrCenter = observationPixel(enabledHdr, WIDTH >> 1, HEIGHT >> 1);
    const ldrCenter = observationPixel(enabledLdr, WIDTH >> 1, HEIGHT >> 1);
    expect(hdrCenter[0]).toBeGreaterThan(1.1);
    expect(hdrCenter[1]).toBeGreaterThan(0.3);
    expect(hdrCenter[2]).toBeGreaterThan(0.1);
    expect(hdrCenter[3]).toBeCloseTo(0.5, 2);
    // The channel-swap LUT is deliberately enabled for this frame, so the
    // linear-LDR sample is [0, 0.5, 1] rather than the pre-LUT HDR ordering.
    expect(ldrCenter[0]).toBeLessThan(0.05);
    expect(ldrCenter[1]).toBeGreaterThan(0.45);
    expect(ldrCenter[1]).toBeLessThan(0.55);
    expect(ldrCenter[2]).toBeGreaterThan(0.95);
    const finalCenter = observationPixel(enabledFinal, WIDTH >> 1, HEIGHT >> 1);
    const finalCenterAlphaByte = Math.round(finalCenter[3] * 255);
    expect(finalCenterAlphaByte).toBeGreaterThanOrEqual(126);
    expect(finalCenterAlphaByte).toBeLessThanOrEqual(130);
    expect(Math.abs(finalCenterAlphaByte - Math.round(hdrCenter[3] * 255))).toBeLessThanOrEqual(2);

    const enabledInspection = renderer?.inspect();
    if (enabledInspection === undefined) throw new Error('observation renderer inspection missing');
    const enabledPasses = enabledInspection.output.graphPassNames;
    const lutIndex = enabledPasses.indexOf('standard-color-lut');
    const barrelIndex = enabledPasses.indexOf('barrel-distortion');
    const fxaaIndex = enabledPasses.indexOf('fxaa');
    const encodingIndices = enabledPasses.flatMap((name, index) =>
      name === 'standard-output-encoding' ? [index] : [],
    );
    expect(enabledPasses).toEqual(
      expect.arrayContaining([
        'linear-hdr-observation',
        'linear-ldr-observation',
        'final-display-observation',
        'standard-tone',
        'standard-color-lut',
        'barrel-distortion',
        'fxaa',
      ]),
    );
    expect(lutIndex).toBeGreaterThan(enabledPasses.indexOf('standard-tone'));
    expect(barrelIndex).toBeGreaterThan(lutIndex);
    expect(fxaaIndex).toBeGreaterThan(barrelIndex);
    expect(encodingIndices).toHaveLength(1);
    expect(encodingIndices[0]).toBeGreaterThan(fxaaIndex);
    expect(enabledInspection.output.displayEncoded).toBe(true);
    expect(enabledInspection.output.standardLut?.sourceKey).toBe(lutSourceKey);

    world.set(camera, Camera, { colorLut: 0 as never, colorLutStrength: 0 }).unwrap();
    const disabled = await drawObservedFrame(world, COLOR_DOMAINS);
    const disabledFinal = observationByDomain(disabled.observation, 'final-display');
    const disabledInspection = renderer.inspect();
    expect(disabledInspection.output.graphPassNames).not.toContain('standard-color-lut');
    expect(
      disabledInspection.output.graphPassNames.filter(
        (name) => name === 'standard-output-encoding',
      ),
    ).toHaveLength(1);
    expect(maxObservationRgbDelta(enabledFinal, disabledFinal)).toBeGreaterThan(0.01);
  });

  it('proves FXAA enters its edge branch against a half-alpha source', {
    timeout: 120_000,
  }, async () => {
    canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvas.style.width = `${WIDTH}px`;
    canvas.style.height = `${HEIGHT}px`;
    document.body.append(canvas);
    const host = await runBarrelBrowserStage('construct-fxaa-edge-host', () =>
      constructRuntimeRendererHost(
        activeCanvas(),
        {},
        { shaderManifestUrl: '/shaders/manifest.json' },
      ),
    );
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    renderer = host.value.renderer;

    const noFxaaWorld = new World();
    spawnScene(noFxaaWorld, {
      // Keep both sides of the high-contrast edge at the authored alpha so
      // FXAA can move RGB across the edge without fabricating alpha.
      clearColor: [0, 0, 0, 0.5],
      geometry: false,
      highContrastEdge: true,
      antialias: ANTIALIAS_NONE,
      tonemap: TONEMAP_LINEAR,
    });
    const noFxaa = await drawObservedFrame(noFxaaWorld, COLOR_DOMAINS);
    const noFxaaHdr = observationByDomain(noFxaa.observation, 'linear-hdr');
    const noFxaaLdr = observationByDomain(noFxaa.observation, 'linear-ldr');
    const noFxaaFinal = observationByDomain(noFxaa.observation, 'final-display');

    const fxaaWorld = new World();
    spawnScene(fxaaWorld, {
      clearColor: [0, 0, 0, 0.5],
      geometry: false,
      highContrastEdge: true,
      antialias: ANTIALIAS_FXAA,
      tonemap: TONEMAP_LINEAR,
    });
    const fxaa = await drawObservedFrame(fxaaWorld, COLOR_DOMAINS);
    const fxaaHdr = observationByDomain(fxaa.observation, 'linear-hdr');
    const fxaaFinal = observationByDomain(fxaa.observation, 'final-display');
    const fxaaInspection = renderer.inspect();
    const passes = fxaaInspection.output.graphPassNames;
    // Observation adds a tone-only readback; the ordinary FXAA route still
    // samples the single output transform's display-encoded intermediate.
    expect(passes.filter((name) => name === 'output-transform')).toHaveLength(1);
    expect(passes.indexOf('fxaa')).toBeGreaterThan(passes.indexOf('output-transform'));
    expect(passes).not.toContain('standard-output-encoding');
    expect(fxaaInspection.output.displayEncoded).toBe(true);
    expect(fxaaInspection.output.standardOutputColor?.domain).toBe('display-encoded');

    // The linear-HDR observations are the shared pre-post-process source. The
    // two worlds therefore give a receipt-bound identity pair before FXAA;
    // linear-LDR is the post-tone source used for the edge predicate below.
    expect(maxObservationRgbDelta(noFxaaHdr, fxaaHdr)).toBeLessThan(0.001);
    const edges = findFxaaEdges(noFxaaLdr);
    // biome-ignore lint/suspicious/noConsole: retain the measured edge predicate in Browser evidence.
    console.info('[barrel-browser:fxaa-edge]', JSON.stringify({ edgeCount: edges.length }));
    expect(edges.length).toBeGreaterThan(0);

    let matched:
      | {
          readonly edge: FxaaEdgeEvidence;
          readonly source: readonly [number, number, number, number];
          readonly fxaa: readonly [number, number, number, number];
          readonly rgbDelta: number;
        }
      | undefined;
    for (const edge of edges) {
      const hdrSource = observationPixel(noFxaaHdr, edge.x, edge.y);
      const noFxaaPixel = observationPixel(noFxaaFinal, edge.x, edge.y);
      const fxaaPixel = observationPixel(fxaaFinal, edge.x, edge.y);
      const rgbDelta = Math.max(
        Math.abs(noFxaaPixel[0] - fxaaPixel[0]),
        Math.abs(noFxaaPixel[1] - fxaaPixel[1]),
        Math.abs(noFxaaPixel[2] - fxaaPixel[2]),
      );
      if (
        Math.abs(hdrSource[3] - 0.5) <= 0.02 &&
        Math.abs(noFxaaPixel[3] - 0.5) <= 0.02 &&
        rgbDelta > 0.01
      ) {
        matched = { edge, source: hdrSource, fxaa: fxaaPixel, rgbDelta };
        break;
      }
    }
    // The luma range/threshold proves the no-FXAA source pixel satisfies the
    // exact branch condition; the paired final samples prove that branch's
    // filter changed RGB while preserving source alpha.
    expect(matched).toBeDefined();
    if (matched === undefined) throw new Error('no FXAA edge retained half-alpha RGB difference');
    expect(matched.edge.lumaRange).toBeGreaterThanOrEqual(matched.edge.threshold);
    const sourceAlphaByte = Math.round(matched.source[3] * 255);
    const fxaaAlphaByte = Math.round(matched.fxaa[3] * 255);
    expect(sourceAlphaByte).toBeGreaterThanOrEqual(126);
    expect(sourceAlphaByte).toBeLessThanOrEqual(130);
    expect(fxaaAlphaByte).toBeGreaterThanOrEqual(126);
    expect(fxaaAlphaByte).toBeLessThanOrEqual(130);
    expect(Math.abs(fxaaAlphaByte - sourceAlphaByte)).toBeLessThanOrEqual(2);
    expect(matched.rgbDelta).toBeGreaterThan(0.01);
    // biome-ignore lint/suspicious/noConsole: retain the selected edge receipt evidence.
    console.info(
      '[barrel-browser:fxaa-edge-match]',
      JSON.stringify({
        x: matched.edge.x,
        y: matched.edge.y,
        lumaRange: matched.edge.lumaRange,
        threshold: matched.edge.threshold,
        sourceAlphaByte,
        fxaaAlphaByte,
        rgbDelta: matched.rgbDelta,
      }),
    );
  });

  it('composes active Barrel with VolumetricFog through a real browser readback', {
    timeout: 120_000,
  }, async () => {
    canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvas.style.width = `${WIDTH}px`;
    canvas.style.height = `${HEIGHT}px`;
    document.body.append(canvas);
    const host = await runBarrelBrowserStage('construct-volume-composition', () =>
      constructRuntimeRendererHost(
        activeCanvas(),
        {},
        { shaderManifestUrl: '/shaders/manifest.json' },
      ),
    );
    if (!host.ok) throw host.error;
    renderer = host.value.renderer;
    const world = new World();
    const camera = spawnScene(world, {
      clearColor: [0.015, 0.02, 0.035, 1],
      geometry: true,
      geometryColor: [0.85, 0.25, 0.08, 1],
      tonemap: TONEMAP_LINEAR,
      barrel: { strength: 0.2, centerX: 0.5, centerY: 0.5 },
    });
    world
      .addComponent(camera, {
        component: DepthOfField,
        data: { focusDistance: 4, fStop: 2.8, sensorHeight: 0.024, maxRadiusPixels: 4 },
      })
      .unwrap();
    const light = world
      .spawn({
        component: DirectionalLight,
        data: { direction: [-0.4, -0.8, -0.3], castShadow: false },
      })
      .unwrap();
    world
      .spawn({
        component: Atmosphere,
        data: {
          sunAngularRadius: 0.004675,
        },
      })
      .unwrap();
    const density = world.allocSharedRef('TextureAsset', createConstantVolumeDensity());
    const releaseTransforms = registerPropagateTransforms(world);
    let fog: EntityHandle | undefined;
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const drawVolumeFrame = async () => {
      const updated = world.update(1 / 60);
      if (!updated.ok) throw updated.error;
      const drawn = renderer?.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      if (drawn === undefined || !drawn.ok) throw drawn?.error;
      const completed = await drawn.value.completed;
      if (!completed.ok) throw completed.error;
      return drawn.value;
    };
    try {
      const baseline = await drawVolumeFrame();
      const baselinePixels = await screenshotPixels(activeCanvas());
      fog = world
        .spawn({
          component: VolumetricFog,
          data: {
            light,
            density,
            boundsMin: [-8, -4, -2],
            boundsMax: [8, 4, 3],
            extinction: [0.8, 0.8, 0.8],
            albedo: [0.75, 0.75, 0.75],
            emission: [0, 0, 0],
            anisotropy: 0,
            maxDistance: 30,
          },
        })
        .unwrap();
      // The volume graph is accepted across a candidate frame before its
      // retained resource lease can affect the submitted picture.
      await drawVolumeFrame();
      const fogFrame = await drawVolumeFrame();
      const fogPixels = await screenshotPixels(activeCanvas());
      expect(fogFrame.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
      expect(renderer.inspect().depthOfField?.status).toBe('active');
      expect(renderer.inspect().volumetricFog?.status).toBe('available');
      const volumeInspection = renderer.inspect();
      expect(volumeInspection.perFramePassNames).toContain('volume-composite');
      expect(rgbDifference(baselinePixels, fogPixels)).toBeGreaterThan(0);
      expect(baselinePixels.length).toBe(fogPixels.length);
      expect(rgbDifference(baselinePixels, fogPixels)).toBeLessThanOrEqual(
        baselinePixels.length / 4,
      );
      // Keep both receipts alive in the assertion path so this remains a
      // submitted-picture comparison rather than a graph-only admission test.
      expect(baseline.frameId).toBeLessThan(fogFrame.frameId);
      // biome-ignore lint/suspicious/noConsole: bounded browser readback evidence is intentional.
      console.info(
        '[barrel-browser] volume-composition',
        JSON.stringify({
          baselineFrame: baseline.frameId,
          fogFrame: fogFrame.frameId,
          changedPixels: rgbDifference(baselinePixels, fogPixels),
          screenshotExtent: lastScreenshotExtent,
          depthOfField: renderer.inspect().depthOfField,
          volumetricFog: volumeInspection.volumetricFog,
          passes: volumeInspection.perFramePassNames,
        }),
      );
    } finally {
      if (fog !== undefined) world.despawn(fog).unwrap();
      world.sharedRefs.release(density).unwrap();
      attached.value.dispose();
      releaseTransforms();
    }
  });

  it('uses a CSS-scaled GPU marker to drive public display picking', {
    timeout: 120_000,
  }, async () => {
    canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvas.style.width = `${WIDTH * 2}px`;
    canvas.style.height = `${HEIGHT * 2}px`;
    document.body.append(canvas);
    const host = await runBarrelBrowserStage('construct-picking-host', () =>
      constructRuntimeRendererHost(
        activeCanvas(),
        {},
        { shaderManifestUrl: '/shaders/manifest.json' },
      ),
    );
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    renderer = host.value.renderer;

    const world = new World();
    const { marker } = spawnMarkerScene(world);
    const releaseTransforms = registerPropagateTransforms(world);
    try {
      const receipt = await runBarrelBrowserStage('draw-picking', () => drawFrame(world));
      const screenshot = await runBarrelBrowserStage('read-picking', () =>
        screenshotPixels(activeCanvas()),
      );
      const markerPixel = findGpuMarker(screenshot);
      const screenshotExtent = lastScreenshotExtent.width;
      // Convert the screenshot's CSS/device pixel back to the submitted
      // physical output extent. The marker location itself came from GPU
      // readback; no CPU inverse mapping supplies the expected point.
      const displayX = (markerPixel.x * WIDTH) / screenshotExtent;
      const displayY = (markerPixel.y * HEIGHT) / screenshotExtent;
      const hit = pickDisplay(world, displayX, displayY, receipt.barrelDistortion, WIDTH, HEIGHT);
      expect(hit?.entity).toBe(marker);
      expect(hit?.distance).toBeGreaterThan(0);
    } finally {
      releaseTransforms();
    }
  });
});
