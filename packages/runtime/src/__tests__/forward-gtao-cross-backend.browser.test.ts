import { World } from '@forgeax/engine-ecs';
import { createProfiler } from '@forgeax/engine-profiler';
import {
  AMBIENT_OCCLUSION_GTAO,
  AMBIENT_OCCLUSION_QUALITY_HIGH,
  AmbientOcclusion,
} from '@forgeax/engine-render';
import type {
  RendererHostAssembly,
  RendererLegacyHostAdapter,
} from '@forgeax/engine-render/internal/construct-renderer';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import * as webgl2 from '@forgeax/engine-rhi-wgpu';
import { propagateTransforms } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
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
  ForwardGtaoCaptureNotReadyError,
  type ForwardGtaoLinearCapture,
  ForwardGtaoLinearCaptureNotReadyError,
  type ForwardGtaoPresentation,
  type ForwardGtaoTargetCapture,
  linearErrorMetrics,
  rgba16FloatRgb,
  sha256Hex,
} from './helpers/forward-gtao-capture';
import { writeForwardGtaoFailureReport } from './helpers/forward-gtao-failure';
import { createForwardGtaoScene, FORWARD_GTAO_FIXTURE } from './helpers/forward-gtao-scene';

type DebugDrawHost = RendererHostAssembly['debugDrawHost'] &
  Pick<
    RendererLegacyHostAdapter,
    | 'getCurrentGraphTarget'
    | 'requestGraphTargetCapture'
    | 'cancelGraphTargetCapture'
    | 'setGtaoExecutionOverrideForConformance'
    | 'setClusterWorkObservationForConformance'
    | 'clusterWorkFrameTraceForConformance'
  >;

const inputDescriptor = Object.freeze({
  fixture: FORWARD_GTAO_FIXTURE,
  projection: {
    kind: 'perspective',
    fovY: Math.PI / 3,
    aspect: FORWARD_GTAO_FIXTURE.width / FORWARD_GTAO_FIXTURE.height,
    near: 0.1,
    far: 30,
    antialias: 0,
  },
  ao: {
    algorithm: 'gtao',
    radius: FORWARD_GTAO_FIXTURE.radius,
    bias: FORWARD_GTAO_FIXTURE.bias,
    intensity: FORWARD_GTAO_FIXTURE.intensity,
    thickness: FORWARD_GTAO_FIXTURE.thickness,
    distanceExponent: FORWARD_GTAO_FIXTURE.distanceExponent,
    distanceFallOff: FORWARD_GTAO_FIXTURE.distanceFallOff,
    resolutionScale: FORWARD_GTAO_FIXTURE.resolutionScale,
    quality: FORWARD_GTAO_FIXTURE.quality,
    directLightingStrength: 0,
  },
  material: {
    baseColor: [0.5, 0.5, 0.5, 1],
    emissive: [0.08, 0.03, 0.015],
    metallic: 0,
    roughness: 1,
    normalTexture: [191, 159, 234, 255],
    normalScale: [1, 1],
    alphaTexture: FORWARD_GTAO_FIXTURE.alphaMask.texel,
    alphaCutoff: FORWARD_GTAO_FIXTURE.alphaMask.cutoff,
  },
  geometry: [
    { center: [0, 0, -4.005], size: [20, 20, 0.01] },
    { center: [0, 0, -3.9], size: [1.4, 1.4, 0.2] },
  ],
  lighting: {
    skylight: {},
    pointLight: { position: [0, 2, -2], intensity: 8, range: 12 },
    tonemap: 'linear',
  },
});

interface FragmentCapture {
  readonly backend: 'webgpu' | 'wgpu-webgl2';
  readonly manifestIdentity: {
    readonly url: string;
    readonly byteLength: number;
    readonly sha256: string;
  };
  readonly inputHash: string;
  readonly execution: string;
  readonly passNames: readonly string[];
  readonly attemptTraces: readonly {
    readonly operation: 'draw' | 'target-capture' | 'linear-hdr';
    readonly targetName?: string;
    readonly publicReceiptFrameId?: number;
    readonly presentation?: ForwardGtaoPresentation;
    readonly trace: ReturnType<DebugDrawHost['clusterWorkFrameTraceForConformance']>;
  }[];
  readonly raw: ForwardGtaoTargetCapture;
  readonly filtered: ForwardGtaoTargetCapture;
  readonly linearHdr: ForwardGtaoLinearCapture;
}

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

async function captureFragment(backendKind: FragmentCapture['backend']): Promise<FragmentCapture> {
  if (backendKind === 'wgpu-webgl2') await webgl2.ensureReady();
  const manifestResponse = await fetch('/shaders/manifest.json');
  if (!manifestResponse.ok) {
    throw new Error(`engine shader manifest fetch failed: ${manifestResponse.status}`);
  }
  const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
  const manifestIdentity = {
    url: new URL('/shaders/manifest.json', location.href).href,
    byteLength: manifestBytes.byteLength,
    sha256: await sha256Hex(manifestBytes),
  };
  let failureOperation = 'renderer.setup';
  let failureReceipt: unknown;
  let failureFrameTrace: unknown;
  let failureReadback: unknown;
  const canvas = document.createElement('canvas');
  canvas.width = FORWARD_GTAO_FIXTURE.width;
  canvas.height = FORWARD_GTAO_FIXTURE.height;
  document.body.append(canvas);
  if (backendKind === 'webgpu' && canvas.getContext('webgpu') === null) {
    canvas.remove();
    throw new Error('WebGPU context is unavailable for cross-backend GTAO capture');
  }
  const recorderResult = backendKind === 'webgpu' ? attachRecorder(webgpu) : attachRecorder(webgl2);
  const recorder = value(recorderResult);
  const profiler = createProfiler();
  const assemblyResult =
    backendKind === 'webgpu'
      ? await constructRuntimeRendererHost(canvas, {
          rhi: recorder.backend.rhi,
          captureGpuTimings: true,
          profiler,
        })
      : await constructRuntimeRendererHost(canvas, {
          rhi: recorder.backend.rhi,
          captureGpuTimings: true,
          profiler,
          rhiInstrumentation: {
            resolveSurfaceDevice(device) {
              const unwrapped = recorder.backend.unwrapDeviceForSurface(device);
              if (!unwrapped.ok) throw unwrapped.error;
              return ok(unwrapped.value);
            },
          },
        });
  if (!assemblyResult.ok) {
    await recorder.dispose();
    canvas.remove();
    throw assemblyResult.error;
  }
  const assembly = assemblyResult.value;
  const { renderer } = assembly;
  const debugHost = assembly.debugDrawHost as DebugDrawHost;
  debugHost.setClusterWorkObservationForConformance(true);
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World({ assets: assembly.assets });
  const { camera } = createForwardGtaoScene(
    world,
    FORWARD_GTAO_FIXTURE.width,
    FORWARD_GTAO_FIXTURE.height,
  );
  world
    .addComponent(camera, {
      component: AmbientOcclusion,
      data: {
        algorithm: AMBIENT_OCCLUSION_GTAO,
        directLightingStrength: 0,
        radius: FORWARD_GTAO_FIXTURE.radius,
        bias: FORWARD_GTAO_FIXTURE.bias,
        intensity: FORWARD_GTAO_FIXTURE.intensity,
        thickness: FORWARD_GTAO_FIXTURE.thickness,
        distanceExponent: FORWARD_GTAO_FIXTURE.distanceExponent,
        distanceFallOff: FORWARD_GTAO_FIXTURE.distanceFallOff,
        resolutionScale: FORWARD_GTAO_FIXTURE.resolutionScale,
        quality: AMBIENT_OCCLUSION_QUALITY_HIGH,
      },
    })
    .unwrap();
  if (backendKind === 'webgpu') debugHost.setGtaoExecutionOverrideForConformance('fragment');
  const lease = value(renderer.attach(world));
  const attemptTraces: {
    readonly operation: 'draw' | 'target-capture' | 'linear-hdr';
    readonly targetName?: string;
    readonly publicReceiptFrameId?: number;
    readonly presentation?: ForwardGtaoPresentation;
    readonly trace: ReturnType<DebugDrawHost['clusterWorkFrameTraceForConformance']>;
  }[] = [];
  const drawAttempt = async () => {
    failureOperation = 'renderer.draw';
    propagateTransforms(world).unwrap();
    world.update(1 / 60).unwrap();
    const result = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!result.ok) throw result.error;
    const receipt = result.value;
    failureReceipt = {
      frameId: receipt.frameId,
      deviceGeneration: receipt.deviceGeneration,
      presentation: receipt.presentation,
    };
    failureOperation = 'receipt.completed';
    value(await receipt.completed);
    const trace = debugHost.clusterWorkFrameTraceForConformance();
    failureFrameTrace = trace;
    attemptTraces.push({
      operation: 'draw',
      publicReceiptFrameId: receipt.frameId,
      presentation: receipt.presentation,
      trace,
    });
    if (errors.length > 0) throw errors[0];
    return receipt;
  };
  const drawReady = async () => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const receipt = await drawAttempt();
      if (receipt.presentation === 'ready') return receipt;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`${backendKind} GTAO fragment did not produce a ready frame`);
  };
  const captureTarget = async (name: 'ssao-raw' | 'ssao-blurred') => {
    failureOperation = `capture-target:${name}`;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const capture = await captureForwardGtaoTarget(debugHost, name, drawAttempt);
        failureReceipt = {
          publicReceiptFrameId: capture.publicReceiptFrameId,
          recordFrameNumber: capture.targetRecordFrameNumber,
          graphGeneration: capture.graphGeneration,
          textureIdentity: capture.textureIdentity,
          deviceGeneration: capture.deviceGeneration,
          presentation: 'ready',
        };
        failureFrameTrace = capture.frameTrace;
        failureReadback = {
          target: name,
          format: capture.format,
          width: capture.width,
          height: capture.height,
          byteLength: capture.bytes.byteLength,
          sha256: await sha256Hex(capture.bytes),
        };
        attemptTraces.push({
          operation: 'target-capture',
          targetName: name,
          publicReceiptFrameId: capture.publicReceiptFrameId,
          presentation: 'ready',
          trace: capture.frameTrace,
        });
        return capture;
      } catch (error) {
        if (!(error instanceof ForwardGtaoCaptureNotReadyError)) throw error;
        attemptTraces.push({
          operation: 'target-capture',
          targetName: name,
          publicReceiptFrameId: error.publicReceiptFrameId,
          presentation: error.presentation,
          trace: error.frameTrace,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error(`${backendKind} ${name} target capture did not become ready`);
  };
  const captureLinearHdr = async () => {
    failureOperation = 'capture-linear-hdr';
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const capture = await captureForwardGtaoLinearHdr(renderer, drawAttempt);
        failureReceipt = {
          frameId: capture.frameId,
          deviceGeneration: capture.deviceGeneration,
          graphGeneration: capture.graphGeneration,
          readbackIdentity: capture.readbackIdentity,
        };
        failureFrameTrace = debugHost.clusterWorkFrameTraceForConformance();
        failureReadback = {
          target: 'linear-hdr',
          format: capture.format,
          width: capture.width,
          height: capture.height,
          byteLength: capture.bytes.byteLength,
          sha256: await sha256Hex(capture.bytes),
        };
        attemptTraces.push({
          operation: 'linear-hdr',
          publicReceiptFrameId: capture.frameId,
          presentation: 'ready',
          trace: debugHost.clusterWorkFrameTraceForConformance(),
        });
        return capture;
      } catch (error) {
        if (!(error instanceof ForwardGtaoLinearCaptureNotReadyError)) throw error;
        attemptTraces.push({
          operation: 'linear-hdr',
          publicReceiptFrameId: error.publicReceiptFrameId,
          presentation: error.presentation,
          trace: debugHost.clusterWorkFrameTraceForConformance(),
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error(`${backendKind} linear HDR capture did not become ready`);
  };
  try {
    const inspection = renderer.inspect();
    if (inspection.capabilities.backendKind !== backendKind) {
      throw new Error(
        `requested ${backendKind} but renderer selected ${inspection.capabilities.backendKind}`,
      );
    }
    await drawReady();
    const ao = renderer.inspect().standardLighting?.ambientOcclusion;
    if (ao?.status !== 'active') throw new Error(`${backendKind} GTAO is not active`);
    expect(ao.algorithm).toBe('gtao');
    expect(ao.execution).toBe('fragment');
    expect(ao.input.extent).toEqual({
      width: FORWARD_GTAO_FIXTURE.width,
      height: FORWARD_GTAO_FIXTURE.height,
    });
    expect(ao.output.extent).toEqual({
      width: Math.round(FORWARD_GTAO_FIXTURE.width * FORWARD_GTAO_FIXTURE.resolutionScale),
      height: Math.round(FORWARD_GTAO_FIXTURE.height * FORWARD_GTAO_FIXTURE.resolutionScale),
    });
    expect(renderer.inspect().output.graphPassNames).toEqual(
      expect.arrayContaining(['ssao-calc', 'ssao-blur', 'main']),
    );
    const raw = await captureTarget('ssao-raw');
    const filtered = await captureTarget('ssao-blurred');
    const linearHdr = await captureLinearHdr();
    return {
      backend: backendKind,
      manifestIdentity,
      inputHash: await sha256Hex(new TextEncoder().encode(JSON.stringify(inputDescriptor))),
      execution: ao.execution,
      passNames: [...renderer.inspect().output.graphPassNames],
      attemptTraces,
      raw,
      filtered,
      linearHdr,
    };
  } catch (failure) {
    await writeForwardGtaoFailureReport({
      writeFile: commands.writeFile,
      path: `packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-cross-backend-${backendKind}-failure.json`,
      failure,
      context: {
        backend: backendKind,
        manifestSummary: manifestIdentity,
        cameraConfig: {
          width: FORWARD_GTAO_FIXTURE.width,
          height: FORWARD_GTAO_FIXTURE.height,
          algorithm: 'gtao',
          quality: 'high',
          resolutionScale: FORWARD_GTAO_FIXTURE.resolutionScale,
        },
        operation: failureOperation,
        receipt: failureReceipt,
        frameTrace: failureFrameTrace,
        readback: failureReadback,
        rendererErrors: errors,
      },
    });
    throw failure;
  } finally {
    debugHost.setGtaoExecutionOverrideForConformance(undefined);
    debugHost.setClusterWorkObservationForConformance(false);
    unsubscribe();
    lease.dispose();
    value(await renderer.dispose());
    value(await recorder.dispose());
    canvas.remove();
  }
}

it('compares admitted Forward GTAO fragment across WebGPU and wgpu-WebGL2 with one fixed workload', {
  timeout: 300_000,
}, async () => {
  let webgpuResult: FragmentCapture | undefined;
  let webglResult: FragmentCapture | undefined;
  try {
    const webgpuCapture = await captureFragment('webgpu');
    webgpuResult = webgpuCapture;
    const webglCapture = await captureFragment('wgpu-webgl2');
    webglResult = webglCapture;
    expect(webgpuCapture.inputHash).toBe(webglCapture.inputHash);
    expect(webgpuCapture.manifestIdentity).toEqual(webglCapture.manifestIdentity);
    expect(webgpuCapture.execution).toBe('fragment');
    expect(webglCapture.execution).toBe('fragment');
    expect(webgpuCapture.raw).toMatchObject({
      format: 'rgba8unorm',
      width: webglCapture.raw.width,
      height: webglCapture.raw.height,
    });
    expect(webgpuCapture.filtered).toMatchObject({
      format: 'r8unorm',
      width: webglCapture.filtered.width,
      height: webglCapture.filtered.height,
    });
    expect([webgpuCapture.linearHdr.width, webgpuCapture.linearHdr.height]).toEqual([
      webglCapture.linearHdr.width,
      webglCapture.linearHdr.height,
    ]);
    expect(webgpuCapture.linearHdr.format).toBe('rgba16float');
    expect(webglCapture.linearHdr.format).toBe('rgba16float');

    const rawVisibility = byteErrorMetrics(
      byteChannel(webgpuCapture.raw.bytes, 4, 0),
      byteChannel(webglCapture.raw.bytes, 4, 0),
    );
    expect(rawVisibility.maxAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.rawVisibilityMaxByteError,
    );
    expect(rawVisibility.rms).toBeLessThanOrEqual(GTAO_COMPARISON_BUDGET.rawVisibilityRmsByteError);
    const rawNormal = [1, 2].map((channel) =>
      byteErrorMetrics(
        byteChannel(webgpuCapture.raw.bytes, 4, channel),
        byteChannel(webglCapture.raw.bytes, 4, channel),
      ),
    );
    for (const metrics of rawNormal) {
      expect(metrics.maxAbsolute).toBeLessThanOrEqual(GTAO_COMPARISON_BUDGET.rawNormalMaxByteError);
      expect(metrics.rms).toBeLessThanOrEqual(GTAO_COMPARISON_BUDGET.rawNormalRmsByteError);
    }
    const filtered = byteErrorMetrics(webgpuCapture.filtered.bytes, webglCapture.filtered.bytes);
    expect(filtered.maxAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.filteredVisibilityMaxByteError,
    );
    expect(filtered.rms).toBeLessThanOrEqual(GTAO_COMPARISON_BUDGET.filteredVisibilityRmsByteError);
    const linear = linearErrorMetrics(
      rgba16FloatRgb(webgpuCapture.linearHdr),
      rgba16FloatRgb(webglCapture.linearHdr),
    );
    expect(linear.maxAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.linearLightingMaxAbsoluteError,
    );
    expect(linear.maxRelative).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.linearLightingMaxRelativeError,
    );
    expect(linear.rmsAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.linearLightingRmsAbsoluteError,
    );

    const outputArtifact = async (
      capture: ForwardGtaoTargetCapture | ForwardGtaoLinearCapture,
    ) => ({
      format: capture.format,
      width: capture.width,
      height: capture.height,
      frameId: 'frameId' in capture ? capture.frameId : undefined,
      targetRecordFrameNumber:
        'targetRecordFrameNumber' in capture ? capture.targetRecordFrameNumber : undefined,
      publicReceiptFrameId:
        'publicReceiptFrameId' in capture
          ? capture.publicReceiptFrameId
          : 'frameId' in capture
            ? capture.frameId
            : undefined,
      graphGeneration: capture.graphGeneration,
      textureIdentity: capture.textureIdentity,
      readbackIdentity: 'readbackIdentity' in capture ? capture.readbackIdentity : undefined,
      byteLength: capture.bytes.byteLength,
      sha256: await sha256Hex(capture.bytes),
      base64: base64Bytes(capture.bytes),
    });
    const backendOutputs = await Promise.all(
      [webgpuCapture, webglCapture].map(async (capture) => ({
        backend: capture.backend,
        manifestIdentity: capture.manifestIdentity,
        execution: capture.execution,
        passNames: capture.passNames,
        raw: await outputArtifact(capture.raw),
        filtered: await outputArtifact(capture.filtered),
        linearHdr: {
          ...(await outputArtifact(capture.linearHdr)),
          deviceGeneration: capture.linearHdr.deviceGeneration,
          gpuTimings: capture.linearHdr.gpuTimings,
        },
      })),
    );
    const report = {
      schemaVersion: 1,
      fixture: inputDescriptor,
      inputHash: webgpuCapture.inputHash,
      backendOutputs,
      comparison: { rawVisibility, rawNormal, filtered, linear },
    };
    await commands.writeFile(
      'packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-cross-backend.browser.json',
      JSON.stringify(report, null, 2),
    );
  } catch (failure) {
    const summarize = async (capture: FragmentCapture | undefined) => {
      if (capture === undefined) return { status: 'not-obtained' };
      return {
        backend: capture.backend,
        manifestIdentity: capture.manifestIdentity,
        inputHash: capture.inputHash,
        execution: capture.execution,
        passNames: capture.passNames,
        raw: {
          width: capture.raw.width,
          height: capture.raw.height,
          format: capture.raw.format,
          byteLength: capture.raw.bytes.byteLength,
          sha256: await sha256Hex(capture.raw.bytes),
        },
        filtered: {
          width: capture.filtered.width,
          height: capture.filtered.height,
          format: capture.filtered.format,
          byteLength: capture.filtered.bytes.byteLength,
          sha256: await sha256Hex(capture.filtered.bytes),
        },
        linearHdr: {
          frameId: capture.linearHdr.frameId,
          graphGeneration: capture.linearHdr.graphGeneration,
          deviceGeneration: capture.linearHdr.deviceGeneration,
          readbackIdentity: capture.linearHdr.readbackIdentity,
          width: capture.linearHdr.width,
          height: capture.linearHdr.height,
          format: capture.linearHdr.format,
          byteLength: capture.linearHdr.bytes.byteLength,
          sha256: await sha256Hex(capture.linearHdr.bytes),
        },
      };
    };
    await writeForwardGtaoFailureReport({
      writeFile: commands.writeFile,
      path: 'packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-cross-backend-comparison-failure.json',
      failure,
      context: {
        backend: 'cross-backend-comparison',
        manifestSummary: {
          webgpu: webgpuResult?.manifestIdentity ?? { status: 'not-obtained' },
          webgl: webglResult?.manifestIdentity ?? { status: 'not-obtained' },
        },
        cameraConfig: inputDescriptor,
        operation: 'cross-backend-numerical-assertion-or-report',
        receipt: {
          webgpu: webgpuResult?.linearHdr.frameId ?? { status: 'not-obtained' },
          webgl: webglResult?.linearHdr.frameId ?? { status: 'not-obtained' },
        },
        frameTrace: {
          webgpu: webgpuResult?.attemptTraces ?? { status: 'not-obtained' },
          webgl: webglResult?.attemptTraces ?? { status: 'not-obtained' },
        },
        readback: {
          webgpu: await summarize(webgpuResult),
          webgl: await summarize(webglResult),
        },
      },
    });
    throw failure;
  }
});
