import { Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { sceneValue } from './gi-scene-value.fixture';
import {
  channelMeans,
  roomAnalyticReference,
  roomPixels,
  SCENE_ROTATIONS,
  type SceneHarness,
  sceneGi,
  sceneHarness,
  twoRooms,
  visibleSupport,
} from './gi-scenes.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
function movingGi(mode: 'field' | 'screen'): ReturnType<typeof sceneGi> {
  const gi = sceneGi(mode, {
    environment: [0, 0, 0],
    probeSpacing: 0.5,
    raysPerProbe: 256,
    probeBudget: 4096,
  });
  const field = {
    ...gi.field,
    region: {
      ...gi.field.region,
      maxFieldBytes: 4 * 1024 * 1024,
      grid: {
        ...gi.field.region.grid,
        origin: [-5.5, -5.5, -6.5] as const,
        dimensions: [49, 45, 41] as const,
        spacing: 0.25,
      },
    },
  };
  return gi.gather === 'screen-probe'
    ? { ...gi, field, probes: { ...gi.probes, downsample: 4, maxFrames: 32 } }
    : { ...gi, field };
}

async function observeMove(h: SceneHarness, name: string) {
  const frames = [];
  for (let frame = 1; frame <= 64; frame++) {
    const image = await h.image(`${name}-${frame}`);
    frames.push({
      frame,
      left: channelMeans(image, roomPixels('left')),
      right: channelMeans(image, roomPixels('right')),
      maximumRight: [0, 1, 2].map((c) =>
        Math.max(...roomPixels('right').map((p) => sceneValue(image.rgb[p * 3 + c]))),
      ),
      visibleSupport: visibleSupport(image),
      inspection: h.renderer.inspect().diffuseGi,
    });
  }
  return frames;
}

for (const mode of ['field', 'screen'] as const) {
  it(`invalidates the same moving divider through open and closed transitions ${mode}`, {
    timeout: 900_000,
  }, async () => {
    const h = await sceneHarness(manifest, `moving-occluder-${mode}`);
    try {
      const room = await twoRooms(h, SCENE_ROTATIONS[0]);
      h.setGi(movingGi(mode));
      await h.settle(96);
      const initial = await h.image('initial-closed');
      h.world.set(room.divider, Transform, { pos: [5.5, 0, -1] }).unwrap();
      const opened = await observeMove(h, 'opened');
      h.world.set(room.divider, Transform, { pos: [0, 0, -1] }).unwrap();
      const closed = await observeMove(h, 'closed');
      const oracle = roomAnalyticReference('open');
      const expectedOpen = channelMeans(oracle, roomPixels('right'));
      h.save('reference-open.f32', new Uint8Array(oracle.rgb.buffer));
      h.save('result.json', {
        mode,
        sameEntity: room.divider,
        moves: [
          [5.5, 0, -1],
          [0, 0, -1],
        ],
        initialLeft: channelMeans(initial, roomPixels('left')),
        initialRight: channelMeans(initial, roomPixels('right')),
        opened,
        closed,
        expectedOpen,
        oracle:
          'The exact authored divider moves fully outside every emitter-to-ROI segment and returns. Independent finite-emitter integral supplies the opened steady value; complete closed divider blocks every source-to-right-ROI segment. Every completed frame after the World write is recorded without a settle/readiness reset.',
        tolerance: {
          finalOpenRelativeMean: 0.2,
          closedTailFractionOfLit: 0.02,
          tailFromFrame: 48,
          framesPerTransition: 64,
        },
      });
      for (const frame of [...opened, ...closed]) expect(frame.visibleSupport.missing).toBe(0);
      for (const frame of opened.slice(47))
        for (let c = 0; c < 3; c++)
          expect(
            Math.abs(sceneValue(frame.right[c]) - sceneValue(expectedOpen[c])) /
              sceneValue(expectedOpen[c]),
          ).toBeLessThan(0.2);
      for (const frame of closed.slice(47))
        for (let c = 0; c < 3; c++)
          expect(sceneValue(frame.maximumRight[c])).toBeLessThan(
            sceneValue(frame.left[c]) * 0.02 + 1e-4,
          );
      expect(h.errors).toEqual([]);
    } catch (error) {
      await h.recordFailure(error);
      throw error;
    } finally {
      await h.dispose();
    }
  });
}
