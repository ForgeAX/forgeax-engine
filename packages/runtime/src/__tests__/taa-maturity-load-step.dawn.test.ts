import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  DEFAULT_STANDARD_PROFILE,
  DynamicResolution,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
} from '@forgeax/engine-render';
import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { renderValue } from './standard-gbuffer-replay.fixture';
import { json, quantile, save, scene } from './taa-maturity.fixture';

it.skipIf(
  !['load-step', 'load-step-balanced', 'load-step-balanced-floor'].includes(
    process.env.TAA_MATURITY ?? '',
  ),
)(
  'responds to actual light-heavy-light scene work at one unchanged GPU budget',
  { timeout: 240_000, retry: 0 },
  async () => {
    const floorCalibrated = process.env.TAA_MATURITY === 'load-step-balanced-floor';
    const balanced = floorCalibrated || process.env.TAA_MATURITY === 'load-step-balanced';
    const lightCount = balanced ? 32 : 128;
    const evidence = floorCalibrated
      ? 'load-step-balanced-floor'
      : balanced
        ? 'load-step-balanced'
        : 'load-step';
    // Captured runs diagnose work/resources; their timings are never acceptance data.
    const recorder =
      process.env.TAA_MATURITY_LOAD_STEP_CAPTURE === '1'
        ? attachRecorder(webgpu).unwrap()
        : undefined;
    const carrier = await scene(1920, 1080, {
      timing: true,
      standardProfile: { ...DEFAULT_STANDARD_PROFILE, lightCount: balanced ? 32 : 256 },
      ...(recorder === undefined ? {} : { rhi: recorder.backend.rhi }),
    });
    const { world, camera, renderer } = carrier;
    const mesh = world.allocSharedRef('MeshAsset', createPlaneGeometry(4, 3, 16, 16).unwrap());
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [0.3, 0.5, 0.7, 1], roughness: 0.35, metallic: 0.3 }),
    );
    const surface = world
      .spawn(
        { component: Transform, data: { pos: [30, 0, -0.1] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    for (let i = 0; i < lightCount; i++)
      world
        .spawn(
          {
            component: Transform,
            data: { pos: [((i % 8) - 3.5) * 0.45, (Math.floor(i / 8) - 1.5) * 0.6, 1] },
          },
          { component: PointLight, data: { color: [1, 0.8, 0.6], intensity: 0.2, range: 10 } },
        )
        .unwrap();
    const setHeavy = (heavy: boolean) =>
      world.set(surface, Transform, { pos: [heavy ? 0 : 30, 0, -0.1] }).unwrap();
    const windows: unknown[] = [];
    const window = async (phase: string, heavy: boolean) => {
      setHeavy(heavy);
      const frames = [];
      for (let i = 0; i < 180; i++) {
        const sample = await carrier.draw();
        if (recorder !== undefined) (await recorder.frameBoundary()).unwrap();
        const observation = renderValue(
          await renderer.observe(sample.receipt, { include: ['timings'] }),
        ).timings;
        if (observation?.status !== 'complete' || observation.frame.droppedPassCount !== 0)
          throw new Error('missing complete physical interval');
        const intervals = summarizeGpuPassTimingIntervals(
          observation.frame.passes,
          observation.frame.timestampPeriodNanoseconds,
        ).unwrap();
        if (intervals.unmeasuredPassCount !== 0) throw new Error('partial physical interval');
        frames.push({
          frame: i,
          cpuMs: sample.cpuMs,
          gpuMs: intervals.envelopeNanoseconds / 1e6,
          timing: observation.frame,
          inspection: renderer.inspect().dynamicResolution,
          frustumStats: { ...renderer.inspect().frustumStats },
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const sampled = frames.slice(120);
      const result = {
        phase,
        heavy,
        frames,
        gpuP50: quantile(
          sampled.map((frame) => frame.gpuMs),
          0.5,
        ),
        gpuP95: quantile(
          sampled.map((frame) => frame.gpuMs),
          0.95,
        ),
        finalScale: renderer.inspect().dynamicResolution?.extent?.scale,
      };
      windows.push(result);
      json(`${evidence}-partial.json`, {
        partial: true,
        windows,
        controllerSha256: createHash('sha256')
          .update(readFileSync('packages/render/src/pipeline/dynamic-resolution.ts'))
          .digest('hex'),
      });
      return result;
    };
    try {
      carrier.mode(undefined);
      const light = await window('native-light', false);
      const heavy = await window('native-heavy', true);
      // Calibrate a single budget between the same-device native workload medians,
      // before enabling feedback, with light headroom. The budget never changes
      // during the step; reaching minScale cannot guarantee meeting that budget.
      // The original native-only calibration is retained as a separate mode.
      // A feasible-budget claim additionally measures actual fixed-minimum
      // cost before enabling feedback, with the existing 15% headroom bound.
      // Native overload and gains must still pass; no threshold is relaxed.
      let floor: Awaited<ReturnType<typeof window>> | undefined;
      if (floorCalibrated) {
        carrier.mode(0.5);
        floor = await window('fixed-minimum-heavy', true);
        carrier.mode(undefined);
      }
      const budget = Math.max(
        ...(floor === undefined ? [] : [(floor.gpuP50 ?? NaN) / 0.85]),
        (light.gpuP50 ?? NaN) * 2,
        ((light.gpuP50 ?? NaN) + (heavy.gpuP50 ?? NaN)) / 2,
      );
      expect(heavy.gpuP50).toBeGreaterThan((light.gpuP50 ?? Infinity) * 1.2);
      expect(heavy.gpuP50).toBeGreaterThan(budget * 1.05);
      world
        .addComponent(camera, {
          component: DynamicResolution,
          data: { targetGpuMs: budget, minScale: 0.5, maxScale: 1 },
        })
        .unwrap();
      const first = await window('adaptive-light', false);
      const overload = await window('adaptive-heavy', true);
      const recovered = await window('adaptive-light-recovery', false);
      if (recorder !== undefined) {
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        await carrier.draw(true);
        (await recorder.frameBoundary()).unwrap();
        const capture = (await pending).unwrap();
        save(`${evidence}-recovery.rhitape`, capture.bytes);
        const model = buildFrameModel(decodeTape(capture.bytes).unwrap());
        json(`${evidence}-recovery-work.json`, {
          diagnostic: true,
          digest: capture.digest,
          works: model.works,
        });
      }
      json(`${evidence}.json`, {
        width: 1920,
        diagnostic: recorder !== undefined,
        height: 1080,
        warmup: 120,
        sample: 60,
        calibration: floorCalibrated
          ? 'native-light/native-heavy/fixed-minimum-heavy, all before feedback'
          : 'original native-light/native-heavy only',
        budget,
        source: {
          head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          status: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(),
          controllerSha256: createHash('sha256')
            .update(readFileSync('packages/render/src/pipeline/dynamic-resolution.ts'))
            .digest('hex'),
          renderRuntimeSha256: Object.fromEntries(
            readdirSync('packages/render/dist')
              .filter((file) => file.endsWith('.mjs'))
              .sort()
              .map((file) => [
                file,
                createHash('sha256')
                  .update(readFileSync(`packages/render/dist/${file}`))
                  .digest('hex'),
              ]),
          ),
        },
        definition: `actual Standard receiver enters/leaves camera; ${lightCount} lights and authored GPU budget remain unchanged; full interval envelope`,
        thresholds: {
          nativeWorkContrast: 1.2,
          overloadGain: 0.05,
          ...(balanced ? { overloadP95Gain: 0.05, feasibleBudgetRatio: 1.05 } : {}),
          recoveryScale: 1,
          steadyScaleRange: 1 / 32,
        },
        windows,
      });
      const steadyScales = overload.frames
        .slice(120)
        .map((frame) => frame.inspection?.extent?.scale ?? NaN);
      expect(Math.max(...steadyScales) - Math.min(...steadyScales)).toBeLessThanOrEqual(1 / 32);
      expect(first.finalScale).toBe(1);
      expect(overload.finalScale).toBeLessThan(1);
      expect(overload.gpuP50).toBeLessThan((heavy.gpuP50 ?? 0) * 0.95);
      if (balanced) {
        expect(overload.gpuP95).toBeLessThan((heavy.gpuP95 ?? 0) * 0.95);
        expect(overload.gpuP50).toBeLessThanOrEqual(budget * 1.05);
      }
      expect(recovered.finalScale).toBe(1);
      expect(world.get(camera, DynamicResolution).unwrap().targetGpuMs).toBe(Math.fround(budget));
    } finally {
      await carrier.dispose();
    }
  },
);
