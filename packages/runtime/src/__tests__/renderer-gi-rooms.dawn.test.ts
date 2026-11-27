import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import {
  averageFrames,
  channelMeans,
  percentile,
  roomAnalyticReference,
  roomPixels,
  SCENE_ROTATIONS,
  type SceneHarness,
  type SceneImage,
  sceneGi,
  sceneHarness,
  sceneRotation,
  twoRooms,
  visibleSupport,
} from './gi-scenes.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const REFERENCE_SAMPLES = 512;
const ROOM_QUALITY = { raysPerProbe: 256, probeSpacing: 0.5, probeBudget: 4096 };
function roomGi(
  mode: 'field' | 'screen',
  rotation: (typeof SCENE_ROTATIONS)[number],
): ReturnType<typeof sceneGi> {
  const gi = sceneGi(mode, { ...ROOM_QUALITY, environment: [0, 0, 0] });
  // Enclose all author geometry after its rigid transform. Receiver masks
  // remain actual Renderer output. The 0.25 grid resolves the 0.25-wide emitter.
  const transform = sceneRotation(rotation);
  const corners = [-4, 4].flatMap((x) =>
    [-4, 4].flatMap((y) => [-5, 3].map((z) => transform.point([x, y, z]))),
  );
  const origin = [0, 1, 2].map(
    (c) => Math.floor(Math.min(...corners.map((p) => p[c] ?? NaN)) * 4) / 4 - 1.5,
  ) as [number, number, number];
  const dimensions = [0, 1, 2].map(
    (c) =>
      Math.ceil((Math.max(...corners.map((p) => p[c] ?? NaN)) + 1.5 - (origin[c] ?? NaN)) * 4) + 1,
  ) as [number, number, number];
  const field = {
    ...gi.field,
    region: {
      ...gi.field.region,
      maxFieldBytes: 4 * 1024 * 1024,
      grid: { ...gi.field.region.grid, origin, dimensions, spacing: 0.25 },
    },
  };
  return gi.gather === 'screen-probe'
    ? { ...gi, field, probes: { ...gi.probes, downsample: 4, maxFrames: 32 } }
    : { ...gi, field };
}
async function reference(h: SceneHarness, state: string) {
  const images: SceneImage[] = [];
  for (const seed of [17, 89]) {
    h.setGi({ gather: 'exact', maxBounces: 1, maxDistance: 100, seed, environment: [0, 0, 0] });
    await h.settle(0);
    images.push(await averageFrames(h, `${state}-reference-${seed}`, REFERENCE_SAMPLES));
  }
  const first = images[0],
    second = images[1];
  if (!first || !second) throw new Error('Both independent reference seeds are required');
  const image = {
    ...first,
    rgb: Float32Array.from(first.rgb, (v, i) => (v + (second.rgb[i] ?? NaN)) / 2),
  };
  h.save(`${state}-reference.f32`, new Uint8Array(image.rgb.buffer));
  return { image, seeds: images };
}

type RoomFailureTarget = { state: string; lane: 'exact' | 'field' | 'screen' };
async function reproduceRoomFailure(
  h: SceneHarness,
  room: Awaited<ReturnType<typeof twoRooms>>,
  divider: Awaited<ReturnType<typeof twoRooms>>['divider'] | undefined,
  target: RoomFailureTarget,
  rotation: (typeof SCENE_ROTATIONS)[number],
) {
  if (target.state === 'open' && divider !== undefined) {
    h.world.despawn(divider).unwrap();
    divider = undefined;
  }
  if (target.state === 'closed' && divider === undefined) divider = await room.restoreDivider();
  h.setGi(
    target.lane === 'exact'
      ? {
          gather: 'exact',
          maxBounces: 1,
          maxDistance: 100,
          seed: 47,
          environment: [0, 0, 0],
        }
      : roomGi(target.lane, rotation),
  );
  await h.settle(target.lane === 'exact' ? 0 : 96);
  h.save('failure-target.json', {
    ...target,
    note: 'Static reproduction after original measurement; original candidate/reference buffers retained separately.',
  });
}

for (const mode of ['field', 'screen'] as const)
  for (const rotation of [SCENE_ROTATIONS[0], SCENE_ROTATIONS[3]]) {
    it(`renders an offscreen colored source across a closed and opened divider ${mode}/${rotation.name}`, {
      timeout: 900_000,
    }, async () => {
      const h = await sceneHarness(manifest, `rooms-${mode}-${rotation.name}`);
      let room: Awaited<ReturnType<typeof twoRooms>> | undefined;
      let divider: Awaited<ReturnType<typeof twoRooms>>['divider'] | undefined;
      let failureTarget: RoomFailureTarget | undefined;
      try {
        room = await twoRooms(h, rotation);
        divider = room.divider;
        h.setGi(undefined);
        for (let i = 0; i < 4; i++) await h.draw();
        await h.image('direct');
        const quality = roomGi(mode, rotation);
        h.setGi(quality);
        await h.settle(96);
        const closed = await averageFrames(h, 'closed-gi', 8);
        h.world.despawn(room.divider).unwrap();
        divider = undefined;
        const timeline = [];
        for (let frame = 0; frame <= 64; frame++) {
          if ([0, 1, 2, 4, 8, 16, 32, 64].includes(frame)) {
            const sample = await h.image(`opening-${frame}`);
            timeline.push({
              frame: frame + 1,
              left: channelMeans(sample, roomPixels('left')),
              right: channelMeans(sample, roomPixels('right')),
            });
          } else await h.draw();
        }
        const open = await averageFrames(h, 'open-gi', 8);
        const openReference = await reference(h, 'open');
        divider = await room.restoreDivider();
        const closedReference = await reference(h, 'closed');
        const analytic = {
          closed: roomAnalyticReference('closed'),
          open: roomAnalyticReference('open'),
        };
        for (const state of ['closed', 'open'] as const)
          h.save(`${state}-analytic.f32`, new Uint8Array(analytic[state].rgb.buffer));
        const results = [];
        for (const [state, actual, truth] of [
          ['closed', closed, closedReference],
          ['open', open, openReference],
        ] as const)
          for (const side of ['left', 'right'] as const) {
            const pixels = roomPixels(side);
            const observed = channelMeans(actual, pixels);
            const expected = channelMeans(analytic[state], pixels);
            const sampledMean = channelMeans(truth.image, pixels);
            const referenceAnalyticDisagreement = sampledMean.map((v, c) =>
              Math.abs(v - (expected[c] ?? NaN)),
            );
            const referencePixelP95 = expected.map((mean, c) =>
              percentile(
                pixels.map(
                  (p) =>
                    Math.abs(
                      (truth.image.rgb[p * 3 + c] ?? NaN) - (analytic[state].rgb[p * 3 + c] ?? NaN),
                    ) / Math.max(mean, 0.005),
                ),
                0.95,
              ),
            );
            const a = truth.seeds[0],
              b = truth.seeds[1];
            if (!a || !b) throw new Error('Missing reference seed');
            const referenceDisagreement = channelMeans(a, pixels).map((v, c) =>
              Math.abs(v - (channelMeans(b, pixels)[c] ?? NaN)),
            );
            const relativeMean = observed.map(
              (v, c) => Math.abs(v - (expected[c] ?? NaN)) / Math.max(expected[c] ?? NaN, 0.005),
            );
            const pixelP95 = expected.map((mean, c) =>
              percentile(
                pixels.map(
                  (p) =>
                    Math.abs(
                      (actual.rgb[p * 3 + c] ?? NaN) - (analytic[state].rgb[p * 3 + c] ?? NaN),
                    ) / Math.max(mean, 0.005),
                ),
                0.95,
              ),
            );
            const unsupportedFraction =
              pixels.filter((p) => !((actual.support?.[p] ?? NaN) > 0.99)).length / pixels.length;
            results.push({
              state,
              side,
              pixels: pixels.length,
              observed,
              expected,
              sampledMean,
              referenceDisagreement,
              referenceAnalyticDisagreement,
              referencePixelP95,
              relativeMean,
              pixelP95,
              unsupportedFraction,
            });
          }
        h.save('result.json', {
          mode,
          rotation,
          referenceSamplesPerSeed: REFERENCE_SAMPLES,
          quality,
          visibleSupport: { closed: visibleSupport(closed), open: visibleSupport(open) },
          oracle:
            'Deterministic polygon form-factor integral on independent back-wall ROIs; exact triangle one-bounce Renderer with two seeds cross-checks the integral mean; no SDF/Card/probe reads',
          tolerance: {
            referenceSeedRelative: 0.03,
            litChannelRelativeMean: 0.2,
            litPixelP95: 0.4,
            closedMeanLeak: 0.02,
            closedP95Leak: 0.05,
          },
          results,
          timeline,
        });
        for (const [state, image] of [
          ['closed', closed],
          ['open', open],
        ] as const) {
          failureTarget = { state, lane: mode };
          expect(visibleSupport(image).missing).toBe(0);
        }
        // Evaluate only after retaining EVERY image and diagnostic, including failures.
        for (const result of results) {
          failureTarget = { state: result.state, lane: mode };
          expect(result.unsupportedFraction).toBe(0);
          for (let c = 0; c < 3; c++) {
            const expected = result.expected[c] ?? NaN;
            failureTarget = { state: result.state, lane: 'exact' };
            if (result.state === 'closed' && result.side === 'right') {
              expect(expected).toBeLessThan(1e-5);
              failureTarget = { state: result.state, lane: mode };
              const lit = channelMeans(closed, roomPixels('left'))[c] ?? NaN;
              expect(lit).toBeGreaterThan(0.005);
              expect(result.observed[c]).toBeLessThan(0.02 * lit + 1e-4);
              expect(
                percentile(
                  roomPixels('right').map((p) => closed.rgb[p * 3 + c] ?? NaN),
                  0.95,
                ),
              ).toBeLessThan(0.05 * lit + 1e-4);
            } else {
              expect(expected).toBeGreaterThan(0.005);
              expect(result.referenceDisagreement[c]).toBeLessThan(0.03 * expected);
              expect(result.referenceAnalyticDisagreement[c]).toBeLessThan(0.03 * expected);
              failureTarget = { state: result.state, lane: mode };
              expect(result.relativeMean[c]).toBeLessThan(0.2);
              expect(result.pixelP95[c]).toBeLessThan(0.4);
            }
          }
        }
        expect(h.errors).toEqual([]);
      } catch (error) {
        // The reference was rendered after the candidate. Reproduce the failed
        // STATIC lane/state before capture; never label the reference as the
        // failing gather frame. Original measured bytes remain untouched.
        if (failureTarget && room) {
          await reproduceRoomFailure(h, room, divider, failureTarget, rotation);
        }
        await h.recordFailure(error);
        throw error;
      } finally {
        try {
          await h.dispose();
        } finally {
          expect.soft(h.errors).toEqual([]);
        }
      }
    });
  }
