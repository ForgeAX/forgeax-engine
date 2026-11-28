import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { tsrFeedback as createFeedback } from './tsr-feedback';
import { verifyTsrFlickerLuma } from './tsr-flicker-luma.fixture';
import { verifyTsrGeometry } from './tsr-geometry.fixture';
import { verifyTsrResolve } from './tsr-resolve.fixture';
import { verifyTsrSpatial } from './tsr-spatial.fixture';

// A rejected pixel keeps only its current-frame weight, at most 1/16 of the UE history sample count
// (TemporalSuperResolution.cpp:3220-3221), stored in 8 bits rounded up (TSRUpdateHistory.usf:1300).
const REJECTED_VALIDITY = 17 / 255 + 1e-3;

export function registerTsrFeedbackCases(
  backend: Pick<typeof webgpu, 'rhi' | 'createShaderModuleImmediate'> = webgpu,
  execution: 'compute' | 'raster' = 'compute',
) {
  const { rhi, createShaderModuleImmediate } = backend;
  const tsrFeedback = (...args: Parameters<typeof createFeedback>) =>
    createFeedback(args[0], args[1], args[2], args[3], args[4], execution, args[6]);
  it('preserves coverage halos at f32 phase boundaries in non-power-of-two extents', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    await verifyTsrGeometry(
      device,
      (d) => createShaderModuleImmediate(device, d),
      'rounding',
      execution,
    );
  });

  it('preserves two-dimensional geometry identity, rejection and edge support in partial groups', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    await verifyTsrGeometry(
      device,
      (d) => createShaderModuleImmediate(device, d),
      'partial',
      execution,
    );
  });

  it('reprojects the persistent snapshot guide through ClipToResurrectionClip (UE DecimateHistory resurrection)', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
    try {
      rig.uploadResurrectionGuide([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
      // Shift the snapshot one NDC unit right: x' = x + w, so pixel 0 sees pixel 1 and pixel 1
      // leaves the snapshot screen.
      const shift = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1];
      rig.draw([1, 1, 1, 1, 1, 1, 1, 1], { clipToResurrectionClip: shift });
      const out = await rig.read(rig.stages.resurrected);
      expect(out.slice(0, 4)).toEqual([
        expect.closeTo(0.5, 2),
        expect.closeTo(0.6, 2),
        expect.closeTo(0.7, 2),
        expect.closeTo(0.8, 2),
      ]);
      expect(out.slice(4, 8)).toEqual([0, 0, 0, -1]);
      // A pixel without depth has no surface to reproject.
      rig.draw([1, 1, 1, 1, 1, 1, 1, 1], {
        clipToResurrectionClip: shift,
        temporalPixels: [0, 0, -1, 1, 0, 0, -1, 1],
      });
      expect((await rig.read(rig.stages.resurrected)).filter((_, i) => i % 4 === 3)).toEqual([
        -1, -1,
      ]);
    } finally {
      rig.dispose();
    }
  });

  it('resurrects the snapshot guide only where it explains the input better than the history (UE RejectShading resurrection)', async () => {
    // TSRRejectShading.usf:263-281 closeness, :762-790 measure and decide, :880-882 bit mask.
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const bright = [4, 4, 4, 1, 4, 4, 4, 1];
    const gray = [0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 1];
    // The decision mask after settling on gray history, then a jump to bright input.
    const jump = async (snapshot: 'bright' | 'gray', resurrection: boolean) => {
      const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
      try {
        rig.draw(bright);
        const brightGuide = await rig.read(rig.stages.inputGcs);
        rig.uploadResurrectionGuide(snapshot === 'bright' ? brightGuide : [...gray]);
        for (let i = 0; i < 4; i++) rig.draw(gray);
        rig.draw(bright, resurrection ? { clipToResurrectionClip: identity } : {});
        const decision = await rig.read(rig.stages.decision);
        return [Math.round((decision[3] ?? 0) * 255), Math.round((decision[7] ?? 0) * 255)];
      } finally {
        rig.dispose();
      }
    };
    // The bright snapshot matches the input where the gray history does not: bit 1 is set.
    for (const mask of await jump('bright', true)) expect(mask & 2).toBe(2);
    // Without a snapshot source, or when the snapshot is no closer than the history, nothing is resurrected.
    for (const mask of await jump('bright', false)) expect(mask & 2).toBe(0);
    for (const mask of await jump('gray', true)) expect(mask & 2).toBe(0);
  });

  it('reconstructs a resurrected pixel from the snapshot color and stability (UE UpdateHistory resurrected slice)', async () => {
    // TSRUpdateHistory.usf:849 reads the resurrect bit, :982-983 fetch the resurrected slice,
    // :1093 and :1160 exempt a resurrection from the disocclusion handling.
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const bright = [4, 4, 4, 1, 4, 4, 4, 1];
    const gray = [0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 1];
    // The stability of the first frame after a jump to bright, given the snapshot validity.
    const jump = async (validity: number, resurrection: boolean) => {
      const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
      try {
        rig.draw(bright);
        rig.uploadResurrectionGuide(await rig.read(rig.stages.inputGcs));
        rig.uploadResurrectionHistory(
          [...bright, ...bright],
          Array(4).fill([validity, 0, 0, 1]).flat(),
        );
        for (let i = 0; i < 4; i++) rig.draw(gray);
        const frame = rig.draw(bright, resurrection ? { clipToResurrectionClip: identity } : {});
        const decision = await rig.read(rig.stages.decision);
        const stability = await rig.read(frame.metadata, 1);
        return {
          resurrected: (Math.round((decision[3] ?? 0) * 255) & 2) !== 0,
          validity: stability[0] ?? Number.NaN,
        };
      } finally {
        rig.dispose();
      }
    };
    const trusted = await jump(1, true);
    const empty = await jump(0, true);
    const unused = await jump(1, false);
    expect([trusted.resurrected, empty.resurrected, unused.resurrected]).toEqual([
      true,
      true,
      false,
    ]);
    // The history validity comes from the snapshot, not from the ordinary history.
    expect(trusted.validity).toBeGreaterThan(0.5);
    expect(empty.validity).toBeLessThan(0.2);
    expect(unused.validity).toBeLessThan(0.5);
  });

  it('rebuilds history confidence faster on a returning scene when the snapshot is resurrected (UE resurrection purpose)', async () => {
    // Converge on bright (A), settle on gray (B), return to A. The ordinary history rejects the jump
    // and restarts its sample count; the resurrected snapshot of A carries its converged validity.
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const bright = [4, 4, 4, 1, 4, 4, 4, 1];
    const gray = [0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 1];
    const returning = async (resurrection: boolean) => {
      const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
      try {
        for (let i = 0; i < 6; i++) rig.draw(bright);
        rig.uploadResurrectionGuide(await rig.read(rig.stages.inputGcs));
        rig.uploadResurrectionHistory([...bright, ...bright], Array(4).fill([1, 0, 0, 1]).flat());
        for (let i = 0; i < 4; i++) rig.draw(gray);
        const options = resurrection ? { clipToResurrectionClip: identity } : {};
        const validity: number[] = [];
        let color = Number.NaN;
        for (let i = 0; i < 3; i++) {
          const frame = rig.draw(bright, options);
          validity.push((await rig.read(frame.metadata, 1))[0] ?? Number.NaN);
          color = (await rig.read(frame.color))[0] ?? Number.NaN;
        }
        return { validity, color };
      } finally {
        rig.dispose();
      }
    };
    const resurrected = await returning(true);
    const ordinary = await returning(false);
    for (let i = 0; i < 3; i++)
      expect(resurrected.validity[i] ?? 0).toBeGreaterThan((ordinary.validity[i] ?? 1) + 0.1);
    // Both land on the returning scene; resurrection must not distort it.
    expect(resurrected.color).toBeCloseTo(4, 1);
    expect(ordinary.color).toBeCloseTo(4, 0);
  });

  it('extrudes the history behind a moving occluder into its disocclusion (UE hole filling)', async () => {
    // TSRClosestOccluder.ush:300-327 and TSRDecimateHistory.usf:435-472: a parallax disoccluded pixel is
    // reprojected with the velocity of the closest surface that covered its previous position.
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const colors = (pixel: (x: number) => number[]) =>
      Array.from({ length: 16 }, (_, x) => pixel(x)).flat();
    const bright = colors((x) => (x >= 4 && x < 8 ? [4, 4, 4, 1] : [0.5, 0.5, 0.5, 1]));
    const gray = colors(() => [0.5, 0.5, 0.5, 1]);
    // A near surface covers pixels 4-7 and, one frame later, 6-9: it moves right two pixels (uv 1/8)
    // and uncovers the static far surface at pixels 4-5.
    const surface = (x0: number, motion: number) =>
      Array.from({ length: 16 }, (_, x) =>
        x >= x0 && x < x0 + 4 ? [motion, 0, 1, 0] : [0, 0, 2, 0],
      ).flat();
    const uncovered = async (occluderMotion: number) => {
      const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d), 16, 32);
      try {
        rig.draw(bright, { temporalPixels: surface(4, occluderMotion) });
        rig.draw(gray, { temporalPixels: surface(6, 0.125) });
        const history = await rig.read(rig.stages.historyGcs);
        return history[4 * 4] ?? Number.NaN;
      } finally {
        rig.dispose();
      }
    };
    const filled = await uncovered(0.125);
    const still = await uncovered(0);
    // The extruded history is the far surface left of the occluder; without a known occluder velocity
    // the pixel keeps reading the occluder itself.
    expect(still).toBeGreaterThan(filled + 0.05);
  });

  it('keeps the history clamp on a velocity edge (UE DilateVelocity and DecimateHistory)', async () => {
    // TSRDilateVelocity.usf:229-249 borrows the closest neighbour's velocity; ComputeReprojectionEdge
    // (TSRDepthVelocityAnalysis.ush:550-557) and its 3x3 form (:560-607, TSRDecimateHistory.usf:316-333)
    // turn a one pixel velocity step into VelocityEdge 0; TSRRejectShading.usf:899-901 limits
    // DisableHistoryClamp by that uncertainty.
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d), 8, 16);
    try {
      const gray = Array.from({ length: 8 }, () => [0.5, 0.5, 0.5, 1]).flat();
      // Pixels 0-3 are a static far surface (log depth 2); pixels 4-7 a nearer one (log depth 1)
      // moving one input pixel (uv 1/8) per frame.
      const temporalPixels = Array.from({ length: 8 }, (_, x) =>
        x < 4 ? [0, 0, 2, 0] : [0.125, 0, 1, 0],
      ).flat();
      rig.draw(gray, { temporalPixels });
      rig.draw(gray, { temporalPixels });
      const edge = await rig.read(rig.stages.decimate);
      const decision = await rig.read(rig.stages.decision);
      const velocityEdge = (x: number) => edge[x * 4] ?? Number.NaN;
      // Pixel 3 sits behind the near surface: it borrows its velocity and lies on the edge.
      expect(velocityEdge(3)).toBeLessThan(0.1);
      for (const x of [0, 1, 2, 4, 5, 6, 7]) expect(velocityEdge(x)).toBeGreaterThan(0.9);
      expect(decision[3 * 4 + 1] ?? Number.NaN).toBeLessThan(0.1);
      expect(decision[1 * 4 + 1] ?? Number.NaN).toBeGreaterThan(0.5);
    } finally {
      rig.dispose();
    }
  });

  it('carries the reprojected history uncertainty into a disocclusion (UE DecimateHistory)', async () => {
    // TSRDecimateHistory.usf:498-501 writes ReprojectedHistoryGuideUncertainty for every pixel; only
    // the disoccluded pixel's own clamp relief is dropped (TSRRejectShading.usf:863). A zeroed value
    // would reach its neighbours through Min3x3(HistoryUncertainty) and keep their clamp.
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d), 16, 32);
    try {
      const gray = Array.from({ length: 16 }, () => [0.5, 0.5, 0.5, 1]).flat();
      // A moving near surface covers pixels 4-7, then uncovers the static far surface.
      const near = Array.from({ length: 16 }, (_, x) =>
        x >= 4 && x < 8 ? [0.125, 0, 1, 0] : [0, 0, 2, 0],
      ).flat();
      const far = Array.from({ length: 16 }, () => [0, 0, 2, 0]).flat();
      rig.draw(gray, { temporalPixels: near });
      rig.draw(gray, { temporalPixels: far });
      const history = await rig.read(rig.stages.historyGcs);
      const decimate = await rig.read(rig.stages.decimate);
      // Pixel 5 is disoccluded by relative parallax, yet its history uncertainty is last frame's certain interior.
      expect(history[5 * 4 + 3] ?? Number.NaN).toBeLessThan(0.5);
      expect(decimate[5 * 4 + 1] ?? Number.NaN).toBeGreaterThan(0.9);
      // UE TSRClosestOccluder.ush:300-328: a static depth step with matching screen velocity is
      // subpixel silhouette jitter, not parallax disocclusion, so history stays accepted.
      const staticNear = Array.from({ length: 16 }, (_, x) =>
        x >= 4 && x < 8 ? [0, 0, 1, 0] : [0, 0, 2, 0],
      ).flat();
      rig.draw(gray, { temporalPixels: staticNear });
      rig.draw(gray, { temporalPixels: far });
      const staticHistory = await rig.read(rig.stages.historyGcs);
      expect(staticHistory[5 * 4 + 3] ?? Number.NaN).toBeGreaterThan(0.5);
    } finally {
      rig.dispose();
    }
  });

  it('moves the end of a one pixel staircase toward its edge and reports noise (UE SpatialAntiAliasing)', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    await verifyTsrSpatial(device, (d) => createShaderModuleImmediate(device, d), execution);
  });

  it('measures flickering luma as UE SMCS-to-GCS of the mean channel (UE MeasureFlickeringLuma)', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    await verifyTsrFlickerLuma(device, (d) => createShaderModuleImmediate(device, d), execution);
  });

  it('downsamples a 2x history with the UE Mitchell-Netravali kernel (UE ResolveHistory)', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    await verifyTsrResolve(device, (d) => createShaderModuleImmediate(device, d), execution);
  });

  it('reconstructs rejected input below output resolution instead of nearest-texel blocks', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
    try {
      const frame = rig.draw([1, 0, 0, 1, 0, 0, 1, 1]);
      const pixels = await rig.read(frame.color);
      expect(pixels[4]).toBeGreaterThan(0.5);
      expect(pixels[4]).toBeLessThan(1);
      expect(pixels[6]).toBeGreaterThan(0);
      expect(pixels[6]).toBeLessThan(0.5);
      expect(pixels[7]).toBe(1);
    } finally {
      rig.dispose();
    }
  });

  it('filters the current frame with the five-tap kernel, its UE sample weights and the exposed HdrWeight', async () => {
    // UE 5.8.1 TSRUpdateHistory.usf:301-348 PLUS_MOVE_FAR taps, TSRKernels.ush:438-446 weights,
    // usf:1216 ToneWeight = HdrWeight4 (TSRColorSpace.ush:166-219) of the exposed tap.
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const input = [
      [1, 0.5, 0.25],
      [3, 2, 1],
    ] as const;
    const weight = (dx: number, dy: number) => {
      const x2 = Math.min(1, dx * dx + dy * dy);
      return Math.min(1, Math.max(0, (0.9 * x2 - 1.9) * x2 + 1.005));
    };
    const hdr = (value: readonly number[], exposure: number) =>
      1 / (((value[0] ?? 0) + 2 * (value[1] ?? 0) + (value[2] ?? 0)) * exposure + 4);
    const results: number[][] = [];
    for (const exposure of [1, 16]) {
      // A fresh rig per exposure: the first frame has no history.
      const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
      try {
        const frame = rig.draw([...input[0], 1, ...input[1], 1], { exposure });
        const pixels = await rig.read(frame.color);
        results.push(Array.from(pixels.slice(4, 7)));
        for (let out = 0; out < 4; out++) {
          const source = Math.floor(out / 2);
          // Output pixel centers sit at +-0.25 input pixels from the source center; one input row.
          const dx = out % 2 === 0 ? -0.25 : 0.25;
          const toward = dx < 0 ? -1 : 1;
          // |dKO.x| = 0.25 selects the far-move taps on x; dKO.y = 0 keeps the near tap on y.
          const taps = [
            [0, 0],
            [toward, 0],
            [0, 1],
            [toward, 1],
            [0, -1],
          ] as const;
          const sum = [0, 0, 0];
          let total = 0;
          for (const [ox, oy] of taps) {
            const value = input[Math.max(0, Math.min(1, source + ox))] as readonly number[];
            const w = weight(ox - dx, oy) * hdr(value, exposure);
            total += w;
            for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + w * (value[c] ?? 0);
          }
          for (let c = 0; c < 3; c++)
            expect(pixels[out * 4 + c], `output ${out} channel ${c}`).toBeCloseTo(
              (sum[c] ?? 0) / total,
              2,
            );
        }
      } finally {
        rig.dispose();
      }
    }
    // Output 1 mixes both inputs; a higher exposure weighs the brighter tap less, so it moves to the dark one.
    expect(results[1]?.[0] ?? NaN).toBeLessThan(results[0]?.[0] ?? NaN);
  });

  it('accumulates history validity as 1/(n+1) blend weights up to the 16 sample UE history', async () => {
    // UE 5.8.1 TSRUpdateHistory.usf:1164-1168, 1282-1300; r.TSR.History.SampleCount 16.
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
    const white = [4, 2, 1, 0.5, 4, 2, 1, 0.5];
    try {
      const validity: number[] = [];
      for (let i = 0; i < 40; i++) {
        const frame = rig.draw(white);
        validity.push((await rig.read(frame.metadata, 1))[0] ?? NaN);
      }
      // A fresh pixel carries one current-frame weight, at most 1/16 (usf:1166).
      expect(validity[0]).toBeGreaterThan(0.03);
      expect(validity[0]).toBeLessThanOrEqual(REJECTED_VALIDITY);
      // Every accepted frame adds one aligned current-frame weight of at most 1/16.
      for (let n = 1; n < validity.length; n++) {
        const step = (validity[n] ?? NaN) - (validity[n - 1] ?? NaN);
        expect(step, `validity ${validity.slice(0, 8)}`).toBeGreaterThanOrEqual(0);
        expect(step).toBeLessThanOrEqual(1 / 16 + 2 / 255);
      }
      for (let n = 1; n < 5; n++)
        expect(validity[n]).toBeGreaterThan((validity[n - 1] ?? 0) + 0.02);
      // The history saturates at full validity: it holds no more than the 16 sample UE history.
      expect(validity[39]).toBeGreaterThan(0.95);
      expect(validity[39]).toBeLessThanOrEqual(1);
    } finally {
      rig.dispose();
    }
  });

  it('clamps history to the min and max of the five kernel taps, not the full 3x3 neighborhood', async () => {
    // UE 5.8.1 TSRUpdateHistory.usf:1206-1258. Output pixel 0 sits left of input pixel 0, so all of
    // its taps are input pixel 0; input pixel 1 lies outside its clamp box. The clamp is blended out by
    // DisableHistoryClamp (ShadingAnalysis.ush:630-643), so a 100 -> 1 step keeps a small residue.
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
    try {
      for (let i = 0; i < 40; i++) rig.draw([100, 100, 100, 1, 100, 100, 100, 1]);
      const frame = rig.draw([1, 1, 1, 1, 100, 100, 100, 1]);
      const pixels = await rig.read(frame.color);
      expect(pixels[0]).toBeLessThan(20);
      // Output pixel 1 reaches input pixel 1, so its box still admits the history and it stays above
      // pixel 0, whose box excludes it. The Karis HdrWeight (usf:1284-1312) trusts the dark input
      // over a bright history, so the residue is small in absolute terms.
      expect(pixels[4]).toBeGreaterThan((pixels[0] ?? 0) * 1.5);
    } finally {
      rig.dispose();
    }
  });

  it('retains linear HDR and alpha, grows support, and rejects depth, material and secondary changes', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
    const white = [4, 2, 1, 0.5, 4, 2, 1, 0.5],
      black = [0, 0, 0, 0.5, 0, 0, 0, 0.5];
    try {
      let frame = rig.draw(white);
      for (let i = 1; i < 60; i++) frame = rig.draw(white);
      expect((await rig.read(frame.color)).slice(0, 4)).toEqual([4, 2, 1, 0.5]);
      expect((await rig.read(frame.metadata, 1))[0]).toBeGreaterThan(0.4);
      for (const options of [
        { depth: 3 },
        { reactive: 1 },
        { reactive: 2 },
        { secondary: 1 },
        { motion: 2 },
        { reset: true },
      ]) {
        for (let i = 0; i < 16; i++) rig.draw(white);
        frame = rig.draw(black, options);
        const values = await rig.read(frame.color);
        expect(values.filter((_, i) => i % 4 !== 3).every((v) => v === 0)).toBe(true);
        expect(values[3]).toBe(0.5);
        expect((await rig.read(frame.metadata, 1))[0]).toBeLessThanOrEqual(REJECTED_VALIDITY);
      }
    } finally {
      rig.dispose();
    }
  });

  it('consumes unfilterable R32F secondary reactivity without float32-filterable', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice({ requiredFeatures: [] })).unwrap();
    const rig = tsrFeedback(
      device,
      (d) => createShaderModuleImmediate(device, d),
      2,
      4,
      'compact',
      execution,
      'r32float',
    );
    const white = [4, 2, 1, 0.5, 4, 2, 1, 0.5],
      black = [0, 0, 0, 0.5, 0, 0, 0, 0.5];
    try {
      let frame = rig.draw(white);
      for (let i = 1; i < 60; i++) frame = rig.draw(white);
      expect((await rig.read(frame.metadata))[0]).toBeGreaterThan(0.4);
      frame = rig.draw(black, { secondary: 1 });
      expect((await rig.read(frame.color)).slice(0, 4)).toEqual([0, 0, 0, 0.5]);
      expect((await rig.read(frame.metadata))[0]).toBeLessThanOrEqual(REJECTED_VALIDITY);
    } finally {
      rig.dispose();
    }
  });

  it('settles a persistent unmarked HDR shading change within one jitter cycle', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
    try {
      // A display-visible change is rejected by MeasureRejection (UE 5.8.1 TSRShadingAnalysis.ush:622-643)
      // and replaces the guide at once, so the output settles within one jitter cycle.
      const settle = async (low: number, high: number) => {
        for (let i = 0; i < 60; i++) rig.draw([low, low, low, 1, low, low, low, 1]);
        let frame = rig.draw([high, high, high, 1, high, high, high, 1]);
        for (let i = 1; i < 8; i++) frame = rig.draw([high, high, high, 1, high, high, high, 1]);
        return (await rig.read(frame.color))[0] ?? NaN;
      };
      expect(await settle(1, 2)).toBeGreaterThan(1.98);
      // 100 -> 200 differs by less than the LDR quantization error in the shading space (SMCS), so UE
      // keeps the history clamp relaxed (usf:1256-1258) and converges at the accumulation rate instead.
      expect(await settle(100, 200)).toBeGreaterThan(180);
    } finally {
      rig.dispose();
    }
  });

  it('reduces bounded stationary oscillation with the UE moire error and ignores post-opaque changes', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const normal = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
    // UE r.TSR.ShadingRejection.Flickering=0: the moire error never widens the clamp box.
    const disabled = tsrFeedback(device, (d) =>
      createShaderModuleImmediate(device, {
        ...d,
        code: d.code.replace(
          'vec4<f32>(saturate(error * isStatic - modification), 0.0, 0.0, 0.0)',
          'vec4<f32>(0.0)',
        ),
      }),
    );
    const tail: number[] = [],
      control: number[] = [];
    const pixels = (v: number) => [v, v, v, 1, v, v, v, 1];
    try {
      for (let i = 0; i < 96; i++) {
        const input = pixels(i % 2 === 0 ? 0.8 : 1.2);
        const a = normal.draw(input),
          b = disabled.draw(input);
        if (i >= 80) {
          tail.push((await normal.read(a.color))[0] ?? NaN);
          control.push((await disabled.read(b.color))[0] ?? NaN);
        }
      }
      const variance = (a: number[]) => {
        const mean = a.reduce((s, v) => s + v, 0) / a.length;
        return a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length;
      };
      // Freeze a 25% reduction before observing the implementation result.
      expect(variance(tail)).toBeLessThan(variance(control) * 0.75);
      expect((await normal.read(normal.stages.moireError))[0]).toBeGreaterThan(0);
      // A final color that differs from the opaque scene color (translucency, fog, post) is not
      // flicker: UE removes that luma from the moire error (TSRShadingAnalysis.ush:253-259).
      normal.draw(pixels(0.8), { opaquePixels: pixels(0) });
      for (let i = 1; i < 16; i++)
        normal.draw(pixels(i % 2 === 0 ? 0.8 : 1.2), { opaquePixels: pixels(0) });
      expect((await normal.read(normal.stages.moireError))[0]).toBe(0);
      const changed = normal.draw(pixels(0), { reactive: 1 });
      expect((await normal.read(changed.color)).slice(0, 3)).toEqual([0, 0, 0]);
    } finally {
      normal.dispose();
      disabled.dispose();
    }
  });

  it('keeps a constant input free of moire error and stores its flicker luma as history', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
    const pixels = (v: number) => [v, v, v, 1, v, v, v, 1];
    try {
      let frame = rig.draw(pixels(1));
      for (let i = 1; i < 24; i++) frame = rig.draw(pixels(1));
      // UE MeasureFlickeringLuma of a gray 1 is GCS(1) = 1 / (1 + 0.17) (TSRColorSpace.ush:29-35).
      expect((await rig.read(frame.moire))[0]).toBeCloseTo(1 / 1.17, 2);
      expect((await rig.read(rig.stages.moireError))[0]).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('bounds compact-history error against the same GPU algorithm with FP16 analysis and support', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const compile = (d: Parameters<typeof createShaderModuleImmediate>[1]) =>
      createShaderModuleImmediate(device, d);
    const compact = tsrFeedback(device, compile),
      reference = tsrFeedback(device, compile, 2, 4, 'fp16');
    const errors: number[] = [],
      sample = (v: number) => [v, v * 0.75, v * 0.25, 0.5, v, v * 0.75, v * 0.25, 0.5];
    try {
      for (let i = 0; i < 160; i++) {
        const input = sample(i < 128 ? (i % 2 === 0 ? 0.8 : 1.2) : 100);
        const a = compact.draw(input),
          b = reference.draw(input);
        if (i >= 96) {
          const av = await compact.read(a.color),
            bv = await reference.read(b.color);
          for (let lane = 0; lane < 3; lane++)
            errors.push(
              Math.abs((av[lane] ?? NaN) - (bv[lane] ?? NaN)) / Math.max(1, bv[lane] ?? 1),
            );
          expect(av[3]).toBe(0.5);
          expect(bv[3]).toBe(0.5);
        }
      }
      // Compression may change local rejection, but cannot bias this frozen
      // oscillation/HDR transition sequence by more than 2% on average.
      expect(errors.reduce((s, v) => s + v, 0) / errors.length).toBeLessThan(0.02);
      expect(Math.max(...errors)).toBeLessThan(0.08);
    } finally {
      compact.dispose();
      reference.dispose();
    }
  });

  it('lets the moire error fade after the oscillation stops, including low frame rates', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d));
    const pixels = (v: number) => [v, v, v, 1, v, v, v, 1];
    try {
      for (const hz of [60, 20]) {
        const options = { deltaSeconds: 1 / hz };
        // Uneven plateaus exercise direction changes, rather than a two-level toggle only.
        for (let i = 0; i < 96; i++) rig.draw(pixels([0.8, 0.8, 1.2, 1.0][i % 4] ?? 1), options);
        const oscillating = (await rig.read(rig.stages.moireError))[0] ?? NaN;
        let frame = rig.draw(pixels(4), options);
        for (let i = 1; i < 8; i++) frame = rig.draw(pixels(4), options);
        // A real change converges to the new level within eight frames (the history started near 1.0)
        // at the accumulation rate, slowed by the Karis HdrWeight of the brighter input (usf:1284-1312).
        // Dawn reaches 3.4+, the WebGL2 raster lane 3.39 (fp16 target rounding); the bound keeps over three quarters of the 1 -> 4 step.
        expect((await rig.read(frame.color))[0]).toBeGreaterThan(3.3);
        expect((await rig.read(rig.stages.moireError))[0] ?? NaN).toBeLessThanOrEqual(oscillating);
        // A disoccluded pixel discards the moire history immediately (usf:455-458).
        frame = rig.draw(pixels(0.8), { ...options, reset: true });
        expect((await rig.read(frame.moire))[3]).toBe(0);
      }
    } finally {
      rig.dispose();
    }
  });

  it('pulls moving history with the Engine motion sign and falsifies the opposite sign', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const normal = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d), 8, 8);
    const wrong = tsrFeedback(
      device,
      (d) =>
        createShaderModuleImmediate(device, {
          ...d,
          code: d.code.replaceAll(
            'let previousUv = uv - motionUv;',
            'let previousUv = uv + motionUv;',
          ),
        }),
      8,
      8,
    );
    const pattern = (shift: number) =>
      Array.from({ length: 8 }, (_, i) => {
        const v = (i - shift + 80) % 8 < 3 ? 1 : 0;
        return [v, v, v, 1];
      }).flat();
    try {
      for (let i = 0; i < 48; i++) {
        normal.draw(pattern(0));
        wrong.draw(pattern(0));
      }
      const input = pattern(1);
      const a = await normal.read(normal.draw(input, { motion: 1 / 8 }).color);
      const b = await wrong.read(wrong.draw(input, { motion: 1 / 8 }).color);
      const error = (values: number[]) =>
        values.reduce((sum, v, i) => sum + (i % 4 === 3 ? 0 : Math.abs(v - (input[i] ?? 0))), 0) /
        24;
      expect(error(a)).toBeLessThan(0.01);
      expect(error(b)).toBeGreaterThan(0.02);
    } finally {
      normal.dispose();
      wrong.dispose();
    }
  });
  it('flags moving and animated pixels in the UE IsMovingMask and leaves a static camera at zero', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d), 8, 8);
    const pixels = Array.from({ length: 8 }, () => [1, 1, 1, 1]).flat();
    try {
      // TSRDilateVelocity.usf:355-365: world term = residual / 2 pixels - 1, saturated.
      const mask = async () => (await rig.read(rig.stages.dilateEdge))[3];
      rig.draw(pixels);
      expect(await mask()).toBe(0);
      rig.draw(pixels, { motion: 1 / 8 });
      expect(await mask()).toBe(0);
      rig.draw(pixels, { motion: 0.5 });
      expect(await mask()).toBe(1);
      rig.draw(pixels, { reactive: 1 });
      expect(await mask()).toBe(1);
    } finally {
      rig.dispose();
    }
  });
  it('covers partial workgroups and the uncached tiny-DRS coverage footprint without losing validity', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const rig = tsrFeedback(device, (d) => createShaderModuleImmediate(device, d), 9, 31);
    const pixels = Array.from({ length: 9 }, () => [4, 2, 1, 0.5]).flat();
    try {
      let frame = rig.draw(pixels, { coverageReactive: 0 });
      for (let i = 1; i < 60; i++) frame = rig.draw(pixels, { coverageReactive: 0 });
      const color = await rig.read(frame.color);
      for (let i = 0; i < 31; i++) expect(color.slice(i * 4, i * 4 + 4)).toEqual([4, 2, 1, 0.5]);
      const settled = (await rig.read(frame.metadata, 1)).filter((_, i) => i % 4 === 0);
      // The jitter is fixed here, so output pixels far from every input center keep the validity of
      // their first frame: the narrow accepted kernel gives them zero weight (UE usf:1118-1164).
      // None may be rejected, and pixels at an input center saturate.
      expect(Math.min(...settled), `validity ${settled}`).toBeGreaterThan(0.03);
      expect(Math.max(...settled)).toBeGreaterThan(0.95);
      frame = rig.draw(pixels, { coverageReactive: 2 });
      expect(
        (await rig.read(frame.metadata, 1))
          .filter((_, i) => i % 4 === 0)
          .every((v) => v <= REJECTED_VALIDITY),
      ).toBe(true);
    } finally {
      rig.dispose();
    }
  });
}
