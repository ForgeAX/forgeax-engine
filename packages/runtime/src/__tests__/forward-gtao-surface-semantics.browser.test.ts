import { World } from '@forgeax/engine-ecs';
import { createProfiler } from '@forgeax/engine-profiler';
import {
  AMBIENT_OCCLUSION_GTAO,
  AMBIENT_OCCLUSION_QUALITY_HIGH,
  AmbientOcclusion,
  Camera,
  type FrameReceipt,
  Materials,
  MeshRenderer,
  PointLight,
  Skylight,
} from '@forgeax/engine-render';
import type {
  RendererHostAssembly,
  RendererLegacyHostAdapter,
} from '@forgeax/engine-render/internal/construct-renderer';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  type EncodedTape,
  summarizeFrame,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import {
  computeGtaoRawReference,
  decodeMaterialNormalX12Y12,
  GTAO_COMPARISON_BUDGET,
  reverseZDeviceDepth,
} from '../../../render/src/__tests__/gtao-reference';
import { GPU_BUFFER_USAGE_COPY_SRC, GPU_BUFFER_USAGE_STORAGE } from '../../../render/src/gpu-usage';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  base64Bytes,
  byteChannel,
  byteErrorMetrics,
  captureForwardGtaoBuffer,
  captureForwardGtaoTarget,
  ForwardGtaoCaptureNotReadyError,
  sha256Hex,
} from './helpers/forward-gtao-capture';
import {
  throwForForwardGtaoRendererErrors,
  writeForwardGtaoFailureReport,
} from './helpers/forward-gtao-failure';
import { resolveForwardGtaoMaterialLineage } from './helpers/forward-gtao-material-lineage';
import {
  createForwardGtaoAlphaMaskReferenceField,
  createForwardGtaoAlphaMaskScene,
  createForwardGtaoSkinReferenceField,
  createForwardGtaoSkinSubject,
} from './helpers/forward-gtao-scene';
import { createForwardGtaoSceneDataConsumer } from './helpers/forward-gtao-scene-data';
import { testAssets } from './helpers/runtime-assets';

type SurfaceCaptureHost = RendererHostAssembly['debugDrawHost'] &
  Pick<
    RendererLegacyHostAdapter,
    | 'getCurrentGraphTarget'
    | 'requestGraphTargetCapture'
    | 'cancelGraphTargetCapture'
    | 'setClusterWorkObservationForConformance'
    | 'clusterWorkObservationForConformance'
    | 'clusterWorkFrameTraceForConformance'
  >;

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

type RhiCaptureResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

type RhiCapturePort = {
  captureFrame(): Promise<RhiCaptureResult<EncodedTape>>;
  frameBoundary(): Promise<RhiCaptureResult<unknown>>;
};

async function captureRecordedReceiptFrame(input: {
  readonly recorder: RhiCapturePort;
  readonly draw: () => Promise<FrameReceipt>;
  readonly frameTrace: () => ReturnType<SurfaceCaptureHost['clusterWorkFrameTraceForConformance']>;
  readonly setFailureOperation: (operation: string) => void;
  readonly getFailureOperation: () => string;
}) {
  const capturePending = input.recorder.captureFrame().then(
    (result) => ({ status: 'settled' as const, result }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
  let receipt: FrameReceipt | undefined;
  let failure: { readonly error: unknown; readonly operation: string } | undefined;
  let boundaryClosed = false;
  input.setFailureOperation('skin-tape.capture-arm');
  try {
    value(await input.recorder.frameBoundary());
    receipt = await input.draw();
  } catch (error) {
    failure = { error, operation: input.getFailureOperation() };
  } finally {
    try {
      value(await input.recorder.frameBoundary());
      boundaryClosed = true;
    } catch (error) {
      if (failure === undefined) {
        input.setFailureOperation('skin-tape.frame-boundary-cleanup');
        failure = { error, operation: input.getFailureOperation() };
      }
    }
  }
  if (!boundaryClosed) {
    if (failure !== undefined) {
      input.setFailureOperation(failure.operation);
      throw failure.error;
    }
    throw new Error('Skin tape frame boundary did not close');
  }

  input.setFailureOperation('skin-tape.capture-finalize');
  const settledCapture = await capturePending;
  let tape: EncodedTape | undefined;
  if (settledCapture.status === 'rejected') {
    if (failure === undefined) {
      failure = { error: settledCapture.error, operation: input.getFailureOperation() };
    }
  } else {
    try {
      tape = value(settledCapture.result);
    } catch (error) {
      if (failure === undefined) {
        failure = { error, operation: input.getFailureOperation() };
      }
    }
  }
  if (failure !== undefined) {
    input.setFailureOperation(failure.operation);
    throw failure.error;
  }
  if (receipt === undefined) throw new Error('Skin tape draw did not return a receipt');
  if (tape === undefined) throw new Error('Skin tape capture did not return an artifact');
  return Object.freeze({ tape, receipt, frameTrace: input.frameTrace() });
}

function assertReadySkinTapeFrame(input: {
  readonly receipt: FrameReceipt;
  readonly frameTrace: ReturnType<SurfaceCaptureHost['clusterWorkFrameTraceForConformance']>;
  readonly observation: ReturnType<SurfaceCaptureHost['clusterWorkObservationForConformance']>;
}) {
  const { receipt, frameTrace, observation } = input;
  expect(receipt.presentation).toBe('ready');
  if (frameTrace === undefined) {
    throw new Error(`Skin tape receipt ${receipt.frameId} has no completed trace`);
  }
  expect(receipt.observationDomains).toContain('final-display');
  expect(receipt.graphGeneration).toEqual(expect.any(Number));
  expect(frameTrace.recordStatus).toBe('submitted');
  expect(frameTrace.observationFrameId).toBe(receipt.frameId);
  if (frameTrace.clusterWork?.status !== 'captured') {
    throw new Error(`Skin tape receipt ${receipt.frameId} has no captured frame work`);
  }
  expect(frameTrace.recordFrameNumber).toBe(frameTrace.clusterWork.frameNumber);
  expect(frameTrace.deviceGeneration).toBe(receipt.deviceGeneration);
  expect(frameTrace.graphGeneration).toBe(receipt.graphGeneration);
  expect(frameTrace.receipt).toMatchObject({
    publicReceiptFrameId: receipt.frameId,
    deviceGeneration: receipt.deviceGeneration,
    presentation: 'ready',
    completion: 'completed',
  });
  if (observation?.status !== 'captured') {
    throw new Error(`Skin tape receipt ${receipt.frameId} has no captured Cluster observation`);
  }
  expect(observation).toMatchObject({
    frameNumber: frameTrace.recordFrameNumber,
    deviceGeneration: receipt.deviceGeneration,
    graphGeneration: receipt.graphGeneration,
  });
  expect(frameTrace.clusterWork).toMatchObject(observation);
}

function rawReferenceMetrics(
  actual: Awaited<ReturnType<typeof captureForwardGtaoTarget>>,
  expected: Uint8Array,
) {
  return byteErrorMetrics(byteChannel(actual.bytes, actual.bytesPerTexel, 0), expected);
}

function targetCaptureIdentity(capture: Awaited<ReturnType<typeof captureForwardGtaoTarget>>) {
  return {
    target: capture.name,
    receipt: {
      publicReceiptFrameId: capture.publicReceiptFrameId,
      recordFrameNumber: capture.targetRecordFrameNumber,
      graphGeneration: capture.graphGeneration,
      textureIdentity: capture.textureIdentity,
      deviceGeneration: capture.deviceGeneration,
      presentation: 'ready',
    },
    format: capture.format,
    extent: [capture.width, capture.height],
    byteLength: capture.bytes.byteLength,
    frameTrace: capture.frameTrace,
  };
}

function verifySceneDataBytes(args: {
  readonly width: number;
  readonly height: number;
  readonly normalTarget: Uint8Array;
  readonly consumer: Uint8Array;
  readonly field: ReturnType<typeof createForwardGtaoAlphaMaskReferenceField>;
}) {
  const pixels = args.width * args.height;
  if (args.normalTarget.byteLength !== pixels * 4 || args.consumer.byteLength !== pixels * 8) {
    throw new Error(
      `surface consumer readback size mismatch: target=${args.normalTarget.byteLength}, consumer=${args.consumer.byteLength}, pixels=${pixels}`,
    );
  }
  const target = new DataView(
    args.normalTarget.buffer,
    args.normalTarget.byteOffset,
    args.normalTarget.byteLength,
  );
  const consumer = new DataView(
    args.consumer.buffer,
    args.consumer.byteOffset,
    args.consumer.byteLength,
  );
  let normalMismatchCount = 0;
  let depthCount = 0;
  let maximumDepthError = 0;
  let squaredDepthError = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    if (consumer.getUint32(pixel * 8, true) !== target.getUint32(pixel * 4, true)) {
      normalMismatchCount += 1;
    }
    const position = args.field.positions[pixel];
    if (position === undefined) continue;
    const expectedDepth = reverseZDeviceDepth(args.field.projection, position);
    const error = Math.abs(consumer.getFloat32(pixel * 8 + 4, true) - expectedDepth);
    maximumDepthError = Math.max(maximumDepthError, error);
    squaredDepthError += error * error;
    depthCount += 1;
  }
  return {
    normalMismatchCount,
    depth: {
      count: depthCount,
      maximumAbsolute: maximumDepthError,
      rmsAbsolute: Math.sqrt(squaredDepthError / Math.max(depthCount, 1)),
    },
  };
}

function pixelDepth(bytes: Uint8Array, width: number, x: number, y: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(
    (y * width + x) * 8 + 4,
    true,
  );
}

function pixelNormal(bytes: Uint8Array, width: number, x: number, y: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    (y * width + x) * 8,
    true,
  );
}

function skinVertexVariants(model: ReturnType<typeof buildFrameModel>) {
  return model.works.flatMap((work) => {
    if (work.pipeline.status !== 'available') return [];
    return work.pipeline.shaders.flatMap((shader) =>
      shader.stage === 'vertex' && shader.source?.includes('skinTaskBlend') === true
        ? [{ workIndex: work.workIndex, entryPoint: shader.entryPoint, source: shader.source }]
        : [],
    );
  });
}

function assertSurfaceIdentity(
  capture: Awaited<ReturnType<typeof captureForwardGtaoTarget>>,
  plan: NonNullable<
    ReturnType<ReturnType<typeof createForwardGtaoSceneDataConsumer>['latestPlan']>
  >,
) {
  expect(plan.normal.schema).toBe('forgeax::scene-data::standard-surface-normal-v1');
  expect(plan.depth.schema).toBe('forgeax::scene-data::standard-surface-depth-v1');
  expect(plan.normalOwner).toMatchObject({
    featureIdentity: expect.any(String),
    viewIdentity: plan.viewIdentity,
    planIdentity: expect.any(String),
    generation: expect.any(Number),
    deviceGeneration: capture.deviceGeneration,
    surfaceAdmissionIdentity: expect.any(String),
    surfaceAdmissionRevision: expect.any(Number),
  });
  expect(plan.depthOwner).toMatchObject({
    featureIdentity: plan.normalOwner?.featureIdentity,
    viewIdentity: plan.viewIdentity,
    planIdentity: plan.normalOwner?.planIdentity,
    generation: plan.normalOwner?.generation,
    deviceGeneration: capture.deviceGeneration,
    surfaceAdmissionIdentity: plan.normalOwner?.surfaceAdmissionIdentity,
    surfaceAdmissionRevision: plan.normalOwner?.surfaceAdmissionRevision,
  });
  expect(capture.graphGeneration).toBe(capture.preparation.graphGeneration);
  expect(capture.textureIdentity).toBe(capture.preparation.textureIdentity);
  expect(capture.preparation.descriptor).toEqual({
    format: capture.format,
    size: { width: capture.width, height: capture.height },
    usage: capture.usage,
    sample: capture.sample,
  });
}

it('samples the admitted SceneData tokens for Alpha Mask holes and posed Skin AO', {
  timeout: 180_000,
}, async () => {
  const width = 129;
  const height = 97;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  document.body.append(canvas);
  if (canvas.getContext('webgpu') === null) {
    throw new Error('WebGPU surface semantics canvas context is unavailable');
  }
  const recorder = value(attachRecorder(webgpu));
  const profiler = createProfiler();
  const surfaceConsumer = createForwardGtaoSceneDataConsumer(width, height);
  const assembly = value(
    await constructRuntimeRendererHost(canvas, {
      rhi: recorder.backend.rhi,
      profiler,
      features: [surfaceConsumer.feature],
    }),
  );
  const renderer = assembly.renderer;
  const debugHost = assembly.debugDrawHost as SurfaceCaptureHost;
  debugHost.setClusterWorkObservationForConformance(true);
  const observationBuffer = value(
    debugHost.device.createBuffer({
      label: 'forward-gtao.surface-semantics.consumer-output',
      size: surfaceConsumer.observationBytes,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
    }),
  );
  surfaceConsumer.setObservationBuffer(observationBuffer);
  const world = new World({ assets: assembly.assets });
  const scene = createForwardGtaoAlphaMaskScene(world);
  const assets = testAssets(world);
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: width / height,
          near: 0.1,
          far: 30,
          tonemap: 0,
          antialias: 0,
          bloom: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
      {
        component: AmbientOcclusion,
        data: {
          algorithm: AMBIENT_OCCLUSION_GTAO,
          directLightingStrength: 0,
          radius: 1.25,
          bias: 0,
          intensity: 4,
          thickness: 1,
          distanceExponent: 1,
          distanceFallOff: 1,
          resolutionScale: 0.5,
          quality: AMBIENT_OCCLUSION_QUALITY_HIGH,
        },
      },
    )
    .unwrap();
  world.spawn({ component: Skylight, data: {} }).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 2, -2] } },
      { component: PointLight, data: { intensity: 4, range: 12 } },
    )
    .unwrap();
  const lease = value(renderer.attach(world));
  const plansByReceipt = new Map<
    number,
    NonNullable<ReturnType<typeof surfaceConsumer.latestPlan>>
  >();
  const events: unknown[] = [];
  let failureOperation = 'renderer.setup';
  let failureReceipt: unknown;
  let failureFrameTrace: unknown = { status: 'not-obtained' };
  let failureFrameSummary: unknown = { status: 'not-obtained' };
  let failureDiagnostics: unknown = { status: 'not-obtained' };
  let failureReadback: unknown;
  const draw = async () => {
    failureOperation = 'renderer.draw';
    propagateTransforms(world).unwrap();
    world.update(1 / 60).unwrap();
    const requested = renderer.requestObservation?.(['final-display']);
    if (requested === undefined) throw new Error('final-display observation is unavailable');
    value(requested);
    const result = renderer.draw({
      leases: [lease],
      camera: { lease, entityKey: camera },
      environment: { lease },
    });
    if (result === undefined) throw new Error('Renderer draw is unavailable');
    const receipt = value(result);
    failureReceipt = {
      frameId: receipt.frameId,
      deviceGeneration: receipt.deviceGeneration,
      presentation: receipt.presentation,
      presentationPendingReason: receipt.presentationPendingReason ?? null,
    };
    const plan = surfaceConsumer.latestPlan();
    failureOperation = 'receipt.completed';
    value(await receipt.completed);
    failureFrameTrace = debugHost.clusterWorkFrameTraceForConformance() ?? {
      status: 'not-obtained',
    };
    failureOperation = 'renderer.errors';
    throwForForwardGtaoRendererErrors({
      errors: events,
      output: renderer.inspect().output,
      receipt: failureReceipt,
      frameTrace: failureFrameTrace,
    });
    failureFrameSummary = {
      frameId: receipt.frameId,
      featureFrameNumber: plan?.frameNumber,
      planIdentity: plan?.normalOwner?.planIdentity,
      generation: plan?.normalOwner?.generation,
      presentation: receipt.presentation,
    };
    failureDiagnostics = { frameSummary: failureFrameSummary };
    if (receipt.presentation === 'ready') {
      failureOperation = 'renderer.observe(final-display)';
      value(await renderer.observe(receipt, { include: ['final-display'] }));
    }
    if (plan !== undefined) plansByReceipt.set(receipt.frameId, plan);
    return receipt;
  };
  const settleSurfaceConsumer = async () => {
    const startedAt = Date.now();
    const deadline = startedAt + 30_000;
    const presentations = new Map<string, number>();
    let attempts = 0;
    let lastReceipt:
      | {
          readonly frameId: number;
          readonly presentation: string;
          readonly pendingReason: unknown;
        }
      | undefined;
    while (Date.now() < deadline) {
      attempts += 1;
      const receipt = await draw();
      const presentation = String(receipt.presentation);
      presentations.set(presentation, (presentations.get(presentation) ?? 0) + 1);
      lastReceipt = {
        frameId: receipt.frameId,
        presentation,
        pendingReason: receipt.presentationPendingReason ?? null,
      };
      if (receipt.presentation !== 'ready') {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        continue;
      }
      const plan = plansByReceipt.get(receipt.frameId);
      const trace = debugHost.clusterWorkFrameTraceForConformance();
      const target = debugHost.getCurrentGraphTarget('standard-scene-surface-normal');
      if (plan === undefined || trace === undefined || target === undefined) {
        throw new Error(
          `ready SceneData settlement omitted its plan, trace, or surface target: ${JSON.stringify({
            receiptFrameId: receipt.frameId,
            plan,
            trace,
            targetAvailable: target !== undefined,
          })}`,
        );
      }
      expect(trace.recordStatus).toBe('submitted');
      expect(trace.observationFrameId).toBe(receipt.frameId);
      expect(trace.receipt).toMatchObject({
        publicReceiptFrameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        presentation: 'ready',
        completion: 'completed',
      });
      expect(target.recordFrameNumber).toBe(trace.recordFrameNumber);
      expect(target.graphGeneration).toBe(trace.graphGeneration);
      const inspection = renderer.inspect();
      expect(inspection.output.graphPassNames).toEqual(
        expect.arrayContaining(['standard-scene-surface-data', 'ssao-calc', 'ssao-blur']),
      );
      expect(inspection.perFramePassNames).toContain('surface-normal-depth-consumer');
      if (plan.normalOwner === undefined || plan.depthOwner === undefined) {
        throw new Error(`completed SceneData settlement has no token owner for ${receipt.frameId}`);
      }
      expect(plan.normal.schema).toBe('forgeax::scene-data::standard-surface-normal-v1');
      expect(plan.depth.schema).toBe('forgeax::scene-data::standard-surface-depth-v1');
      expect(plan.normalOwner).toMatchObject({
        featureIdentity: expect.any(String),
        viewIdentity: plan.viewIdentity,
        planIdentity: expect.any(String),
        generation: expect.any(Number),
        deviceGeneration: receipt.deviceGeneration,
        surfaceAdmissionIdentity: expect.any(String),
        surfaceAdmissionRevision: expect.any(Number),
      });
      expect(plan.depthOwner).toMatchObject({
        featureIdentity: plan.normalOwner.featureIdentity,
        viewIdentity: plan.normalOwner.viewIdentity,
        planIdentity: plan.normalOwner.planIdentity,
        generation: plan.normalOwner.generation,
        deviceGeneration: plan.normalOwner.deviceGeneration,
        surfaceAdmissionIdentity: plan.normalOwner.surfaceAdmissionIdentity,
        surfaceAdmissionRevision: plan.normalOwner.surfaceAdmissionRevision,
      });
      expect(events).toEqual([]);
      return Object.freeze({
        publicReceiptFrameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        featureFrameNumber: plan.frameNumber,
        recordFrameNumber: trace.recordFrameNumber,
        graphGeneration: target.graphGeneration,
        textureIdentity: target.textureIdentity,
        owner: Object.freeze({ ...plan.normalOwner }),
        descriptor: {
          format: target.descriptor.format,
          size: {
            width: target.descriptor.size.width,
            height: target.descriptor.size.height,
          },
          usage: target.descriptor.usage,
          sample: target.descriptor.sample,
        },
      });
    }
    const inspection = renderer.inspect();
    const trace = debugHost.clusterWorkFrameTraceForConformance();
    throw new Error(
      `SceneData consumer did not reach a completed ready settlement frame: ${JSON.stringify({
        attempts,
        elapsedMs: Date.now() - startedAt,
        presentations: [...presentations.entries()],
        lastReceipt,
        latestPlanFrameNumber: surfaceConsumer.latestPlan()?.frameNumber ?? null,
        latestSubmittedWork: surfaceConsumer.submittedWorkSnapshots().at(-1) ?? null,
        backend: inspection.capabilities.backendKind,
        graphPassNames: inspection.output.graphPassNames,
        frameTrace:
          trace === undefined
            ? null
            : {
                recordStatus: trace.recordStatus,
                recordFrameNumber: trace.recordFrameNumber,
                observationFrameId: trace.observationFrameId,
              },
      })}`,
    );
  };
  const captureTarget = async (name: 'standard-scene-surface-normal' | 'ssao-raw') => {
    failureOperation = `capture-target:${name}`;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const capture = await captureForwardGtaoTarget(debugHost, name, draw);
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
        failureDiagnostics = { frameSummary: failureFrameSummary };
        return capture;
      } catch (error) {
        if (!(error instanceof ForwardGtaoCaptureNotReadyError)) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error(`${name} surface semantics capture did not become ready`);
  };
  const captureSurface = async () => {
    surfaceConsumer.setEnabled(true);
    try {
      const settlement = await settleSurfaceConsumer();
      const normal = await captureTarget('standard-scene-surface-normal');
      expect(renderer.inspect().perFramePassNames).toContain('surface-normal-depth-consumer');
      expect(normal.preparation.recordFrameNumber).toBeGreaterThan(settlement.recordFrameNumber);
      expect(normal.preparation.graphGeneration).toBe(settlement.graphGeneration);
      expect(normal.preparation.textureIdentity).toBe(settlement.textureIdentity);
      expect(normal.preparation.descriptor).toEqual(settlement.descriptor);
      const plan = plansByReceipt.get(normal.publicReceiptFrameId);
      if (plan === undefined) {
        throw new Error(
          `SceneData consumer omitted completed receipt ${normal.publicReceiptFrameId}`,
        );
      }
      expect(plan.normalOwner).toMatchObject(settlement.owner);
      expect(plan.depthOwner).toMatchObject(settlement.owner);
      const output = await captureForwardGtaoBuffer(
        debugHost,
        observationBuffer,
        surfaceConsumer.observationBytes,
      );
      failureOperation = 'scene-data-consumer-readback';
      failureReadback = {
        target: 'surface-normal-depth-consumer',
        frameId: normal.publicReceiptFrameId,
        graphGeneration: normal.graphGeneration,
        textureIdentity: normal.textureIdentity,
        format: 'rgba32float',
        byteLength: output.byteLength,
        sha256: await sha256Hex(output),
      };
      return { normal, output, plan, settlement };
    } finally {
      surfaceConsumer.setEnabled(false);
    }
  };
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') events.push(event.error);
  });
  try {
    expect(renderer.inspect().capabilities.backendKind).toBe('webgpu');
    expect(scene.alphaTexture).toBeDefined();
    expect(scene.normalTexture).toBeDefined();

    const alphaField = createForwardGtaoAlphaMaskReferenceField(width, height);
    const alphaSurface = await captureSurface();
    const alphaRaw = await captureTarget('ssao-raw');
    const alphaInspection = renderer.inspect().standardLighting?.ambientOcclusion;
    if (alphaInspection === undefined || alphaInspection.status !== 'active') {
      throw new Error('Alpha Mask GTAO inspection is not active');
    }
    expect(alphaInspection.algorithm).toBe('gtao');
    const alphaMetrics = verifySceneDataBytes({
      width,
      height,
      normalTarget: alphaSurface.normal.bytes,
      consumer: alphaSurface.output,
      field: alphaField,
    });
    const alphaRawReference = computeGtaoRawReference(alphaField, {
      outputWidth: alphaRaw.width,
      outputHeight: alphaRaw.height,
      radius: alphaInspection.numerical.radius,
      bias: alphaInspection.numerical.bias,
      thickness: alphaInspection.numerical.thickness,
      distanceExponent: alphaInspection.numerical.distanceExponent,
      distanceFallOff: alphaInspection.numerical.distanceFallOff,
      sampleBudget: alphaInspection.numerical.sampleBudget,
      intensity: alphaInspection.numerical.intensity,
    });
    const alphaRawMetrics = rawReferenceMetrics(
      alphaRaw,
      byteChannel(alphaRawReference.rgba, 4, 0),
    );
    const holeX = Math.floor(width * 0.25);
    const keptX = Math.floor(width * 0.75);
    const sampleY = Math.floor(height / 2);
    const holePosition = alphaField.positions[sampleY * width + holeX];
    const keptPosition = alphaField.positions[sampleY * width + keptX];
    const holeOutputX = Math.floor(((holeX + 0.5) / width) * alphaRaw.width);
    const holeOutputY = Math.floor(((sampleY + 0.5) / height) * alphaRaw.height);
    world.removeComponent(scene.foreground, MeshRenderer).unwrap();
    const backgroundOnlyRaw = await captureTarget('ssao-raw');
    const maskedHoleVisibility =
      alphaRaw.bytes[(holeOutputY * alphaRaw.width + holeOutputX) * alphaRaw.bytesPerTexel];
    const backgroundVisibility =
      backgroundOnlyRaw.bytes[
        (holeOutputY * backgroundOnlyRaw.width + holeOutputX) * backgroundOnlyRaw.bytesPerTexel
      ];
    const holeBackgroundDelta = Math.abs((maskedHoleVisibility ?? 0) - (backgroundVisibility ?? 0));
    const backgroundControlFrameSummary = failureFrameSummary;
    const holeNormal = decodeMaterialNormalX12Y12(
      pixelNormal(alphaSurface.output, width, holeX, sampleY),
    );
    const keptNormal = decodeMaterialNormalX12Y12(
      pixelNormal(alphaSurface.output, width, keptX, sampleY),
    );
    await commands.writeFile(
      'packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-alpha-mask-surface.json',
      JSON.stringify(
        {
          schema: 'forgeax::forward-gtao-alpha-mask-surface-evidence::1',
          input: {
            fixture: 'standard-alpha-green-2x1-hole-and-keep',
            width,
            height,
            alphaTextureHandle: Number(scene.alphaTexture),
            alphaTextureSha256: await sha256Hex(
              new Uint8Array([255, 0, 255, 255, 255, 255, 255, 255]),
            ),
            normalTextureHandle: Number(scene.normalTexture),
            normalTextureSha256: await sha256Hex(new Uint8Array([250, 128, 0, 255])),
            alphaChannel: 1,
            alphaCutoff: 0.5,
          },
          surface: {
            settlement: alphaSurface.settlement,
            frame: alphaSurface.normal.publicReceiptFrameId,
            recordFrameNumber: alphaSurface.normal.targetRecordFrameNumber,
            graphGeneration: alphaSurface.normal.graphGeneration,
            textureIdentity: alphaSurface.normal.textureIdentity,
            deviceGeneration: alphaSurface.normal.deviceGeneration,
            owner: alphaSurface.plan.normalOwner,
            depthOwner: alphaSurface.plan.depthOwner,
            normal: {
              byteLength: alphaSurface.normal.bytes.byteLength,
              base64: base64Bytes(alphaSurface.normal.bytes),
            },
            consumer: {
              byteLength: alphaSurface.output.byteLength,
              base64: base64Bytes(alphaSurface.output),
              metrics: alphaMetrics,
            },
            hole: {
              x: holeX,
              y: sampleY,
              position: holePosition,
              depth: pixelDepth(alphaSurface.output, width, holeX, sampleY),
              normalWord: pixelNormal(alphaSurface.output, width, holeX, sampleY),
            },
            kept: {
              x: keptX,
              y: sampleY,
              position: keptPosition,
              depth: pixelDepth(alphaSurface.output, width, keptX, sampleY),
              normalWord: pixelNormal(alphaSurface.output, width, keptX, sampleY),
            },
          },
          ao: {
            frame: alphaRaw.publicReceiptFrameId,
            graphGeneration: alphaRaw.graphGeneration,
            textureIdentity: alphaRaw.textureIdentity,
            format: alphaRaw.format,
            extent: [alphaRaw.width, alphaRaw.height],
            bytes: {
              byteLength: alphaRaw.bytes.byteLength,
              sha256: await sha256Hex(alphaRaw.bytes),
              base64: base64Bytes(alphaRaw.bytes),
            },
            reference: alphaRawMetrics,
            holeVisibility:
              alphaRaw.bytes[(holeOutputY * alphaRaw.width + holeOutputX) * alphaRaw.bytesPerTexel],
            backgroundOnly: {
              frame: backgroundOnlyRaw.publicReceiptFrameId,
              graphGeneration: backgroundOnlyRaw.graphGeneration,
              textureIdentity: backgroundOnlyRaw.textureIdentity,
              holeVisibility: backgroundVisibility,
              differenceAtHole: holeBackgroundDelta,
              bytes: {
                byteLength: backgroundOnlyRaw.bytes.byteLength,
                sha256: await sha256Hex(backgroundOnlyRaw.bytes),
                base64: base64Bytes(backgroundOnlyRaw.bytes),
              },
            },
          },
        },
        null,
        2,
      ),
    );
    assertSurfaceIdentity(alphaSurface.normal, alphaSurface.plan);
    expect(alphaMetrics.normalMismatchCount).toBe(0);
    expect(alphaMetrics.depth.count).toBe(width * height);
    expect(alphaMetrics.depth.maximumAbsolute).toBeLessThanOrEqual(1e-5);
    failureOperation = 'alpha-mask.raw-gtao-reference-comparison';
    failureReceipt = {
      publicReceiptFrameId: alphaRaw.publicReceiptFrameId,
      recordFrameNumber: alphaRaw.targetRecordFrameNumber,
      graphGeneration: alphaRaw.graphGeneration,
      textureIdentity: alphaRaw.textureIdentity,
      deviceGeneration: alphaRaw.deviceGeneration,
      presentation: 'ready',
    };
    failureFrameTrace = alphaRaw.frameTrace;
    failureFrameSummary = {
      frameId: alphaRaw.publicReceiptFrameId,
      recordFrameNumber: alphaRaw.targetRecordFrameNumber,
      graphGeneration: alphaRaw.graphGeneration,
      presentation: 'ready',
      capture: 'alpha-mask-ssao-raw',
    };
    failureReadback = {
      target: 'ssao-raw',
      capture: 'alpha-mask',
      frameId: alphaRaw.publicReceiptFrameId,
      format: alphaRaw.format,
      width: alphaRaw.width,
      height: alphaRaw.height,
      byteLength: alphaRaw.bytes.byteLength,
      sha256: await sha256Hex(alphaRaw.bytes),
      reference: alphaRawMetrics,
    };
    failureDiagnostics = {
      frameSummary: failureFrameSummary,
      alphaRawComparison: {
        captureFrameId: alphaRaw.publicReceiptFrameId,
        recordFrameNumber: alphaRaw.targetRecordFrameNumber,
        graphGeneration: alphaRaw.graphGeneration,
        textureIdentity: alphaRaw.textureIdentity,
        reference: alphaRawMetrics,
        budget: {
          maxAbsoluteByteError: GTAO_COMPARISON_BUDGET.rawVisibilityMaxByteError,
          rmsByteError: GTAO_COMPARISON_BUDGET.rawVisibilityRmsByteError,
        },
      },
      backgroundControl: {
        frameSummary: backgroundControlFrameSummary,
        receipt: {
          publicReceiptFrameId: backgroundOnlyRaw.publicReceiptFrameId,
          deviceGeneration: backgroundOnlyRaw.deviceGeneration,
          presentation: 'ready',
        },
        frameTrace: backgroundOnlyRaw.frameTrace,
        capture: {
          target: 'ssao-raw',
          recordFrameNumber: backgroundOnlyRaw.targetRecordFrameNumber,
          graphGeneration: backgroundOnlyRaw.graphGeneration,
          textureIdentity: backgroundOnlyRaw.textureIdentity,
          width: backgroundOnlyRaw.width,
          height: backgroundOnlyRaw.height,
          byteLength: backgroundOnlyRaw.bytes.byteLength,
          sha256: await sha256Hex(backgroundOnlyRaw.bytes),
        },
        holeVisibility: backgroundVisibility,
        differenceAtHole: holeBackgroundDelta,
      },
    };
    expect(alphaRawMetrics.maxAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.rawVisibilityMaxByteError,
    );
    expect(alphaRawMetrics.rms).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.rawVisibilityRmsByteError,
    );
    expect(holePosition?.[2]).toBeLessThan(-5.8);
    expect(keptPosition?.[2]).toBeGreaterThan(-4.1);
    expect(holeNormal[2]).toBeGreaterThan(0.999);
    expect(keptNormal[0]).toBeGreaterThan(0.96);
    expect(holeBackgroundDelta).toBeLessThanOrEqual(1);

    const skinNormalTexture = assets
      .create({
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mips: { kind: 'none' },
        data: new Uint8Array([191, 159, 234, 255]),
      })
      .unwrap();
    const skinMaterial = Materials.standard({
      baseColor: [0.7, 0.5, 0.3, 1],
      roughness: 0.8,
      metallic: 0,
      normalTexture: { texture: skinNormalTexture },
      emissive: [0.02, 0.01, 0.005],
    });
    const pose: readonly [number, number, number] = [0.55, 0.15, -4];
    const skin = createForwardGtaoSkinSubject(world, assets, skinMaterial, pose);
    const skinSurface = await captureSurface();
    const skinRaw = await captureTarget('ssao-raw');
    const skinRawSha256 = await sha256Hex(skinRaw.bytes);
    const settledSkinSurfaceEvidence = {
      settlement: skinSurface.settlement,
      capture: targetCaptureIdentity(skinSurface.normal),
      owner: skinSurface.plan.normalOwner,
      depthOwner: skinSurface.plan.depthOwner,
    };
    let posedSkinRawEvidence: {
      readonly capture: ReturnType<typeof targetCaptureIdentity>;
      readonly aoInspection?: unknown;
    } = { capture: targetCaptureIdentity(skinRaw) };
    failureOperation = 'posed-skin.ao-inspection';
    failureReceipt = targetCaptureIdentity(skinRaw).receipt;
    failureFrameTrace = skinRaw.frameTrace;
    failureFrameSummary = {
      frameId: skinRaw.publicReceiptFrameId,
      recordFrameNumber: skinRaw.targetRecordFrameNumber,
      graphGeneration: skinRaw.graphGeneration,
      presentation: 'ready',
      capture: 'posed-skin-ssao-raw',
    };
    failureReadback = {
      target: 'ssao-raw',
      capture: 'posed-skin',
      frameId: skinRaw.publicReceiptFrameId,
      graphGeneration: skinRaw.graphGeneration,
      textureIdentity: skinRaw.textureIdentity,
      byteLength: skinRaw.bytes.byteLength,
      sha256: skinRawSha256,
    };
    failureDiagnostics = {
      frameSummary: failureFrameSummary,
      settledSkinSurface: settledSkinSurfaceEvidence,
      posedSkinRaw: posedSkinRawEvidence,
    };
    const skinInspection = renderer.inspect().standardLighting?.ambientOcclusion;
    if (skinInspection === undefined || skinInspection.status !== 'active') {
      throw new Error('Posed Skin GTAO inspection is not active');
    }
    const skinAoInspectionEvidence = {
      status: skinInspection.status,
      algorithm: skinInspection.algorithm,
      graphGeneration: skinInspection.graphGeneration,
      numerical: skinInspection.numerical,
    };
    posedSkinRawEvidence = {
      capture: targetCaptureIdentity(skinRaw),
      aoInspection: skinAoInspectionEvidence,
    };
    failureDiagnostics = {
      frameSummary: failureFrameSummary,
      settledSkinSurface: settledSkinSurfaceEvidence,
      posedSkinRaw: posedSkinRawEvidence,
    };
    expect(skinInspection.graphGeneration).toBe(skinRaw.graphGeneration);

    failureOperation = 'skin-tape.capture';
    failureReceipt = { status: 'not-obtained', reason: 'tape draw has not submitted' };
    failureFrameTrace = { status: 'not-obtained' };
    failureReadback = { status: 'not-applicable', artifact: 'rhi-command-tape' };
    failureFrameSummary = { status: 'not-obtained', capture: 'skin-rhi-command-tape' };
    failureDiagnostics = {
      frameSummary: failureFrameSummary,
      settledSkinSurface: settledSkinSurfaceEvidence,
      posedSkinRaw: posedSkinRawEvidence,
    };
    let completedSkinTapeFrameTrace:
      | ReturnType<typeof debugHost.clusterWorkFrameTraceForConformance>
      | undefined;
    let completedSkinTapeObservation:
      | ReturnType<typeof debugHost.clusterWorkObservationForConformance>
      | undefined;
    const skinTapeCapture = await captureRecordedReceiptFrame({
      recorder,
      draw: async () => {
        const receipt = await draw();
        completedSkinTapeFrameTrace = debugHost.clusterWorkFrameTraceForConformance();
        completedSkinTapeObservation = debugHost.clusterWorkObservationForConformance();
        return receipt;
      },
      frameTrace: () => completedSkinTapeFrameTrace,
      setFailureOperation: (operation) => {
        failureOperation = operation;
      },
      getFailureOperation: () => failureOperation,
    });
    const skinTape = skinTapeCapture.tape;
    const skinTapeReceipt = skinTapeCapture.receipt;
    const skinTapeFrameTrace = skinTapeCapture.frameTrace;
    const skinTapeObservation = completedSkinTapeObservation;
    failureOperation = 'skin-tape.decode-and-readiness';
    failureReceipt = {
      publicReceiptFrameId: skinTapeReceipt.frameId,
      graphGeneration: skinTapeReceipt.graphGeneration ?? null,
      deviceGeneration: skinTapeReceipt.deviceGeneration,
      presentation: skinTapeReceipt.presentation,
      presentationPendingReason: skinTapeReceipt.presentationPendingReason ?? null,
      observationDomains: skinTapeReceipt.observationDomains ?? null,
    };
    failureFrameTrace = skinTapeFrameTrace ?? { status: 'not-obtained' };
    failureReadback = {
      status: 'not-applicable',
      artifact: 'rhi-command-tape',
      digest: skinTape.digest,
      byteLength: skinTape.byteLength,
    };
    const skinTapeSha256 = await sha256Hex(skinTape.bytes);
    failureFrameSummary = {
      frameId: skinTapeReceipt.frameId,
      recordFrameNumber: skinTapeFrameTrace?.recordFrameNumber ?? null,
      graphGeneration: skinTapeFrameTrace?.graphGeneration ?? null,
      presentation: skinTapeReceipt.presentation,
      capture: 'skin-rhi-command-tape',
    };
    failureDiagnostics = {
      frameSummary: failureFrameSummary,
      skinTapeCapture: {
        receipt: failureReceipt,
        completedTrace: skinTapeFrameTrace ?? { status: 'not-obtained' },
        digest: skinTape.digest,
        byteLength: skinTape.byteLength,
        sha256: skinTapeSha256,
        ...(skinTapeReceipt.presentation === 'pending'
          ? { bytesBase64: base64Bytes(skinTape.bytes) }
          : {}),
      },
      settledSkinSurface: settledSkinSurfaceEvidence,
      posedSkinRaw: posedSkinRawEvidence,
    };
    const skinTapeModel = buildFrameModel(value(decodeTape(skinTape.bytes)));
    const skinVariants = skinVertexVariants(skinTapeModel);
    const selectedSkinMaterial = assets.read(skin.material).unwrap();
    const capturedFragmentSources = skinTapeModel.works.flatMap((work) =>
      work.pipeline.status === 'available'
        ? work.pipeline.shaders.flatMap((shader) =>
            shader.stage === 'fragment' &&
            shader.source !== null &&
            shader.source.includes('sampleStandardAmbientOcclusion')
              ? [{ workIndex: work.workIndex, source: shader.source }]
              : [],
          )
        : [],
    );
    const skinLineage = capturedFragmentSources.flatMap((captured) => {
      try {
        return [
          {
            workIndex: captured.workIndex,
            lineage: resolveForwardGtaoMaterialLineage(
              assets.shaderRegistry,
              selectedSkinMaterial,
              captured.source,
            ),
          },
        ];
      } catch {
        return [];
      }
    });
    const skinSourceIdentity = await Promise.all(
      skinVariants.map(async (variant) => ({
        workIndex: variant.workIndex,
        entryPoint: variant.entryPoint,
        sourceSha256: await sha256Hex(new TextEncoder().encode(variant.source)),
      })),
    );
    const skinTapePipelineRecipe = skinTapeModel.works.map((work) => ({
      workIndex: work.workIndex,
      eventIndex: work.eventIndex,
      passIndex: work.passIndex,
      kind: work.kind,
      pipeline:
        work.pipeline.status === 'available'
          ? {
              status: work.pipeline.status,
              pipelineHandleId: work.pipeline.pipelineHandleId,
              kind: work.pipeline.kind,
              descriptor: work.pipeline.descriptor,
              shaders: work.pipeline.shaders.map(({ stage, moduleHandleId, entryPoint }) => ({
                stage,
                moduleHandleId,
                entryPoint,
              })),
            }
          : { status: work.pipeline.status, reason: work.pipeline.reason },
    }));
    const skinTapeEvidence = {
      digest: skinTape.digest,
      byteLength: skinTape.byteLength,
      sha256: skinTapeSha256,
      receipt: failureReceipt,
      completedTrace: skinTapeFrameTrace ?? { status: 'not-obtained' },
      clusterObservation: skinTapeObservation ?? { status: 'not-obtained' },
      frameSummary: summarizeFrame(skinTapeModel),
      pipelineRecipe: skinTapePipelineRecipe,
      selectedMaterial: {
        handle: Number(skin.material),
        forwardPass: selectedSkinMaterial.passes?.find((pass) => pass.name === 'forward'),
      },
      capturedSkinVertexVariants: skinSourceIdentity,
      fragmentLineage: skinLineage,
      ...(skinTapeReceipt.presentation === 'pending'
        ? { bytesBase64: base64Bytes(skinTape.bytes) }
        : {}),
    };
    failureOperation = 'skin-tape.readiness';
    failureDiagnostics = {
      frameSummary: failureFrameSummary,
      skinTapeReadiness: skinTapeEvidence,
      settledSkinSurface: settledSkinSurfaceEvidence,
      posedSkinRaw: posedSkinRawEvidence,
    };
    expect(skinTape.byteLength).toBe(skinTape.bytes.byteLength);
    expect(skinTape.digest).toBe(`sha256:${skinTapeSha256}`);
    failureOperation = 'skin-tape.readiness';
    assertReadySkinTapeFrame({
      receipt: skinTapeReceipt,
      frameTrace: skinTapeFrameTrace,
      observation: skinTapeObservation,
    });
    failureOperation = 'skin-tape.material-variant-lineage';
    expect(
      selectedSkinMaterial.passes?.find((pass) => pass.name === 'forward')?.program.module,
    ).toBe('forgeax::pbr-skin');
    expect(skinVariants.length).toBeGreaterThan(0);
    expect(skinLineage.length).toBeGreaterThan(0);
    world.set(skin.joint, Transform, { pos: [0, 0, -4] }).unwrap();
    const unposedGpuRaw = await captureTarget('ssao-raw');
    const unposedRawSha256 = await sha256Hex(unposedGpuRaw.bytes);
    const unposedControlEvidence = targetCaptureIdentity(unposedGpuRaw);
    failureOperation = 'unposed-skin.gtao-inspection';
    failureReceipt = unposedControlEvidence.receipt;
    failureFrameTrace = unposedGpuRaw.frameTrace;
    failureFrameSummary = {
      frameId: unposedGpuRaw.publicReceiptFrameId,
      recordFrameNumber: unposedGpuRaw.targetRecordFrameNumber,
      graphGeneration: unposedGpuRaw.graphGeneration,
      presentation: 'ready',
      capture: 'unposed-skin-ssao-raw-control',
    };
    failureReadback = {
      target: 'ssao-raw',
      capture: 'unposed-control',
      format: unposedGpuRaw.format,
      width: unposedGpuRaw.width,
      height: unposedGpuRaw.height,
      byteLength: unposedGpuRaw.bytes.byteLength,
      sha256: unposedRawSha256,
    };
    failureDiagnostics = {
      frameSummary: failureFrameSummary,
      skinTapeReadiness: skinTapeEvidence,
      settledSkinSurface: settledSkinSurfaceEvidence,
      posedSkinRaw: posedSkinRawEvidence,
      unposedControl: unposedControlEvidence,
    };
    const skinField = createForwardGtaoSkinReferenceField(width, height, pose);
    const unposedField = createForwardGtaoSkinReferenceField(width, height, [0, 0, -4]);
    const skinMetrics = verifySceneDataBytes({
      width,
      height,
      normalTarget: skinSurface.normal.bytes,
      consumer: skinSurface.output,
      field: skinField,
    });
    const skinRawReference = computeGtaoRawReference(skinField, {
      outputWidth: skinRaw.width,
      outputHeight: skinRaw.height,
      radius: skinInspection.numerical.radius,
      bias: skinInspection.numerical.bias,
      thickness: skinInspection.numerical.thickness,
      distanceExponent: skinInspection.numerical.distanceExponent,
      distanceFallOff: skinInspection.numerical.distanceFallOff,
      sampleBudget: skinInspection.numerical.sampleBudget,
      intensity: skinInspection.numerical.intensity,
    });
    const unposedRawReference = computeGtaoRawReference(unposedField, {
      ...skinInspection.numerical,
      outputWidth: skinRaw.width,
      outputHeight: skinRaw.height,
    });
    const skinRawMetrics = rawReferenceMetrics(skinRaw, byteChannel(skinRawReference.rgba, 4, 0));
    const unposedVisibilityDelta = byteErrorMetrics(
      byteChannel(skinRawReference.rgba, 4, 0),
      byteChannel(unposedRawReference.rgba, 4, 0),
    );
    const actualPoseVisibilityDelta = byteErrorMetrics(
      byteChannel(skinRaw.bytes, skinRaw.bytesPerTexel, 0),
      byteChannel(unposedGpuRaw.bytes, unposedGpuRaw.bytesPerTexel, 0),
    );
    const skinNormalSha256 = await sha256Hex(skinSurface.normal.bytes);
    const skinConsumerSha256 = await sha256Hex(skinSurface.output);
    const posedSkinRawComparison = {
      capture: posedSkinRawEvidence.capture,
      reference: skinRawMetrics,
      budget: {
        maxAbsoluteByteError: GTAO_COMPARISON_BUDGET.rawVisibilityMaxByteError,
        rmsByteError: GTAO_COMPARISON_BUDGET.rawVisibilityRmsByteError,
      },
      independentUnposedVsPosedReference: unposedVisibilityDelta,
      actualPoseDelta: actualPoseVisibilityDelta,
      sha256: skinRawSha256,
    };
    const unposedControl = {
      capture: unposedControlEvidence,
      independentReferenceVisibilityDelta: unposedVisibilityDelta,
      sha256: unposedRawSha256,
      actualPoseDelta: actualPoseVisibilityDelta,
    };
    failureOperation = 'posed-skin.raw-gtao-reference-comparison';
    failureReceipt = posedSkinRawEvidence.capture.receipt;
    failureFrameTrace = skinRaw.frameTrace;
    failureFrameSummary = {
      frameId: skinRaw.publicReceiptFrameId,
      recordFrameNumber: skinRaw.targetRecordFrameNumber,
      graphGeneration: skinRaw.graphGeneration,
      textureIdentity: skinRaw.textureIdentity,
      presentation: 'ready',
      capture: 'posed-skin-ssao-raw-comparison',
    };
    failureReadback = {
      target: 'ssao-raw',
      capture: 'posed-skin',
      format: skinRaw.format,
      width: skinRaw.width,
      height: skinRaw.height,
      byteLength: skinRaw.bytes.byteLength,
      sha256: skinRawSha256,
      reference: skinRawMetrics,
      budget: posedSkinRawComparison.budget,
    };
    failureDiagnostics = {
      frameSummary: failureFrameSummary,
      skinTapeReadiness: skinTapeEvidence,
      settledSkinSurface: {
        ...settledSkinSurfaceEvidence,
        normalMismatchCount: skinMetrics.normalMismatchCount,
        depth: skinMetrics.depth,
        normalSha256: skinNormalSha256,
        consumerSha256: skinConsumerSha256,
      },
      posedRawComparison: posedSkinRawComparison,
      unposedControl,
    };
    await commands.writeFile(
      'packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-skin-surface.json',
      JSON.stringify(
        {
          schema: 'forgeax::forward-gtao-skin-surface-evidence::1',
          pose: { jointWorldPosition: pose, skeleton: skin.skeleton },
          selectedMaterial: {
            handle: Number(skin.material),
            pass: selectedSkinMaterial.passes?.find((pass) => pass.name === 'forward'),
            publication: skinLineage,
          },
          capturedSkinVertexVariants: skinSourceIdentity,
          tape: skinTapeEvidence,
          surface: {
            settlement: skinSurface.settlement,
            receipt: targetCaptureIdentity(skinSurface.normal).receipt,
            frame: skinSurface.normal.publicReceiptFrameId,
            recordFrameNumber: skinSurface.normal.targetRecordFrameNumber,
            graphGeneration: skinSurface.normal.graphGeneration,
            textureIdentity: skinSurface.normal.textureIdentity,
            deviceGeneration: skinSurface.normal.deviceGeneration,
            frameTrace: skinSurface.normal.frameTrace,
            owner: skinSurface.plan.normalOwner,
            depthOwner: skinSurface.plan.depthOwner,
            normal: {
              byteLength: skinSurface.normal.bytes.byteLength,
              sha256: skinNormalSha256,
              base64: base64Bytes(skinSurface.normal.bytes),
            },
            consumer: {
              byteLength: skinSurface.output.byteLength,
              sha256: skinConsumerSha256,
              base64: base64Bytes(skinSurface.output),
              metrics: skinMetrics,
            },
          },
          ao: {
            capture: 'posed-skin',
            receipt: posedSkinRawEvidence.capture.receipt,
            frame: skinRaw.publicReceiptFrameId,
            recordFrameNumber: skinRaw.targetRecordFrameNumber,
            graphGeneration: skinRaw.graphGeneration,
            textureIdentity: skinRaw.textureIdentity,
            deviceGeneration: skinRaw.deviceGeneration,
            frameTrace: skinRaw.frameTrace,
            extent: [skinRaw.width, skinRaw.height],
            bytes: {
              byteLength: skinRaw.bytes.byteLength,
              sha256: skinRawSha256,
              base64: base64Bytes(skinRaw.bytes),
            },
            reference: skinRawMetrics,
            independentUnposedVsPosedReference: unposedVisibilityDelta,
            actualUnposed: {
              capture: unposedControlEvidence,
              frame: unposedGpuRaw.publicReceiptFrameId,
              recordFrameNumber: unposedGpuRaw.targetRecordFrameNumber,
              graphGeneration: unposedGpuRaw.graphGeneration,
              textureIdentity: unposedGpuRaw.textureIdentity,
              deviceGeneration: unposedGpuRaw.deviceGeneration,
              frameTrace: unposedGpuRaw.frameTrace,
              bytes: {
                byteLength: unposedGpuRaw.bytes.byteLength,
                sha256: unposedRawSha256,
                base64: base64Bytes(unposedGpuRaw.bytes),
              },
            },
            actualPoseDelta: actualPoseVisibilityDelta,
          },
        },
        null,
        2,
      ),
    );
    failureOperation = 'skin-surface.normal-depth-comparison';
    failureReceipt = settledSkinSurfaceEvidence.capture.receipt;
    failureFrameTrace = skinSurface.normal.frameTrace;
    failureFrameSummary = {
      frameId: skinSurface.normal.publicReceiptFrameId,
      recordFrameNumber: skinSurface.normal.targetRecordFrameNumber,
      graphGeneration: skinSurface.normal.graphGeneration,
      textureIdentity: skinSurface.normal.textureIdentity,
      presentation: 'ready',
      capture: 'posed-skin-surface-normal-depth',
    };
    failureReadback = {
      target: 'surface-normal-depth-consumer',
      capture: 'posed-skin',
      frameId: skinSurface.normal.publicReceiptFrameId,
      graphGeneration: skinSurface.normal.graphGeneration,
      textureIdentity: skinSurface.normal.textureIdentity,
      normalSha256: skinNormalSha256,
      consumerSha256: skinConsumerSha256,
      metrics: skinMetrics,
    };
    failureDiagnostics = {
      frameSummary: failureFrameSummary,
      skinTapeReadiness: skinTapeEvidence,
      settledSkinSurface: failureReadback,
      posedRawComparison: posedSkinRawComparison,
      unposedControl,
    };
    expect(skinMetrics.normalMismatchCount).toBe(0);
    expect(skinMetrics.depth.maximumAbsolute).toBeLessThanOrEqual(1e-5);
    failureOperation = 'posed-skin.raw-gtao-reference-comparison';
    failureReceipt = posedSkinRawEvidence.capture.receipt;
    failureFrameTrace = skinRaw.frameTrace;
    failureFrameSummary = {
      frameId: skinRaw.publicReceiptFrameId,
      recordFrameNumber: skinRaw.targetRecordFrameNumber,
      graphGeneration: skinRaw.graphGeneration,
      textureIdentity: skinRaw.textureIdentity,
      presentation: 'ready',
      capture: 'posed-skin-ssao-raw-comparison',
    };
    failureReadback = {
      target: 'ssao-raw',
      capture: 'posed-skin',
      format: skinRaw.format,
      width: skinRaw.width,
      height: skinRaw.height,
      byteLength: skinRaw.bytes.byteLength,
      sha256: skinRawSha256,
      reference: skinRawMetrics,
      budget: posedSkinRawComparison.budget,
    };
    failureDiagnostics = {
      frameSummary: failureFrameSummary,
      skinTapeReadiness: skinTapeEvidence,
      settledSkinSurface: settledSkinSurfaceEvidence,
      posedRawComparison: posedSkinRawComparison,
      unposedControl,
    };
    expect(skinRawMetrics.maxAbsolute).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.rawVisibilityMaxByteError,
    );
    expect(skinRawMetrics.rms).toBeLessThanOrEqual(
      GTAO_COMPARISON_BUDGET.rawVisibilityRmsByteError,
    );
    expect(unposedVisibilityDelta.maxAbsolute).toBeGreaterThan(0);
    expect(actualPoseVisibilityDelta.maxAbsolute).toBeGreaterThan(0);
    failureOperation = 'unposed-skin.ao-graph-validation';
    failureReceipt = unposedControlEvidence.receipt;
    failureFrameTrace = unposedGpuRaw.frameTrace;
    failureFrameSummary = {
      frameId: unposedGpuRaw.publicReceiptFrameId,
      recordFrameNumber: unposedGpuRaw.targetRecordFrameNumber,
      graphGeneration: unposedGpuRaw.graphGeneration,
      textureIdentity: unposedGpuRaw.textureIdentity,
      presentation: 'ready',
      capture: 'unposed-skin-ssao-raw-control',
    };
    failureReadback = {
      target: 'ssao-raw',
      capture: 'unposed-control',
      format: unposedGpuRaw.format,
      width: unposedGpuRaw.width,
      height: unposedGpuRaw.height,
      byteLength: unposedGpuRaw.bytes.byteLength,
      sha256: unposedRawSha256,
      independentReferenceDelta: unposedVisibilityDelta,
      actualPoseDelta: actualPoseVisibilityDelta,
    };
    failureDiagnostics = {
      frameSummary: failureFrameSummary,
      skinTapeReadiness: skinTapeEvidence,
      settledSkinSurface: settledSkinSurfaceEvidence,
      posedRawComparison: posedSkinRawComparison,
      unposedControl,
    };
    const skinFrameInspection = renderer.inspect();
    expect(skinFrameInspection.output.graphPassNames).toEqual(
      expect.arrayContaining(['standard-scene-surface-data', 'ssao-calc']),
    );
    expect(events).toEqual([]);
  } catch (failure) {
    await writeForwardGtaoFailureReport({
      writeFile: commands.writeFile,
      path: 'packages/runtime/reports/portable-gpu-data-kernels-and-ao/forward-gtao-surface-semantics-failure.json',
      failure,
      context: {
        backend: 'webgpu',
        manifestSummary: {
          status: 'not-obtained',
          source: 'runtime Browser fixture does not fetch manifest bytes',
        },
        cameraConfig: {
          width,
          height,
          algorithm: 'gtao',
          quality: AMBIENT_OCCLUSION_QUALITY_HIGH,
          resolutionScale: 0.5,
        },
        operation: failureOperation,
        receipt: failureReceipt,
        frameTrace: failureFrameTrace,
        readback: failureReadback,
        rendererErrors: events,
        diagnostics: failureDiagnostics,
      },
    });
    throw failure;
  } finally {
    debugHost.setClusterWorkObservationForConformance(false);
    surfaceConsumer.setEnabled(false);
    unsubscribe();
    lease.dispose();
    try {
      value(await renderer.dispose());
    } finally {
      try {
        value(await debugHost.device.destroyBuffer(observationBuffer));
      } finally {
        canvas.remove();
      }
    }
  }
});
