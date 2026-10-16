import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_NONE,
  BarrelDistortion,
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  mapDisplayToScene,
  mapSceneToDisplay,
  TONEMAP_NONE,
} from '@forgeax/engine-render';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { pickDisplay } from '../../../picking/src/display-picking';
import {
  BARREL_GPU_HEIGHT,
  BARREL_GPU_WIDTH,
  createBarrelRendererFixture,
  pixelOffset,
  readBarrelPixels,
} from './barrel-distortion-gpu-fixture';

/** Saturated, pairwise-separated colours make each GPU marker independently observable. */

function spawnMarkerScene(world: World) {
  const markerMaterial = world.allocSharedRef(
    'MaterialAsset',
    Materials.unlit([0.95, 0.05, 0.05, 1]),
  );
  const marker = world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, 0], scale: [0.9, 0.9, 0.9] },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [markerMaterial] } },
    )
    .unwrap();
  const camera = world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, 4], quat: [0, 0, 0, 1] },
      },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: BARREL_GPU_WIDTH / BARREL_GPU_HEIGHT,
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

function findGpuMarker(
  pixels: Uint8Array,
  color: (typeof DISPLAY_MARKER_COLORS)[keyof typeof DISPLAY_MARKER_COLORS],
): { readonly x: number; readonly y: number; readonly count: number } | undefined {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  const [targetRed, targetGreen, targetBlue] = color;
  const red = targetRed * 255;
  const green = targetGreen * 255;
  const blue = targetBlue * 255;
  for (let y = 0; y < BARREL_GPU_HEIGHT; y += 1) {
    for (let x = 0; x < BARREL_GPU_WIDTH; x += 1) {
      const offset = pixelOffset(x, y);
      const sampleRed = pixels[offset] ?? 0;
      const sampleGreen = pixels[offset + 1] ?? 0;
      const sampleBlue = pixels[offset + 2] ?? 0;
      // The fixture uses saturated, pairwise-separated unlit markers. A
      // per-colour centroid makes each matrix row an independent GPU picture
      // observation instead of using only an arbitrary non-black pixel.
      if (
        Math.abs(sampleRed - red) > 70 ||
        Math.abs(sampleGreen - green) > 70 ||
        Math.abs(sampleBlue - blue) > 70
      )
        continue;
      if (sampleRed + sampleGreen + sampleBlue < 220) continue;
      sumX += x;
      sumY += y;
      count += 1;
    }
  }
  return count === 0 ? undefined : { x: sumX / count + 0.5, y: sumY / count + 0.5, count };
}

const DISPLAY_MATRIX_SAMPLES = [
  { label: 'center', uv: [0.31, 0.67] as const, color: 'red' as const },
  { label: 'edge', uv: [0.31, 0.2] as const, color: 'green' as const },
  { label: 'corner', uv: [0.2, 0.2] as const, color: 'blue' as const },
  { label: 'off-center', uv: [0.5, 0.5] as const, color: 'yellow' as const },
  { label: 'crop-miss', uv: [0.01, 0.5] as const, color: 'magenta' as const },
] as const;

const DISPLAY_MARKER_COLORS = {
  red: [0.95, 0.05, 0.05, 1],
  green: [0.05, 0.95, 0.05, 1],
  blue: [0.05, 0.05, 0.95, 1],
  yellow: [0.95, 0.95, 0.05, 1],
  magenta: [0.95, 0.05, 0.95, 1],
} as const;

function sceneUvToWorldPosition(uv: readonly [number, number]): readonly [number, number, number] {
  const cameraDistance = 4;
  const halfHeight = cameraDistance * Math.tan(Math.PI / 6);
  const halfWidth = halfHeight * (BARREL_GPU_WIDTH / BARREL_GPU_HEIGHT);
  return [(uv[0] * 2 - 1) * halfWidth, (1 - uv[1] * 2) * halfHeight, 0];
}

function spawnDisplayMatrixScene(world: World) {
  const markers = DISPLAY_MATRIX_SAMPLES.map(({ uv }, index) => {
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.unlit(DISPLAY_MARKER_COLORS[DISPLAY_MATRIX_SAMPLES[index]?.color ?? 'red']),
    );
    return world
      .spawn(
        {
          component: Transform,
          data: {
            pos: sceneUvToWorldPosition(uv),
            quat: [0, 0, 0, 1],
            scale: [0.1, 0.1, 0.1],
          },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  });
  const camera = world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: BARREL_GPU_WIDTH / BARREL_GPU_HEIGHT,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_NONE,
          tonemap: TONEMAP_NONE,
          clearColor: [0.02, 0.02, 0.02, 1],
        },
      },
      {
        component: BarrelDistortion,
        data: { strength: 0.35, centerX: 0.31, centerY: 0.67 },
      },
    )
    .unwrap();
  return { camera, markers };
}

describe('barrel distortion display picking on Dawn', () => {
  it('feeds a GPU readback marker into public display picking', async () => {
    const fixture = await createBarrelRendererFixture();
    let releaseTransformSystems: (() => void) | undefined;
    try {
      const world = new World();
      const scene = spawnMarkerScene(world);
      const { marker } = scene;
      releaseTransformSystems = registerPropagateTransforms(world);
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

      // The display coordinate is located from the submitted GPU picture. The
      // test never derives its expected point with the CPU inverse mapping.
      const display = findGpuMarker(pixels, DISPLAY_MARKER_COLORS.red);
      expect(display, 'real Dawn readback did not contain the red GPU marker').toBeDefined();
      if (display === undefined)
        throw new Error('real Dawn readback did not contain the red GPU marker');
      const hit = pickDisplay(
        world,
        display.x,
        display.y,
        receipt.value.barrelDistortion,
        BARREL_GPU_WIDTH,
        BARREL_GPU_HEIGHT,
      );
      expect(hit?.entity).toBe(marker);
      expect(hit?.distance).toBeGreaterThan(0);
    } finally {
      releaseTransformSystems?.();
      await fixture.renderer.dispose();
    }
  });

  it('covers center, edge, corner, off-center, and crop-miss display picks', async () => {
    const fixture = await createBarrelRendererFixture();
    let releaseTransformSystems: (() => void) | undefined;
    try {
      const world = new World();
      const { markers } = spawnDisplayMatrixScene(world);
      releaseTransformSystems = registerPropagateTransforms(world);
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
      expect(
        Array.from({ length: BARREL_GPU_WIDTH * BARREL_GPU_HEIGHT }, (_, index) => {
          const offset = index * 4;
          return (pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0);
        }).some((luminance) => luminance > 100),
      ).toBe(true);

      const mapping = receipt.value.barrelDistortion;
      expect(mapping).toBeDefined();
      if (mapping === undefined) throw new Error('Dawn receipt did not publish display mapping');
      expect(mapping.centerX).toBeCloseTo(0.31, 6);
      expect(mapping.centerY).toBeCloseTo(0.67, 6);

      const matrixEvidence: Array<{
        readonly label: string;
        readonly visible: boolean;
        readonly picked: boolean;
        readonly gpuDisplay?: readonly [number, number];
        readonly gpuAlignmentPixels?: number;
        readonly display?: readonly [number, number];
      }> = [];
      for (const [index, sample] of DISPLAY_MATRIX_SAMPLES.entries()) {
        const sceneX = sample.uv[0] * BARREL_GPU_WIDTH;
        const sceneY = sample.uv[1] * BARREL_GPU_HEIGHT;
        const display = { x: 0, y: 0 };
        const visible = mapSceneToDisplay(display, mapping, sceneX, sceneY);
        if (sample.label === 'crop-miss') {
          expect(visible).toBe(false);
          expect(
            pickDisplay(
              world,
              0,
              BARREL_GPU_HEIGHT * 0.5,
              mapping,
              BARREL_GPU_WIDTH,
              BARREL_GPU_HEIGHT,
            ),
          ).toBeUndefined();
          matrixEvidence.push({ label: sample.label, visible: false, picked: false });
          continue;
        }

        expect(visible).toBe(true);
        const gpuDisplay = findGpuMarker(pixels, DISPLAY_MARKER_COLORS[sample.color]);
        expect(gpuDisplay, `${sample.label} GPU marker`).toBeDefined();
        if (gpuDisplay === undefined) throw new Error(`${sample.label} GPU marker missing`);
        const gpuAlignmentPixels = Math.hypot(gpuDisplay.x - display.x, gpuDisplay.y - display.y);
        expect(gpuAlignmentPixels, `${sample.label} GPU/CPU display alignment`).toBeLessThanOrEqual(
          1,
        );
        const roundTrip = { x: 0, y: 0 };
        expect(mapDisplayToScene(roundTrip, mapping, gpuDisplay.x, gpuDisplay.y)).toBe(true);
        expect(Math.hypot(roundTrip.x - sceneX, roundTrip.y - sceneY)).toBeLessThanOrEqual(1);
        const hit = pickDisplay(
          world,
          gpuDisplay.x,
          gpuDisplay.y,
          mapping,
          BARREL_GPU_WIDTH,
          BARREL_GPU_HEIGHT,
        );
        expect(hit?.entity, `${sample.label} display pick`).toBe(markers[index]);
        expect(hit?.distance).toBeGreaterThan(0);
        matrixEvidence.push({
          label: sample.label,
          visible: true,
          picked: hit?.entity === markers[index],
          gpuDisplay: [gpuDisplay.x, gpuDisplay.y],
          gpuAlignmentPixels,
          display: [display.x, display.y],
        });
      }
      // The matrix is intentionally compact: each row is a real receipt-bound
      // query against the rendered scene, with the crop row failing closed.
      // biome-ignore lint/suspicious/noConsole: structured Dawn evidence is intentional.
      console.info(
        `[barrel-distortion-display-pick-matrix] ${JSON.stringify({
          mapping: {
            width: mapping.width,
            height: mapping.height,
            strength: mapping.strength,
            centerX: mapping.centerX,
            centerY: mapping.centerY,
          },
          rows: matrixEvidence,
        })}`,
      );
    } finally {
      releaseTransformSystems?.();
      await fixture.renderer.dispose();
    }
  });
});
