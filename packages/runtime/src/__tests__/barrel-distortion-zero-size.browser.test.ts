import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { ANTIALIAS_NONE, BarrelDistortion, Camera, TONEMAP_NONE } from '@forgeax/engine-render';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';

const WIDTH = 96;
const HEIGHT = 64;

it('keeps a zero-size surface out of the accepted barrel frame and resumes after restore', async ({
  onTestFailed,
}) => {
  const start = performance.now();
  const stages: Record<string, number> = {};
  const reached = (stage: string) => {
    stages[stage] = Math.round(performance.now() - start);
  };
  onTestFailed(() => {
    // biome-ignore lint/suspicious/noConsole: report the last reached real GPU stage on timeout.
    console.info('[barrel-zero-size]', JSON.stringify({ elapsedMs: stages }));
  });
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.style.width = `${WIDTH}px`;
  canvas.style.height = `${HEIGHT}px`;
  document.body.append(canvas);

  let renderer: Renderer | undefined;
  let lease: { dispose(): void } | undefined;
  let unsubscribe: (() => void) | undefined;
  const errors: string[] = [];
  try {
    const host = await constructRuntimeRendererHost(
      canvas,
      {},
      { shaderManifestUrl: '/shaders/manifest.json' },
    );
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    renderer = host.value.renderer;
    reached('rendererReady');
    unsubscribe = renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error.code);
    });

    const world = new World();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            aspect: WIDTH / HEIGHT,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_NONE,
            tonemap: TONEMAP_NONE,
            clearColor: [0.04, 0.04, 0.04, 1],
          },
        },
        {
          component: BarrelDistortion,
          data: { strength: 0.2, centerX: 0.5, centerY: 0.5 },
        },
      )
      .unwrap();
    const transforms = registerPropagateTransforms(world);
    try {
      const activeRenderer = renderer;
      const source = activeRenderer.attach(world).unwrap();
      lease = source;
      const draw = () => {
        world.update(1 / 60).unwrap();
        return activeRenderer.draw({ source, camera: { entityKey: camera } });
      };

      const baseline = draw();
      expect(baseline.ok).toBe(true);
      if (!baseline.ok) throw baseline.error;
      expect(baseline.value.barrelDistortion).toMatchObject({
        width: WIDTH,
        height: HEIGHT,
      });
      expect(baseline.value.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
      reached('baselineSubmitted');
      expect((await baseline.value.completed).ok).toBe(true);
      reached('baselineCompleted');

      canvas.width = 0;
      canvas.height = 0;
      const zeroSized = draw();
      expect(zeroSized.ok).toBe(false);
      if (!zeroSized.ok) {
        // biome-ignore lint/suspicious/noConsole: diagnostic for the real zero-size browser boundary.
        console.info(
          '[barrel-zero-size]',
          JSON.stringify({ width: canvas.width, height: canvas.height, error: zeroSized.error }),
        );
        expect(zeroSized.error.code).toBe('device-operation-failed');
        expect(zeroSized.error.detail).toMatchObject({
          operation: 'draw',
          cause: { code: 'rhi-not-available' },
        });
      }
      expect(renderer.inspect().barrelDistortion.effectiveMapping?.width).toBe(WIDTH);
      reached('zeroSizeRejected');

      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      const resumed = draw();
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) throw resumed.error;
      expect(resumed.value.barrelDistortion).toMatchObject({
        width: WIDTH,
        height: HEIGHT,
      });
      expect(resumed.value.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
      reached('restoredSubmitted');
      expect((await resumed.value.completed).ok).toBe(true);
      reached('restoredCompleted');
      expect(errors).toEqual([]);
    } finally {
      transforms();
    }
  } finally {
    unsubscribe?.();
    lease?.dispose();
    await renderer?.dispose();
    canvas.remove();
  }
});
