import { World } from '@forgeax/engine-ecs';
import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine-render';
import type { RendererLegacyHostAdapter } from '@forgeax/engine-render/internal/construct-renderer';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { GTAO_COMPARISON_BUDGET } from '../../../render/src/__tests__/gtao-reference';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  base64Bytes,
  byteChannel,
  byteErrorMetrics,
  captureForwardGtaoLinearHdr,
  captureForwardGtaoTarget,
  linearErrorMetrics,
  rgba16FloatRgb,
} from './helpers/forward-gtao-capture';
import { createForwardGtaoScene, FORWARD_GTAO_FIXTURE } from './helpers/forward-gtao-scene';
import { unwrap } from './specular-aa.fixture';

const { width, height } = FORWARD_GTAO_FIXTURE;
const halfExtent = { width: Math.ceil(width / 2), height: Math.ceil(height / 2) };
const evidence = 'artifacts/ci-focus/deferred-gtao';

it.each([false, true])('compares Deferred GTAO compute and raster with useNormals=%s', {
  timeout: 180_000,
}, async (useNormals) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const profile = {
    ...DEFAULT_STANDARD_PROFILE,
    renderPath: 'deferred',
    gbufferFormat: 'default',
    ambientOcclusion: { enabled: false, method: 'gtao' },
  } as const;
  const assembly = unwrap(
    await constructRuntimeRendererHost(canvas, {
      standardProfile: profile,
      rhi: recorder.backend.rhi,
      gpuPassTiming: {},
    }),
  );
  const { renderer } = assembly;
  const debug = assembly.debugDrawHost as typeof assembly.debugDrawHost &
    Pick<
      RendererLegacyHostAdapter,
      | 'getCurrentGraphTarget'
      | 'requestGraphTargetCapture'
      | 'cancelGraphTargetCapture'
      | 'clusterWorkFrameTraceForConformance'
      | 'setGtaoExecutionOverrideForConformance'
      | 'setClusterWorkObservationForConformance'
      | 'armGtaoCandidatePreparationFailureForConformance'
    >;
  debug.setClusterWorkObservationForConformance(true);
  const world = new World({ assets: assembly.assets });
  createForwardGtaoScene(world, width, height);
  const lease = unwrap(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const submit = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = unwrap(renderer.draw({ source: lease }));
    unwrap(await receipt.completed);
    return receipt;
  };
  const draw = async () => {
    const receipt = await submit();
    if (errors.length > 0) throw errors[0];
    return receipt;
  };
  const drawReady = async () => {
    const deadline = Date.now() + 30_000;
    do {
      const receipt = await draw();
      if (receipt.presentation === 'ready') return receipt;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    throw new Error('Deferred GTAO did not submit a ready frame');
  };
  const captureLane = async (execution: 'compute' | 'fragment') => {
    debug.setGtaoExecutionOverrideForConformance(execution);
    const entry =
      (execution === 'compute' ? 'cs_gtao_' : 'fs_gtao_') + (useNormals ? 'normal' : 'depth');
    for (let completed = 0; completed < 60; completed++) await drawReady();
    // Inspection projects the history accepted before the most recent submission.
    await drawReady();
    const inspection = renderer.inspect().standardLighting?.ambientOcclusion;
    expect(inspection).toMatchObject({
      status: 'active',
      requestedMethod: 'gtao',
      effectiveMethod: 'gtao',
      execution,
      historyFrames: expect.any(Number),
      output: { extent: { width, height }, filteredFormat: 'r8unorm' },
    });
    expect(inspection?.historyFrames).toBeGreaterThanOrEqual(60);
    expect(inspection?.passes).toEqual(
      expect.arrayContaining([
        execution === 'compute' ? 'gtao-calc-compute' : 'gtao-calc',
        'gtao-spatial',
        'gtao-temporal',
        'gtao-resolve',
      ]),
    );

    // Both lanes must be compared at the same sampling phase. Disabling temporal AO
    // removes the phase advance while leaving the production raw/spatial/resolve path.
    unwrap(
      renderer.setProfile({
        ...profile,
        ambientOcclusion: {
          enabled: true,
          method: 'gtao',
          quality: 100,
          gtao: { useNormals, downsample: true, temporalFilter: false },
        },
      }),
    );
    await drawReady();
    const raw = await captureForwardGtaoTarget(debug, 'gtao-calc', draw);
    const visibility = await captureForwardGtaoTarget(debug, 'gtao-resolve', draw);
    const linear = await captureForwardGtaoLinearHdr(renderer, draw);
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await drawReady();
    (await recorder.frameBoundary()).unwrap();
    const tape = (await pending).unwrap();
    await commands.writeFile(
      `${evidence}/normals-${useNormals}-${execution}.rhitape`,
      base64Bytes(tape.bytes),
      'base64',
    );
    const frame = buildFrameModel(decodeTape(tape.bytes).unwrap());
    const work = frame.works.find((candidate) =>
      candidate.pipeline.shaders.some((shader) => shader.entryPoint === entry),
    );
    expect(work?.kind === 'dispatchWorkgroups').toBe(execution === 'compute');
    expect(work).toBeDefined();
    expect(raw).toMatchObject({
      ...halfExtent,
      format: execution === 'compute' ? 'rgba8unorm' : 'r8unorm',
    });
    expect(visibility).toMatchObject({ width, height, format: 'r8unorm' });
    expect(raw.graphGeneration).toBe(visibility.graphGeneration);
    // Linear HDR opts into a separate observation graph and is joined to its own receipt.
    expect(linear.graphGeneration).toBe(linear.receipt.graphGeneration);
    expect(linear.deviceGeneration).toBe(visibility.deviceGeneration);
    expect(renderer.inspect().standardLighting?.ambientOcclusion?.execution).toBe(execution);
    return { raw, visibility, linear };
  };
  const enable = () =>
    unwrap(
      renderer.setProfile({
        ...profile,
        ambientOcclusion: {
          enabled: true,
          method: 'gtao',
          quality: 100,
          gtao: { useNormals, downsample: true },
        },
      }),
    );
  try {
    expect(renderer.inspect().capabilities.backendKind).toBe('webgpu');
    await drawReady();
    const baseline = await captureForwardGtaoLinearHdr(renderer, draw);
    enable();
    const compute = await captureLane('compute');
    enable();
    const fragment = await captureLane('fragment');
    const rawError = byteErrorMetrics(byteChannel(compute.raw.bytes, 4, 0), fragment.raw.bytes);
    const visibilityError = byteErrorMetrics(compute.visibility.bytes, fragment.visibility.bytes);
    const linearError = linearErrorMetrics(
      rgba16FloatRgb(compute.linear),
      rgba16FloatRgb(fragment.linear),
    );
    const noAo = rgba16FloatRgb(baseline);
    const withAo = rgba16FloatRgb(compute.linear);
    expect(withAo).toHaveLength(noAo.length);
    let affected = 0;
    for (let channel = 0; channel < noAo.length; channel += 3) {
      const delta = Math.max(
        (noAo[channel] ?? NaN) - (withAo[channel] ?? NaN),
        (noAo[channel + 1] ?? NaN) - (withAo[channel + 1] ?? NaN),
        (noAo[channel + 2] ?? NaN) - (withAo[channel + 2] ?? NaN),
      );
      if (delta > 0.002) affected++;
    }
    await commands.writeFile(
      `${evidence}/normals-${useNormals}.json`,
      JSON.stringify(
        {
          rawError,
          visibilityError,
          linearError,
          affected,
          timings: {
            off: baseline.gpuTimings,
            compute: compute.linear.gpuTimings,
            fragment: fragment.linear.gpuTimings,
          },
        },
        null,
        2,
      ),
    );
    expect(rawError.maxAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.rawVisibilityMaxByteError,
    );
    expect(rawError.rms).toBeLessThanOrEqual(GTAO_COMPARISON_BUDGET.rawVisibilityRmsByteError);
    expect(visibilityError.maxAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.filteredVisibilityMaxByteError,
    );
    expect(visibilityError.rms).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.filteredVisibilityRmsByteError,
    );
    expect(linearError.maxAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.linearLightingMaxAbsoluteError,
    );
    expect(linearError.maxRelative).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.linearLightingMaxRelativeError,
    );
    expect(linearError.rmsAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.linearLightingRmsAbsoluteError,
    );
    expect(compute.visibility.bytes.some((value) => value < 253)).toBe(true);
    expect(affected).toBeGreaterThan(8);

    const activeAo = renderer.inspect().standardLighting?.ambientOcclusion;
    expect(activeAo).toMatchObject({ status: 'active', execution: 'fragment' });
    // Change the raw allocation size while leaving the accepted image available.
    unwrap(
      renderer.setProfile({
        ...profile,
        ambientOcclusion: {
          enabled: true,
          method: 'gtao',
          quality: 100,
          gtao: { useNormals, downsample: false, temporalFilter: false },
        },
      }),
    );
    debug.armGtaoCandidatePreparationFailureForConformance();
    await submit();
    expect(errors).toHaveLength(1);
    const fault = errors.pop();
    expect(fault).toMatchObject({
      code: 'graph-build-failed',
      detail: {
        cause: {
          code: 'gtao-candidate-preparation-fault-injected',
          detail: { phase: 'post-allocation-before-promotion' },
        },
      },
    });
    expect(renderer.inspect().standardLighting?.ambientOcclusion?.graphGeneration).toBe(
      activeAo?.graphGeneration,
    );
    await drawReady();
    const retried = await captureForwardGtaoTarget(debug, 'gtao-calc', draw);
    expect(retried).toMatchObject({ width, height, format: 'r8unorm' });
    expect(retried.graphGeneration).not.toBe(activeAo?.graphGeneration);

    unwrap(renderer.setProfile(profile));
    await drawReady();
    const restored = await captureForwardGtaoLinearHdr(renderer, draw);
    expect(linearErrorMetrics(rgba16FloatRgb(baseline), rgba16FloatRgb(restored)).maxAbsolute).toBe(
      0,
    );
    expect(renderer.inspect().standardLighting?.ambientOcclusion).toMatchObject({
      status: 'off',
      passes: [],
    });
    expect(debug.getCurrentGraphTarget('gtao-resolve')).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    lease.dispose();
    unwrap(await renderer.dispose());
    unwrap(await recorder.dispose());
    canvas.remove();
  }
});
