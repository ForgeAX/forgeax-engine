import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_FXAA,
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  Atmosphere,
  BarrelDistortion,
  Camera,
  createBarrelDistortionMapping,
  DepthOfField,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  MotionBlur,
  setActiveCamera,
  TONEMAP_LINEAR,
  TONEMAP_NONE,
  VolumetricFog,
} from '@forgeax/engine-render';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  BARREL_GPU_HEIGHT,
  BARREL_GPU_WIDTH,
  countRgbDifferences,
  cpuBarrelProbe,
  createBarrelRendererFixture,
  maxRgbDelta,
  pixelOffset,
  probeBarrelDistortionF32,
  readBarrelPixels,
} from './barrel-distortion-gpu-fixture';
import { drawPublished } from './draw-published';

function spawnSelectionCamera(
  world: World,
  barrel?: {
    readonly strength: number;
    readonly centerX: number;
    readonly centerY: number;
  },
) {
  const transform = {
    component: Transform,
    data: {
      pos: [0, 0, 4],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
  } as const;
  const camera = {
    component: Camera,
    data: {
      fov: Math.PI / 3,
      aspect: BARREL_GPU_WIDTH / BARREL_GPU_HEIGHT,
      near: 0.1,
      far: 100,
      antialias: ANTIALIAS_NONE,
      tonemap: TONEMAP_NONE,
      clearColor: [0.02, 0.02, 0.02, 1] as const,
    },
  } as const;
  return barrel === undefined
    ? world.spawn(transform, camera).unwrap()
    : world
        .spawn(transform, camera, {
          component: BarrelDistortion,
          data: barrel,
        })
        .unwrap();
}

function spawnBarrelScene(
  world: World,
  assets: AssetRegistry,
  options: {
    readonly clearColor: readonly [number, number, number, number];
    readonly barrel?: {
      readonly strength: number;
      readonly centerX: number;
      readonly centerY: number;
    };
    readonly geometry: boolean;
    readonly geometryColor?: readonly [number, number, number, number];
    readonly edgeRods?: boolean;
    readonly edgeAlpha?: number;
    readonly highContrastEdge?: boolean;
    readonly antialias?: number;
    readonly tonemap?: number;
    readonly depthOfField?: boolean;
  },
) {
  const cube = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const geometryMaterial =
    options.geometryColor === undefined
      ? undefined
      : assets.create(Materials.unlit(options.geometryColor)).unwrap();
  if (options.geometry) {
    for (const position of [-1.15, 0, 1.15]) {
      world.spawn(
        {
          component: Transform,
          data: {
            pos: [position, 0, 0],
            quat: [0, 0, 0, 1],
            scale: [0.7, 1.6, 0.35],
          },
        },
        { component: MeshFilter, data: { assetHandle: cube } },
        {
          component: MeshRenderer,
          data: geometryMaterial === undefined ? {} : { materials: [geometryMaterial] },
        },
      );
    }
  }
  if (options.edgeRods === true) {
    for (const [x, y, color] of [
      [-2.2, 0.8, [0.95, 0.1, 0.1, 1]],
      [2.2, 0.8, [0.1, 0.2, 0.95, 1]],
      [0, 2.2, [0.1, 0.95, 0.2, 1]],
      [0, -1.6, [0.95, 0.8, 0.1, 1]],
    ] as const) {
      const material = assets.create(Materials.unlit(color)).unwrap();
      world.spawn(
        {
          component: Transform,
          data: { pos: [x, y, -0.4], scale: [0.08, 0.9, 0.08] },
        },
        { component: MeshFilter, data: { assetHandle: cube } },
        { component: MeshRenderer, data: { materials: [material] } },
      );
    }
  }
  if (options.highContrastEdge === true) {
    const material = assets.create(Materials.unlit([1, 1, 1, options.edgeAlpha ?? 0.5])).unwrap();
    world.spawn(
      {
        component: Transform,
        data: { pos: [0, 0, 0], scale: [0.12, 2.6, 0.35] },
      },
      { component: MeshFilter, data: { assetHandle: cube } },
      { component: MeshRenderer, data: { materials: [material] } },
    );
  }
  const transform = {
    component: Transform,
    data: {
      pos: [0, 0, 4],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
  } as const;
  const camera = {
    component: Camera,
    data: {
      fov: Math.PI / 3,
      aspect: BARREL_GPU_WIDTH / BARREL_GPU_HEIGHT,
      near: 0.1,
      far: 100,
      antialias: options.antialias ?? ANTIALIAS_NONE,
      tonemap: options.tonemap ?? TONEMAP_NONE,
      clearColor: options.clearColor,
    },
  } as const;
  const cameraEntity =
    options.barrel === undefined
      ? world.spawn(transform, camera).unwrap()
      : world
          .spawn(transform, camera, {
            component: BarrelDistortion,
            data: options.barrel,
          })
          .unwrap();
  if (options.depthOfField === true) {
    world
      .addComponent(cameraEntity, {
        component: DepthOfField,
        data: {
          focusDistance: 4,
          fStop: 2.8,
          sensorHeight: 0.024,
          maxRadiusPixels: 4,
        },
      })
      .unwrap();
  }
  return cameraEntity;
}

function spawnTemporalHighContrastEdge(world: World, assets: AssetRegistry) {
  const cube = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const edgeMaterial = assets.create(Materials.unlit([1, 1, 1, 1])).unwrap();
  const edge = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [0.12, 2.6, 0.35],
        },
      },
      { component: MeshFilter, data: { assetHandle: cube } },
      { component: MeshRenderer, data: { materials: [edgeMaterial] } },
    )
    .unwrap();
  const camera = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 4],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: BARREL_GPU_WIDTH / BARREL_GPU_HEIGHT,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_TAA,
          clearColor: [0, 0, 0, 1],
        },
      },
      {
        component: BarrelDistortion,
        data: { strength: 0.2, centerX: 0.5, centerY: 0.5 },
      },
      {
        component: MotionBlur,
        data: { shutterAngle: 180, maxRadiusPixels: 32, sampleCount: 8 },
      },
    )
    .unwrap();
  return { edge, camera };
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

function brightPixelCentroid(pixels: Uint8Array): {
  readonly count: number;
  readonly x: number;
  readonly y: number;
} {
  let count = 0;
  let weight = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let y = 0; y < BARREL_GPU_HEIGHT; y += 1) {
    for (let x = 0; x < BARREL_GPU_WIDTH; x += 1) {
      const offset = pixelOffset(x, y);
      const red = pixels[offset] ?? 0;
      const green = pixels[offset + 1] ?? 0;
      const blue = pixels[offset + 2] ?? 0;
      const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
      if (luminance < 32) continue;
      count += 1;
      weight += luminance;
      weightedX += x * luminance;
      weightedY += y * luminance;
    }
  }
  return {
    count,
    x: weight === 0 ? Number.NaN : weightedX / weight,
    y: weight === 0 ? Number.NaN : weightedY / weight,
  };
}

function rgbAt(pixels: Uint8Array, x: number, y: number): readonly [number, number, number] {
  const offset = pixelOffset(x, y);
  return [pixels[offset + 0] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0];
}

function rgbaAt(
  pixels: Uint8Array,
  x: number,
  y: number,
): readonly [number, number, number, number] {
  const offset = pixelOffset(x, y);
  return [
    (pixels[offset + 0] ?? 0) / 255,
    (pixels[offset + 1] ?? 0) / 255,
    (pixels[offset + 2] ?? 0) / 255,
    (pixels[offset + 3] ?? 0) / 255,
  ];
}

function fxaaEdgeEvidence(
  pixels: Uint8Array,
  x: number,
  y: number,
): { readonly lumaRange: number; readonly threshold: number } | undefined {
  if (x <= 0 || y <= 0 || x >= BARREL_GPU_WIDTH - 1 || y >= BARREL_GPU_HEIGHT - 1) {
    return undefined;
  }
  const samples = [
    rgbaAt(pixels, x, y),
    rgbaAt(pixels, x, y + 1),
    rgbaAt(pixels, x, y - 1),
    rgbaAt(pixels, x - 1, y),
    rgbaAt(pixels, x + 1, y),
  ];
  const lumas = samples.map(([red, green, blue]) =>
    Math.sqrt(Math.max(0, 0.299 * red + 0.587 * green + 0.114 * blue)),
  );
  const lumaMin = Math.min(...lumas);
  const lumaMax = Math.max(...lumas);
  return {
    lumaRange: lumaMax - lumaMin,
    threshold: Math.max(0.0312, lumaMax * 0.125),
  };
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

const PRECISION_EXTENTS = [
  { label: '1080p', width: 1920, height: 1080 },
  { label: '4K', width: 3840, height: 2160 },
] as const;

const PRECISION_STRENGTHS = [0, 0.2, 0.35] as const;

const PRECISION_CENTERS = [
  { label: 'center', centerX: 0.5, centerY: 0.5 },
  { label: 'off-center', centerX: 0.31, centerY: 0.67 },
  { label: 'boundary-left', centerX: 0, centerY: 0.5 },
  { label: 'boundary-right', centerX: 1, centerY: 0.5 },
  { label: 'boundary-top', centerX: 0.5, centerY: 0 },
  { label: 'boundary-bottom', centerX: 0.5, centerY: 1 },
] as const;

type PrecisionUv = readonly [number, number];

function fixedSeedInteriorUvs(seed = 0x9e3779b9, count = 32): readonly PrecisionUv[] {
  let state = seed >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  return Array.from({ length: count }, () => [0.05 + next() * 0.9, 0.05 + next() * 0.9] as const);
}

const PRECISION_SAMPLE_SETS = [
  { label: 'center', points: [[0.5, 0.5]] as readonly PrecisionUv[] },
  {
    label: 'edge-midpoints',
    points: [
      [0, 0.5],
      [1, 0.5],
      [0.5, 0],
      [0.5, 1],
    ] as readonly PrecisionUv[],
  },
  {
    label: 'corners',
    points: [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as readonly PrecisionUv[],
  },
  {
    label: 'interior-seed-0x9e3779b9',
    points: fixedSeedInteriorUvs(),
  },
] as const;

interface PrecisionSampleError {
  readonly maxXErrorPixels: number;
  readonly maxYErrorPixels: number;
  readonly maxErrorPixels: number;
}

interface PrecisionGroupReport {
  readonly extent: { readonly label: string; readonly width: number; readonly height: number };
  readonly strength: number;
  readonly center: { readonly label: string; readonly x: number; readonly y: number };
  readonly sampleCount: number;
  readonly sampleMaxErrorPixels: Readonly<Record<string, PrecisionSampleError>>;
  readonly maxErrorPixels: number;
}

async function probePrecisionGroup(
  device: GPUDevice,
  extent: (typeof PRECISION_EXTENTS)[number],
  strength: number,
  center: (typeof PRECISION_CENTERS)[number],
): Promise<PrecisionGroupReport> {
  const mapping = createBarrelDistortionMapping(extent.width, extent.height, {
    strength,
    centerX: center.centerX,
    centerY: center.centerY,
  }).unwrap();
  const inputs = PRECISION_SAMPLE_SETS.flatMap((sampleSet) => sampleSet.points);
  const probe = await probeBarrelDistortionF32(device, mapping, inputs);
  const expected = cpuBarrelProbe(mapping, inputs);
  const sampleMaxErrorPixels: Record<string, PrecisionSampleError> = {};
  let inputOffset = 0;
  for (const sampleSet of PRECISION_SAMPLE_SETS) {
    let maxXErrorPixels = 0;
    let maxYErrorPixels = 0;
    for (let index = 0; index < sampleSet.points.length; index += 1) {
      const inputIndex = inputOffset + index;
      const cpu = expected[inputIndex];
      const gpu = probe.outputs[inputIndex];
      expect(Number.isFinite(cpu?.[0])).toBe(true);
      expect(Number.isFinite(cpu?.[1])).toBe(true);
      expect(Number.isFinite(gpu?.[0])).toBe(true);
      expect(Number.isFinite(gpu?.[1])).toBe(true);
      maxXErrorPixels = Math.max(
        maxXErrorPixels,
        Math.abs((cpu?.[0] ?? 0) - (gpu?.[0] ?? 0)) * extent.width,
      );
      maxYErrorPixels = Math.max(
        maxYErrorPixels,
        Math.abs((cpu?.[1] ?? 0) - (gpu?.[1] ?? 0)) * extent.height,
      );
    }
    const maxErrorPixels = Math.max(maxXErrorPixels, maxYErrorPixels);
    sampleMaxErrorPixels[sampleSet.label] = {
      maxXErrorPixels,
      maxYErrorPixels,
      maxErrorPixels,
    };
    inputOffset += sampleSet.points.length;
  }
  const maxErrorPixels = Math.max(
    ...Object.values(sampleMaxErrorPixels).map((sample) => sample.maxErrorPixels),
  );
  const report = {
    extent,
    strength,
    center: { label: center.label, x: center.centerX, y: center.centerY },
    sampleCount: inputs.length,
    sampleMaxErrorPixels,
    maxErrorPixels,
  } satisfies PrecisionGroupReport;
  // One JSON line per extent/strength/center group keeps the measured physical
  // pixel error auditable when the Dawn gate log is retained as evidence.
  // biome-ignore lint/suspicious/noConsole: precision evidence is intentionally emitted.
  console.info(`[barrel-distortion-precision] ${JSON.stringify(report)}`);
  expect(maxErrorPixels).toBeLessThanOrEqual(0.25);
  return report;
}

describe('barrel distortion real output on Dawn', () => {
  it('admits the selected camera only across a production switch and retirement', async () => {
    const fixture = await createBarrelRendererFixture();
    try {
      const world = new World({ assets: fixture.assets });
      const disabledCamera = spawnBarrelScene(world, fixture.assets, {
        clearColor: [0.02, 0.02, 0.02, 1],
        geometry: true,
      });
      const enabledCamera = spawnSelectionCamera(world, {
        strength: 0.2,
        centerX: 0.5,
        centerY: 0.5,
      });
      setActiveCamera(world, disabledCamera as number);
      const attached = fixture.renderer.attach(world);
      expect(attached.ok).toBe(true);
      if (!attached.ok) throw attached.error;

      const drawFrame = () => {
        expect(world.update(1 / 60).ok).toBe(true);
        const receipt = fixture.renderer.draw({
          leases: [attached.value],
          camera: { lease: attached.value },
          environment: { lease: attached.value },
        });
        expect(receipt.ok).toBe(true);
        if (!receipt.ok) throw receipt.error;
        return receipt.value;
      };

      const baselineReceipt = drawFrame();
      await fixture.device.queue.onSubmittedWorkDone();
      const baseline = await readBarrelPixels(fixture.device, fixture.renderTarget);
      expect(baselineReceipt.barrelDistortion?.strength).toBe(0);

      setActiveCamera(world, enabledCamera as number);
      const warpedReceipt = drawFrame();
      await fixture.device.queue.onSubmittedWorkDone();
      const warped = await readBarrelPixels(fixture.device, fixture.renderTarget);
      expect(warpedReceipt.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
      expect(countRgbDifferences(baseline, warped)).toBeGreaterThan(0);

      setActiveCamera(world, disabledCamera as number);
      const retiredReceipt = drawFrame();
      await fixture.device.queue.onSubmittedWorkDone();
      const retired = await readBarrelPixels(fixture.device, fixture.renderTarget);
      expect(retiredReceipt.barrelDistortion?.strength).toBe(0);
      expect(countRgbDifferences(baseline, retired)).toBe(0);
    } finally {
      await fixture.renderer.dispose();
    }
  }, 60_000);

  it('keeps the typed rgba16float intermediate when FXAA follows the warp', async () => {
    const fixture = await createBarrelRendererFixture();
    try {
      const world = new World({ assets: fixture.assets });
      spawnBarrelScene(world, fixture.assets, {
        clearColor: [0.02, 0.02, 0.02, 1],
        barrel: { strength: 0.2, centerX: 0.5, centerY: 0.5 },
        geometry: true,
        antialias: ANTIALIAS_FXAA,
        depthOfField: true,
      });
      const attached = fixture.renderer.attach(world);
      expect(attached.ok).toBe(true);
      if (!attached.ok) throw attached.error;
      expect(world.update(1 / 60).ok).toBe(true);
      const receipt = fixture.renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      expect(receipt.ok).toBe(true);
      if (!receipt.ok) throw receipt.error;
      await fixture.device.queue.onSubmittedWorkDone();
      const pixels = await readBarrelPixels(fixture.device, fixture.renderTarget);
      expect(receipt.value.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
      const inspection = fixture.renderer.inspect();
      expect(inspection.depthOfField).toMatchObject({
        enabled: true,
        status: 'active',
        outputExtent: { width: BARREL_GPU_WIDTH, height: BARREL_GPU_HEIGHT },
      });
      const passes = inspection.output.graphPassNames;
      const barrelIndex = passes.indexOf('barrel-distortion');
      const fxaaIndex = passes.indexOf('fxaa');
      const encodingIndex = passes.indexOf('standard-output-encoding');
      expect(passes).toEqual(
        expect.arrayContaining(['dof-coc', 'dof-composite', 'barrel-distortion', 'fxaa']),
      );
      expect(barrelIndex).toBeGreaterThan(passes.indexOf('dof-composite'));
      expect(fxaaIndex).toBeGreaterThan(barrelIndex);
      expect(encodingIndex).toBeGreaterThan(fxaaIndex);
      expect(inspection.output.capability).toBe('rgba16float-renderable');
      const distinctRgb = new Set<string>();
      for (let offset = 0; offset < pixels.length; offset += 4) {
        distinctRgb.add(
          `${pixels[offset] ?? 0},${pixels[offset + 1] ?? 0},${pixels[offset + 2] ?? 0}`,
        );
      }
      expect(distinctRgb.size).toBeGreaterThan(1);
    } finally {
      await fixture.renderer.dispose();
    }
  });

  it('keeps a moving high-contrast edge stable through TAA, MotionBlur, and Barrel', async () => {
    const fixture = await createBarrelRendererFixture();
    try {
      const world = new World({ assets: fixture.assets });
      const { edge } = spawnTemporalHighContrastEdge(world, fixture.assets);
      const attached = fixture.renderer.attach(world);
      expect(attached.ok).toBe(true);
      if (!attached.ok) throw attached.error;

      const receipts = [];
      const images: Uint8Array[] = [];
      const centroids: number[] = [];
      const brightCounts: number[] = [];
      const temporalStates: Array<{ readonly status: string; readonly historyValid: boolean }> = [];
      // Motion Blur needs one submitted baseline before its first active pair.
      // Seed that baseline outside the moving path so every recorded edge
      // position exercises the active compute lane.
      expect(world.update(1 / 60).ok).toBe(true);
      const baselineDraw = fixture.renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      expect(baselineDraw.ok).toBe(true);
      await fixture.device.queue.onSubmittedWorkDone();
      // Move across the view and then reverse over the same path. A one-way
      // centroid delta could pass while a temporal history is drifting; the
      // turning-point assertions below require the submitted picture to follow
      // both directions.
      const edgePositions = [-0.64, -0.32, 0, 0.32, 0.64, 0.32, 0, -0.32, -0.64];
      for (const position of edgePositions) {
        world.set(edge, Transform, { pos: [position, 0, 0] }).unwrap();
        expect(world.update(1 / 60).ok).toBe(true);
        const drawn = fixture.renderer.draw({
          leases: [attached.value],
          camera: { lease: attached.value },
          environment: { lease: attached.value },
        });
        expect(drawn.ok).toBe(true);
        if (!drawn.ok) throw drawn.error;
        receipts.push(drawn.value);
        await fixture.device.queue.onSubmittedWorkDone();
        const pixels = await readBarrelPixels(fixture.device, fixture.renderTarget);
        const bright = brightPixelCentroid(pixels);
        expect(bright.count).toBeGreaterThan(0);
        expect(Number.isFinite(bright.x)).toBe(true);
        expect(Number.isFinite(bright.y)).toBe(true);
        images.push(pixels);
        centroids.push(bright.x);
        brightCounts.push(bright.count);
        const inspection = fixture.renderer.inspect();
        expect(inspection.motionBlur).toMatchObject({ status: 'active' });
        expect(inspection.temporal?.historyValid).toBe(true);
        if (inspection.temporal !== undefined) {
          temporalStates.push({
            status: inspection.temporal.status,
            historyValid: inspection.temporal.historyValid,
          });
        }
      }

      const inspection = fixture.renderer.inspect();
      expect(receipts.at(-1)?.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
      expect(inspection.temporal).toMatchObject({ status: 'stable', historyValid: true });
      expect(inspection.motionBlur).toMatchObject({ status: 'active' });
      expect(inspection.output.graphPassNames).toEqual(
        expect.arrayContaining(['taa-resolve', 'motion-blur', 'barrel-distortion']),
      );
      const passes = inspection.output.graphPassNames;
      expect(passes.indexOf('barrel-distortion')).toBeGreaterThan(passes.indexOf('motion-blur'));
      expect(temporalStates).toHaveLength(edgePositions.length);
      expect(temporalStates.every((state) => state.historyValid)).toBe(true);
      const turningPoint = Math.floor(edgePositions.length / 2);
      const firstCentroid = centroids[0] ?? Number.NaN;
      const peakCentroid = centroids[turningPoint] ?? Number.NaN;
      const finalCentroid = centroids.at(-1) ?? Number.NaN;
      expect(peakCentroid - firstCentroid).toBeGreaterThan(4);
      expect(peakCentroid - finalCentroid).toBeGreaterThan(4);
      const returnToStartPixels = Math.abs(finalCentroid - firstCentroid);
      expect(returnToStartPixels).toBeLessThanOrEqual(1);
      expect((centroids[turningPoint - 1] ?? peakCentroid) < peakCentroid).toBe(true);
      expect((centroids[turningPoint + 1] ?? peakCentroid) < peakCentroid).toBe(true);
      expect(brightCounts.every((count) => count > 0)).toBe(true);
      expect(
        countRgbDifferences(images[0] ?? new Uint8Array(), images.at(-1) ?? new Uint8Array()),
      ).toBeGreaterThan(0);
      // Keep the real readback movement and per-frame temporal state beside the
      // pass result so the evidence does not reduce to a test count.
      // biome-ignore lint/suspicious/noConsole: structured Dawn evidence is intentional.
      console.info(
        `[barrel-distortion-temporal-edge] ${JSON.stringify({
          frameCount: receipts.length,
          frameIds: receipts.map((receipt) => receipt.frameId),
          edgePositions,
          centroids,
          returnToStartPixels,
          brightCounts,
          temporalStates,
          historyValid: inspection.temporal?.historyValid ?? false,
          graphOrder: passes.filter((name) =>
            ['taa-resolve', 'motion-blur', 'barrel-distortion'].includes(name),
          ),
        })}`,
      );
    } finally {
      await fixture.renderer.dispose();
    }
  }, 60_000);

  it('composes active Barrel with VolumetricFog through a real Dawn readback', async () => {
    const fixture = await createBarrelRendererFixture();
    try {
      const world = new World({ assets: fixture.assets });
      spawnBarrelScene(world, fixture.assets, {
        clearColor: [0.015, 0.02, 0.035, 1],
        barrel: { strength: 0.2, centerX: 0.5, centerY: 0.5 },
        geometry: true,
        geometryColor: [0.85, 0.25, 0.08, 1],
        tonemap: TONEMAP_LINEAR,
        depthOfField: true,
      });
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
      const densityAsset = createConstantVolumeDensity();
      const density = fixture.assets.create(densityAsset).unwrap();
      const releaseTransforms = registerPropagateTransforms(world);
      const attached = fixture.renderer.attach(world);
      expect(attached.ok).toBe(true);
      if (!attached.ok) throw attached.error;
      const drawFrame = () => {
        expect(world.update(1 / 60).ok).toBe(true);
        const receipt = fixture.renderer.draw({
          leases: [attached.value],
          camera: { lease: attached.value },
          environment: { lease: attached.value },
        });
        expect(receipt.ok).toBe(true);
        if (!receipt.ok) throw receipt.error;
        return receipt.value;
      };

      const baselineReceipt = drawFrame();
      await fixture.device.queue.onSubmittedWorkDone();
      const baseline = await readBarrelPixels(fixture.device, fixture.renderTarget);
      const fog = world
        .spawn({
          component: VolumetricFog,
          data: {
            light,
            density,
            boundsMin: [-8, -4, -2],
            boundsMax: [8, 4, 3],
            extinction: [0.8, 0.8, 0.8],
            albedo: [0.75, 0.75, 0.75],
            emission: [0.2, 0.1, 0.05],
            anisotropy: 0,
            maxDistance: 30,
          },
        })
        .unwrap();
      // The volume graph is an accepted candidate with a renderer-owned
      // resource lease. The first draw admits it; the second submitted frame
      // is the observable picture that proves the retained graph was used.
      const fogCandidateReceipt = drawFrame();
      await fixture.device.queue.onSubmittedWorkDone();
      const fogReceipt = drawFrame();
      await fixture.device.queue.onSubmittedWorkDone();
      const fogPixels = await readBarrelPixels(fixture.device, fixture.renderTarget);
      const inspection = fixture.renderer.inspect();
      expect(baselineReceipt.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
      expect(fogReceipt.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
      expect(inspection.depthOfField).toMatchObject({ enabled: true, status: 'active' });
      expect(inspection.volumetricFog?.status).toBe('available');
      expect(inspection.volumetricFog?.passCount).toBe(4);
      expect(inspection.volumetricFog?.resourceFacts?.currentBytes).toBeGreaterThan(0);
      expect(inspection.perFramePassNames).toContain('volume-composite');
      expect(countRgbDifferences(baseline, fogPixels)).toBeGreaterThan(0);
      // biome-ignore lint/suspicious/noConsole: bounded Dawn readback evidence is intentional.
      console.info(
        '[barrel-dawn] volume-composition',
        JSON.stringify({
          baselineFrame: baselineReceipt.frameId,
          fogCandidateFrame: fogCandidateReceipt.frameId,
          fogFrame: fogReceipt.frameId,
          changedPixels: countRgbDifferences(baseline, fogPixels),
          maxRgbDelta: maxRgbDelta(baseline, fogPixels),
          depthOfField: inspection.depthOfField,
          volumetricFog: inspection.volumetricFog,
        }),
      );
      world.despawn(fog).unwrap();
      fixture.assets.release(density).unwrap();
      releaseTransforms();
    } finally {
      await fixture.renderer.dispose();
    }
  }, 60_000);

  it('keeps HDR, non-identity LUT, alpha, and one final encoding in order', async () => {
    const fixture = await createBarrelRendererFixture();
    try {
      const world = new World({ assets: fixture.assets });
      const lut = createChannelSwapLut();
      const lutHandle = fixture.assets.create(lut).unwrap();
      const camera = spawnBarrelScene(world, fixture.assets, {
        // The red channel is deliberately HDR. TONEMAP_LINEAR clamps it in
        // the rgba16float path before the LUT and final OETF.
        // Target alpha byte 128 without placing it halfway between UNORM8
        // values 127 and 128. The separate FXAA edge case retains half alpha.
        clearColor: [0, 0, 0, 1],
        barrel: { strength: 0.2, centerX: 0.5, centerY: 0.5 },
        geometry: true,
        geometryColor: [1.5, 0.5, 0.25, 128 / 255],
        antialias: ANTIALIAS_FXAA,
      });
      world
        .set(camera, Camera, {
          tonemap: TONEMAP_LINEAR,
          colorLut: lutHandle,
          colorLutStrength: 1,
        })
        .unwrap();
      const attached = fixture.renderer.attach(world);
      expect(attached.ok).toBe(true);
      if (!attached.ok) throw attached.error;

      const drawFrame = async () => {
        expect(world.update(1 / 60).ok).toBe(true);
        const receipt = fixture.renderer.draw({
          leases: [attached.value],
          camera: { lease: attached.value },
          environment: { lease: attached.value },
        });
        expect(receipt.ok).toBe(true);
        if (!receipt.ok) throw receipt.error;
        await fixture.device.queue.onSubmittedWorkDone();
        return {
          receipt: receipt.value,
          pixels: await readBarrelPixels(fixture.device, fixture.renderTarget),
        };
      };

      const enabled = await drawFrame();
      const enabledInspection = fixture.renderer.inspect();
      const enabledPasses = enabledInspection.output.graphPassNames;
      const lutIndex = enabledPasses.indexOf('standard-color-lut');
      const barrelIndex = enabledPasses.indexOf('barrel-distortion');
      const fxaaIndex = enabledPasses.indexOf('fxaa');
      const encodingIndices = enabledPasses.flatMap((name, index) =>
        name === 'standard-output-encoding' ? [index] : [],
      );
      expect(enabled.receipt.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
      expect(enabledInspection.output.displayEncoded).toBe(true);
      const lutSourceKey = enabledInspection.output.standardLut?.sourceKey;
      expect(lutSourceKey).toBeTruthy();
      expect(lutIndex).toBeGreaterThan(enabledPasses.indexOf('standard-tone'));
      expect(barrelIndex).toBeGreaterThan(lutIndex);
      expect(fxaaIndex).toBeGreaterThan(barrelIndex);
      expect(encodingIndices).toHaveLength(1);
      expect(encodingIndices[0]).toBeGreaterThan(fxaaIndex);
      const centerOffset = pixelOffset(BARREL_GPU_WIDTH >> 1, BARREL_GPU_HEIGHT >> 1);
      expect(enabled.pixels[centerOffset + 3]).toBe(128);

      world.set(camera, Camera, { colorLut: 0 as never, colorLutStrength: 0 }).unwrap();
      const disabled = await drawFrame();
      const disabledInspection = fixture.renderer.inspect();
      const disabledPasses = disabledInspection.output.graphPassNames;
      // Explicitly disabling the LUT removes its active source and graph pass;
      // the pixel checks below still prove one unchanged final encoding writer.
      expect(disabledInspection.output.standardLut?.sourceKey).toBeNull();
      expect(disabledPasses).not.toContain('standard-color-lut');
      expect(disabledPasses.filter((name) => name === 'standard-output-encoding')).toHaveLength(1);
      expect(disabled.receipt.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
      expect(disabled.pixels[centerOffset + 3]).toBe(128);

      const enabledCenter = rgbAt(enabled.pixels, BARREL_GPU_WIDTH >> 1, BARREL_GPU_HEIGHT >> 1);
      const disabledCenter = rgbAt(disabled.pixels, BARREL_GPU_WIDTH >> 1, BARREL_GPU_HEIGHT >> 1);
      // Linear-LDR [1, 0.5, 0.25] becomes approximately [255, 188, 137]
      // after one sRGB OETF. The non-identity LUT changes the red/blue
      // ordering, proving LUT admission and the final encoding location
      // without coupling the test to a particular 3D texel layout.
      expect(disabledCenter[0]).toBeGreaterThanOrEqual(253);
      expect(disabledCenter[1]).toBeGreaterThanOrEqual(186);
      expect(disabledCenter[1]).toBeLessThanOrEqual(190);
      expect(disabledCenter[2]).toBeGreaterThanOrEqual(135);
      expect(disabledCenter[2]).toBeLessThanOrEqual(139);
      expect(enabledCenter[0]).toBeLessThan(disabledCenter[0]);
      expect(enabledCenter[2]).toBeGreaterThan(disabledCenter[2]);
      expect(countRgbDifferences(enabled.pixels, disabled.pixels)).toBeGreaterThan(0);

      world.set(camera, Camera, { colorLut: lutHandle, colorLutStrength: 1 }).unwrap();
      await drawFrame();
      const generation = fixture.renderer.inspect().recoveryEvidence.graph.generation;
      fixture.assets.update(lutHandle, { data: new Uint8Array(lut.data.byteLength) }).unwrap();
      const edited = await drawFrame();
      expect(rgbAt(edited.pixels, BARREL_GPU_WIDTH >> 1, BARREL_GPU_HEIGHT >> 1)).toEqual([
        0, 0, 0,
      ]);
      expect(edited.pixels[centerOffset + 3]).toBe(128);
      expect(fixture.renderer.inspect().recoveryEvidence.graph.generation).toBe(generation);
      expect(fixture.renderer.inspect().output.standardLut?.sourceKey).toBe(lutSourceKey);
      fixture.assets.update(lutHandle, { data: lut.data }).unwrap();
      const restored = await drawFrame();
      expect(maxRgbDelta(restored.pixels, enabled.pixels)).toBeLessThanOrEqual(1);

      world.set(camera, BarrelDistortion, { strength: 0 }).unwrap();
      world.set(camera, Camera, { antialias: ANTIALIAS_NONE }).unwrap();
      const fused = await drawFrame();
      expect(fixture.renderer.inspect().output.graphPassNames).toContain(
        'standard-tone-lut-output',
      );
      const fusedGeneration = fixture.renderer.inspect().recoveryEvidence.graph.generation;
      fixture.assets.update(lutHandle, { data: new Uint8Array(lut.data.byteLength) }).unwrap();
      const fusedEdited = await drawFrame();
      expect(rgbAt(fusedEdited.pixels, BARREL_GPU_WIDTH >> 1, BARREL_GPU_HEIGHT >> 1)).toEqual([
        0, 0, 0,
      ]);
      expect(fusedEdited.pixels[centerOffset + 3]).toBe(128);
      expect(fixture.renderer.inspect().recoveryEvidence.graph.generation).toBe(fusedGeneration);
      fixture.assets.update(lutHandle, { data: lut.data }).unwrap();
      expect(maxRgbDelta((await drawFrame()).pixels, fused.pixels)).toBeLessThanOrEqual(1);
    } finally {
      await fixture.renderer.dispose();
    }
  });

  it('proves FXAA enters its edge branch while preserving a half-alpha edge', async () => {
    const fixture = await createBarrelRendererFixture();
    try {
      const drawWithLinearObservation = async (world: World) => {
        const armed = fixture.renderer.requestObservation?.(['linear-ldr']);
        expect(armed).toBeDefined();
        if (armed === undefined || !armed.ok) {
          throw new Error('Dawn FXAA edge fixture could not arm linear-LDR observation');
        }
        const receipt = await drawPublished(fixture.renderer, world);
        expect(receipt.ok).toBe(true);
        if (!receipt.ok) throw receipt.error;
        await fixture.device.queue.onSubmittedWorkDone();
        const observed = await fixture.renderer.observe(receipt.value, {
          include: ['linear-ldr'],
        });
        expect(observed.ok).toBe(true);
        if (!observed.ok) throw observed.error;
        expect(observed.value.observations).toHaveLength(1);
        return receipt.value;
      };
      const noFxaaWorld = new World({ assets: fixture.assets });
      spawnBarrelScene(noFxaaWorld, fixture.assets, {
        // Keep both sides of the high-contrast edge at the authored alpha so
        // FXAA can move RGB across the edge without fabricating alpha.
        clearColor: [0, 0, 0, 0.5],
        geometry: false,
        highContrastEdge: true,
        antialias: ANTIALIAS_NONE,
        tonemap: TONEMAP_LINEAR,
      });
      await drawWithLinearObservation(noFxaaWorld);
      const noFxaa = await readBarrelPixels(fixture.device, fixture.renderTarget);

      const fxaaAssets = new AssetRegistry({ shaderRegistry: fixture.assets.shaderRegistry });
      const fxaaWorld = new World({ assets: fxaaAssets });
      spawnBarrelScene(fxaaWorld, fxaaAssets, {
        clearColor: [0, 0, 0, 0.5],
        geometry: false,
        highContrastEdge: true,
        antialias: ANTIALIAS_FXAA,
        tonemap: TONEMAP_LINEAR,
      });
      await drawWithLinearObservation(fxaaWorld);
      const fxaa = await readBarrelPixels(fixture.device, fixture.renderTarget);
      const inspection = fixture.renderer.inspect();
      const passes = inspection.output.graphPassNames;
      // Observation adds a tone-only readback; the ordinary FXAA route still
      // samples the single output transform's display-encoded intermediate.
      expect(passes.filter((name) => name === 'output-transform')).toHaveLength(1);
      expect(passes.indexOf('fxaa')).toBeGreaterThan(passes.indexOf('output-transform'));
      expect(passes).not.toContain('standard-output-encoding');
      expect(inspection.output.displayEncoded).toBe(true);
      expect(inspection.output.standardOutputColor?.domain).toBe('display-encoded');

      let matched:
        | {
            readonly x: number;
            readonly y: number;
            readonly lumaRange: number;
            readonly threshold: number;
            readonly sourceAlphaByte: number;
            readonly fxaaAlphaByte: number;
            readonly rgbDelta: number;
          }
        | undefined;
      let halfAlphaCount = 0;
      let edgeCount = 0;
      let alphaPreservingEdgeCount = 0;
      let maximumRgbDelta = 0;
      let maximumRgbDeltaEvidence:
        | {
            readonly x: number;
            readonly y: number;
            readonly sourceAlpha: number;
            readonly fxaaAlpha: number;
          }
        | undefined;
      let maximumAlphaPreservingRgbDelta = 0;
      let maximumAlphaPreservingRgbDeltaEvidence:
        | { readonly x: number; readonly y: number; readonly rgbDelta: number }
        | undefined;
      for (let y = 1; y < BARREL_GPU_HEIGHT - 1 && matched === undefined; y += 1) {
        for (let x = 1; x < BARREL_GPU_WIDTH - 1; x += 1) {
          const source = rgbaAt(noFxaa, x, y);
          if (Math.abs(source[3] - 0.5) > 0.02) continue;
          halfAlphaCount += 1;
          const edge = fxaaEdgeEvidence(noFxaa, x, y);
          if (edge === undefined || edge.lumaRange < edge.threshold) continue;
          edgeCount += 1;
          const noFxaaPixel = rgbaAt(noFxaa, x, y);
          const fxaaPixel = rgbaAt(fxaa, x, y);
          const rgbDelta = Math.max(
            Math.abs(noFxaaPixel[0] - fxaaPixel[0]),
            Math.abs(noFxaaPixel[1] - fxaaPixel[1]),
            Math.abs(noFxaaPixel[2] - fxaaPixel[2]),
          );
          const sourceAlphaByte = Math.round(source[3] * 255);
          const fxaaAlphaByte = Math.round(fxaaPixel[3] * 255);
          if (fxaaAlphaByte >= 126 && fxaaAlphaByte <= 130) alphaPreservingEdgeCount += 1;
          if (
            fxaaAlphaByte >= 126 &&
            fxaaAlphaByte <= 130 &&
            rgbDelta > maximumAlphaPreservingRgbDelta
          ) {
            maximumAlphaPreservingRgbDelta = rgbDelta;
            maximumAlphaPreservingRgbDeltaEvidence = { x, y, rgbDelta };
          }
          if (rgbDelta > maximumRgbDelta) {
            maximumRgbDelta = rgbDelta;
            maximumRgbDeltaEvidence = {
              x,
              y,
              sourceAlpha: source[3],
              fxaaAlpha: fxaaPixel[3],
            };
          }
          if (
            sourceAlphaByte >= 126 &&
            sourceAlphaByte <= 130 &&
            fxaaAlphaByte >= 126 &&
            fxaaAlphaByte <= 130 &&
            rgbDelta > 0.01
          ) {
            matched = {
              x,
              y,
              lumaRange: edge.lumaRange,
              threshold: edge.threshold,
              sourceAlphaByte,
              fxaaAlphaByte,
              rgbDelta,
            };
            break;
          }
        }
      }
      // biome-ignore lint/suspicious/noConsole: retain edge-search diagnostics while tuning the fixture.
      console.info(
        `[barrel-distortion-fxaa-edge-diagnostic] ${JSON.stringify({
          halfAlphaCount,
          edgeCount,
          alphaPreservingEdgeCount,
          maximumRgbDelta,
          maximumRgbDeltaEvidence,
          maximumAlphaPreservingRgbDelta,
          maximumAlphaPreservingRgbDeltaEvidence,
        })}`,
      );
      expect(matched).toBeDefined();
      if (matched === undefined) {
        throw new Error('Dawn FXAA edge did not retain half-alpha RGB difference');
      }
      expect(matched.lumaRange).toBeGreaterThanOrEqual(matched.threshold);
      expect(matched.sourceAlphaByte).toBeGreaterThanOrEqual(126);
      expect(matched.sourceAlphaByte).toBeLessThanOrEqual(130);
      expect(matched.fxaaAlphaByte).toBeGreaterThanOrEqual(126);
      expect(matched.fxaaAlphaByte).toBeLessThanOrEqual(130);
      expect(matched.rgbDelta).toBeGreaterThan(0.01);
      // biome-ignore lint/suspicious/noConsole: retain the selected Dawn edge receipt evidence.
      console.info(`[barrel-distortion-fxaa-edge] ${JSON.stringify(matched)}`);
    } finally {
      await fixture.renderer.dispose();
    }
  });

  it('changes the submitted picture, keeps the disabled baseline, and has no white-source holes', async () => {
    const fixture = await createBarrelRendererFixture();
    try {
      const world = new World({ assets: fixture.assets });
      const camera = spawnBarrelScene(world, fixture.assets, {
        clearColor: [0.02, 0.02, 0.02, 1],
        geometry: true,
      });
      const attached = fixture.renderer.attach(world);
      expect(attached.ok).toBe(true);
      if (!attached.ok) throw attached.error;

      expect(world.update(1 / 60).ok).toBe(true);
      const baselineReceipt = fixture.renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      expect(baselineReceipt.ok).toBe(true);
      if (!baselineReceipt.ok) throw baselineReceipt.error;
      await fixture.device.queue.onSubmittedWorkDone();
      const baseline = await readBarrelPixels(fixture.device, fixture.renderTarget);
      expect(baselineReceipt.value.barrelDistortion?.strength).toBe(0);

      world
        .addComponent(camera, {
          component: BarrelDistortion,
          data: { strength: 0.2, centerX: 0.5, centerY: 0.5 },
        })
        .unwrap();
      expect(world.update(1 / 60).ok).toBe(true);
      const warpedReceipt = fixture.renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      expect(warpedReceipt.ok).toBe(true);
      if (!warpedReceipt.ok) throw warpedReceipt.error;
      await fixture.device.queue.onSubmittedWorkDone();
      const warped = await readBarrelPixels(fixture.device, fixture.renderTarget);
      expect(warpedReceipt.value.barrelDistortion).toMatchObject({
        width: BARREL_GPU_WIDTH,
        height: BARREL_GPU_HEIGHT,
      });
      expect(warpedReceipt.value.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
      expect(countRgbDifferences(baseline, warped)).toBeGreaterThan(0);
      expect(maxRgbDelta(baseline, warped)).toBeGreaterThan(0);
      expect(rgbAt(warped, BARREL_GPU_WIDTH >> 1, BARREL_GPU_HEIGHT >> 1)).toEqual(
        rgbAt(baseline, BARREL_GPU_WIDTH >> 1, BARREL_GPU_HEIGHT >> 1),
      );

      world.removeComponent(camera, BarrelDistortion).unwrap();
      expect(world.update(1 / 60).ok).toBe(true);
      const disabledReceipt = fixture.renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      expect(disabledReceipt.ok).toBe(true);
      if (!disabledReceipt.ok) throw disabledReceipt.error;
      await fixture.device.queue.onSubmittedWorkDone();
      const disabled = await readBarrelPixels(fixture.device, fixture.renderTarget);
      expect(disabledReceipt.value.barrelDistortion?.strength).toBe(0);
      expect(countRgbDifferences(baseline, disabled)).toBe(0);

      const whiteAssets = new AssetRegistry({ shaderRegistry: fixture.assets.shaderRegistry });
      const whiteWorld = new World({ assets: whiteAssets });
      spawnBarrelScene(whiteWorld, whiteAssets, {
        clearColor: [1, 1, 1, 1],
        barrel: { strength: 0.35, centerX: 0.5, centerY: 0.5 },
        geometry: false,
      });
      const whiteReceipt = await drawPublished(fixture.renderer, whiteWorld);
      expect(whiteReceipt.ok).toBe(true);
      await fixture.device.queue.onSubmittedWorkDone();
      const white = await readBarrelPixels(fixture.device, fixture.renderTarget);
      let dimPixels = 0;
      for (let y = 0; y < BARREL_GPU_HEIGHT; y += 1) {
        for (let x = 0; x < BARREL_GPU_WIDTH; x += 1) {
          const [r, g, b] = rgbAt(white, x, y);
          if (r < 240 || g < 240 || b < 240) dimPixels += 1;
        }
      }
      expect(dimPixels).toBe(0);

      const offCenterAssets = new AssetRegistry({ shaderRegistry: fixture.assets.shaderRegistry });
      const offCenterWorld = new World({ assets: offCenterAssets });
      spawnBarrelScene(offCenterWorld, offCenterAssets, {
        clearColor: [0.02, 0.02, 0.02, 1],
        geometry: true,
        edgeRods: true,
        barrel: { strength: 0.35, centerX: 0.31, centerY: 0.67 },
      });
      const offCenterAttached = fixture.renderer.attach(offCenterWorld);
      expect(offCenterAttached.ok).toBe(true);
      if (!offCenterAttached.ok) throw offCenterAttached.error;
      expect(offCenterWorld.update(1 / 60).ok).toBe(true);
      const offCenterReceipt = fixture.renderer.draw({
        leases: [offCenterAttached.value],
        camera: { lease: offCenterAttached.value },
        environment: { lease: offCenterAttached.value },
      });
      expect(offCenterReceipt.ok).toBe(true);
      if (!offCenterReceipt.ok) throw offCenterReceipt.error;
      await fixture.device.queue.onSubmittedWorkDone();
      const offCenter = await readBarrelPixels(
        fixture.device,
        fixture.renderTarget,
        fixture.width,
        fixture.height,
      );
      expect(offCenterReceipt.value.barrelDistortion).toMatchObject({
        width: BARREL_GPU_WIDTH,
        height: BARREL_GPU_HEIGHT,
      });
      expect(offCenterReceipt.value.barrelDistortion?.strength).toBeCloseTo(0.35, 6);
      expect(offCenterReceipt.value.barrelDistortion?.centerX).toBeCloseTo(0.31, 6);
      expect(offCenterReceipt.value.barrelDistortion?.centerY).toBeCloseTo(0.67, 6);
      expect(countRgbDifferences(baseline, offCenter)).toBeGreaterThan(16);
    } finally {
      await fixture.renderer.dispose();
    }
  });

  it('probes the production WGSL coordinate function at f32 precision', async () => {
    const fixture = await createBarrelRendererFixture({ width: 640, height: 360 });
    try {
      const mapping = createBarrelDistortionMapping(fixture.width, fixture.height, {
        strength: 0.35,
        centerX: 0.31,
        centerY: 0.67,
      }).unwrap();
      const inputs = [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
        [0.5, 0.5],
        [0.01, 0.67],
        [0.99, 0.67],
        [0.31, 0.01],
        [0.31, 0.99],
        ...Array.from(
          { length: 25 },
          (_, index) =>
            [((index * 37) % 101) / 100, ((index * 53 + 11) % 101) / 100] as [number, number],
        ),
      ] as const;
      const probe = await probeBarrelDistortionF32(fixture.device, mapping, inputs);
      const expected = cpuBarrelProbe(mapping, inputs);
      let maxErrorPixels = 0;
      for (let index = 0; index < inputs.length; index += 1) {
        const cpu = expected[index];
        const gpu = probe.outputs[index];
        expect(Number.isFinite(cpu?.[0])).toBe(true);
        expect(Number.isFinite(cpu?.[1])).toBe(true);
        expect(Number.isFinite(gpu?.[0])).toBe(true);
        expect(Number.isFinite(gpu?.[1])).toBe(true);
        maxErrorPixels = Math.max(
          maxErrorPixels,
          Math.abs((cpu?.[0] ?? 0) - (gpu?.[0] ?? 0)) * fixture.width,
          Math.abs((cpu?.[1] ?? 0) - (gpu?.[1] ?? 0)) * fixture.height,
        );
      }
      // Binary64 CPU values and the production f32 shader are allowed to
      // differ by quantization. The bound is in physical output pixels.
      expect(maxErrorPixels).toBeLessThan(0.01);
    } finally {
      await fixture.renderer.dispose();
    }
  });

  it('measures the production WGSL f32 mapping matrix at 1080p and 4K', async () => {
    // This is a compute-coordinate oracle: dimensions are WGSL inputs, not
    // render targets. Allocating full 1080p/4K renderer fleets adds no evidence.
    const adapter = await globalThis.navigator.gpu.requestAdapter();
    if (adapter === null) throw new Error('barrel precision requires a real WebGPU adapter');
    const device = await adapter.requestDevice();
    const errors: string[] = [];
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const reports: PrecisionGroupReport[] = [];
    try {
      for (const extent of PRECISION_EXTENTS) {
        for (const strength of PRECISION_STRENGTHS) {
          for (const center of PRECISION_CENTERS) {
            reports.push(await probePrecisionGroup(device, extent, strength, center));
          }
        }
      }
      await device.queue.onSubmittedWorkDone();
      expect(errors).toEqual([]);
    } finally {
      device.destroy();
    }
    const maximumMeasuredErrorPixels = Math.max(...reports.map((report) => report.maxErrorPixels));
    const measuredEvidence = {
      schemaVersion: 1,
      status: 'measured',
      comparison: { gpu: 'production-WGSL-f32', cpu: 'mapDisplayUvToSceneUv' },
      thresholdPixels: 0.25,
      maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
      extents: PRECISION_EXTENTS,
      strengths: PRECISION_STRENGTHS,
      centers: PRECISION_CENTERS,
      sampleSets: PRECISION_SAMPLE_SETS.map((sampleSet) => ({
        label: sampleSet.label,
        count: sampleSet.points.length,
      })),
      groupCount: reports.length,
      maximumMeasuredErrorPixels,
    };
    // biome-ignore lint/suspicious/noConsole: precision evidence summary is intentional.
    console.info(`[barrel-distortion-precision] ${JSON.stringify(measuredEvidence)}`);
    expect(reports).toHaveLength(
      PRECISION_EXTENTS.length * PRECISION_STRENGTHS.length * PRECISION_CENTERS.length,
    );
  }, 120_000);
});
