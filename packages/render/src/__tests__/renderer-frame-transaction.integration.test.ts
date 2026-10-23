import { World } from '@forgeax/engine-ecs';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type Buffer, type RhiCommandEncoder, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { RhiNullAdapter, rhi } from '@forgeax/engine-rhi-null';
import { SHADER_MANIFEST_PUBLICATION_VERSION } from '@forgeax/engine-shader';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  createRenderer as constructRenderer,
  disposeObservationCaptureSet,
  exposeRenderer,
} from '../assembly/factory';
import {
  executeRendererFrameTransaction,
  observeFrameCompletionStages,
} from '../assembly/renderer-frame-transaction';
import { DeviceScope } from '../device/device-scope';
import { selectEnvironment } from '../environment/frame';
import { EnvironmentLifecycle } from '../environment/lifecycle';
import { type RendererContractFailureError, RendererOperationError } from '../errors/render';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import { RhiErrorListenerRegistry } from '../lifecycle';
import type {
  GraphTargetPassReplayPrefixReceipt,
  GraphTargetPassReplayReceipt,
  InstalledFrameGraph,
  RenderFrameState,
} from '../record/frame-snapshot';
import { executeCompiledFrameGraph } from '../record/typed-frame-graph';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../render-pipeline';
import {
  commitTemporalGpuSubmit,
  getTemporalBindGroupResources,
  getTemporalGpuState,
  getTemporalParamsBuffer,
  stageTemporalGpuSubmit,
} from '../temporal/gpu';
import { createTemporalView } from '../temporal/view';
import { addTypedTemporalResolvePass } from '../typed-render-graph-primitives';

function installedGraph(graph: unknown, topologyKey: string): InstalledFrameGraph {
  const noTarget = (): undefined => undefined;
  return {
    graph: graph as InstalledFrameGraph['graph'],
    topologyKey,
    targets: {
      getColorTargetDescriptor: noTarget,
      getColorTargetView: noTarget,
      getColorTargetTexture: noTarget,
      graphGeneration: 0,
    },
  };
}

type Stage = 'build' | 'execute' | 'finish' | 'submit';

type TemporalResolveFailure = 'params' | 'bind-group' | 'pipeline';

function selectedEnvironment(sourceKey?: string) {
  return selectEnvironment({
    environments:
      sourceKey === undefined ? [] : [{ kind: 'image' as const, entityKey: 1, sourceKey }],
    fogs: [],
    suns: [],
  }).unwrap();
}

function temporalResolveFrame(
  device: RhiDevice,
  scope: DeviceScope,
  frameState: RenderFrameState,
  pipeline: object | null,
): RenderPipelineFrame {
  return {
    encoder: device.createCommandEncoder({ label: 'taa-resolve-transaction' }).unwrap(),
    pipelineState: { format: 'rgba16float', colorAttachmentFormat: 'rgba16float' },
    runtime: {
      device,
      deviceScope: scope,
      errorRegistry: { fire: () => undefined },
      getPostProcessPipeline: () => pipeline as never,
    },
    frameState,
    outputTarget: () => ({ texture: undefined as never, view: undefined as never }),
    clear: [0, 0, 0, 1],
    targetW: 8,
    targetH: 8,
    camera: {
      position: [0, 0, 2] as never,
      world: new Float32Array(16),
      fov: 1,
      aspect: 1,
      near: 0.1,
      far: 100,
      projection: 'perspective',
      orthoLeft: -1,
      orthoRight: 1,
      orthoBottom: -1,
      orthoTop: 1,
      tonemap: 'none',
      exposure: 1,
      whitePoint: 1,
      antialias: 'taa',
      bloom: 'off',
      bloomThreshold: 1,
      bloomIntensity: 1,
      bloomSmoothWidth: 0.01,
      bloomRadius: 0,
      clearColor: [0, 0, 0, 1],
      temporal: frameState.lastSuccessfulTemporalView,
    },
    postProcessParams: new Map(),
    msaaActive: false,
  } as unknown as RenderPipelineFrame;
}

async function buildTemporalResolveGraph(device: RhiDevice) {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const descriptor = (format: 'rgba8unorm' | 'rgba16float' | 'r8unorm') => ({
    format,
    size: { width: 8, height: 8 },
  });
  const targets = {
    historyStability: createRenderPipelineTarget(
      graph,
      'taa-history-stability',
      descriptor('r8unorm'),
    ).unwrap(),
    writeStability: createRenderPipelineTarget(
      graph,
      'taa-write-stability',
      descriptor('r8unorm'),
    ).unwrap(),
    scene: createRenderPipelineTarget(graph, 'taa-scene', descriptor('rgba16float')).unwrap(),
    currentTemporal: createRenderPipelineTarget(
      graph,
      'taa-current-temporal',
      descriptor('rgba16float'),
    ).unwrap(),
    depth: createRenderPipelineTarget(graph, 'taa-depth', descriptor('rgba16float')).unwrap(),
    historyColor: createRenderPipelineTarget(
      graph,
      'taa-history-color',
      descriptor('rgba16float'),
    ).unwrap(),
    historyTemporal: createRenderPipelineTarget(
      graph,
      'taa-history-temporal',
      descriptor('rgba16float'),
    ).unwrap(),
    writeColor: createRenderPipelineTarget(
      graph,
      'taa-write-color',
      descriptor('rgba16float'),
    ).unwrap(),
    writeTemporal: createRenderPipelineTarget(
      graph,
      'taa-write-temporal',
      descriptor('rgba16float'),
    ).unwrap(),
  };
  const seed = [
    targets.scene,
    targets.currentTemporal,
    targets.historyColor,
    targets.historyTemporal,
  ];
  expect(
    graph.addRasterPass('taa-seed', {
      accesses: seed.map(({ view }) => ({ resource: view, usage: 'color-attachment' as const })),
      colorAttachments: seed.map(({ view }) => ({
        view,
        loadOp: 'clear' as const,
        storeOp: 'store' as const,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      })),
      encode: ({ pass }) => pass.draw(3, 1, 0, 0),
    }).ok,
  ).toBe(true);
  // Four rgba16float attachments already consume the default 32-byte budget.
  expect(
    graph.addRasterPass('taa-seed-stability', {
      accesses: [{ resource: targets.historyStability.view, usage: 'color-attachment' }],
      colorAttachments: [
        {
          view: targets.historyStability.view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      encode: () => {},
    }).ok,
  ).toBe(true);
  expect(addTypedTemporalResolvePass(graph, targets).ok).toBe(true);
  return graph.compile({ device, surfaceSize: { width: 8, height: 8 } }).unwrap();
}

type ReplayFailureStage = 'execute' | 'finish' | 'submit';
type ReplayCaptureKind = 'target-copy' | 'pass-replay';
type ReplayCallbackMode =
  | 'valid'
  | 'missing-target'
  | 'missing-depth'
  | 'mismatch-target'
  | 'throws';

function executeReplayCapture(
  replayPassNames: readonly string[],
  failureStage?: ReplayFailureStage,
  captureKind: ReplayCaptureKind = 'target-copy',
  callbackMode?: ReplayCallbackMode,
  prefixCapture?: {
    readonly depthAttachmentPassName: string;
    readonly observeAfterPassName: string;
    readonly passNames?: readonly string[];
    readonly depthPassNames?: readonly string[];
    readonly noEncodePassNames?: readonly string[];
    readonly repeatPassName?: string;
  },
) {
  const errors: unknown[] = [];
  const encodedPasses: string[] = [];
  let graphExecutions = 0;
  let submits = 0;
  let commits = 0;
  let copies = 0;
  const targetTexture = {};
  const targetView = {};
  const callbackReceipts: GraphTargetPassReplayReceipt[] = [];
  const prefixReceipts: GraphTargetPassReplayPrefixReceipt[] = [];
  const passNames = prefixCapture?.passNames ?? ['scene', 'shadow-cascade-2', 'output'];
  const depthPassNames = new Set(prefixCapture?.depthPassNames ?? ['shadow-cascade-2']);
  const noEncodePassNames = new Set(prefixCapture?.noEncodePassNames ?? []);
  const graph = {
    inspect: () => ({
      passes: passNames.map((name, executionIndex) => ({ name, executionIndex })),
    }),
    execute: (
      _frame: unknown,
      runPass?: (pass: { name: string; executionIndex: number }, encode: () => void) => void,
    ) => {
      graphExecutions += 1;
      if (failureStage === 'execute' && graphExecutions === 2)
        return err(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'selected graph replay executes',
            hint: 'repair the selected replay pass and retry',
          }),
        );
      for (const [executionIndex, name] of passNames.entries()) {
        const depthView = !depthPassNames.has(name)
          ? undefined
          : callbackMode === 'missing-depth'
            ? undefined
            : callbackMode === 'mismatch-target' || name === 'spot-shadow'
              ? {}
              : targetView;
        const pass = {
          name,
          executionIndex,
          ...(depthView === undefined ? {} : { resolvedDepthStencilAttachmentView: depthView }),
        };
        const encode = () => encodedPasses.push(name);
        const executions = prefixCapture?.repeatPassName === name ? 2 : 1;
        for (let repeat = 0; repeat < executions; repeat += 1) {
          if (runPass === undefined) encode();
          else if (!noEncodePassNames.has(name)) runPass(pass, encode);
        }
      }
      return ok(undefined);
    },
  };
  const frameState = {
    temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
    compiledFrameGraph: {
      graph,
      topologyKey: 'synthetic-capture',
      targets: {
        graphGeneration: 7,
        getColorTargetView: () =>
          callbackMode === 'missing-target' ? undefined : (targetView as never),
        getColorTargetTexture: () =>
          callbackMode === 'missing-target' ? undefined : (targetTexture as never),
        getColorTargetDescriptor: () => ({
          format: 'rgba16float' as const,
          size: { width: 4, height: 2 },
          usage: GPU_TEXTURE_USAGE_COPY_SRC,
          texture: targetTexture,
        }),
      },
    },
    frameNumber: 13,
    graphTargetCapture:
      captureKind === 'pass-replay'
        ? {
            kind: 'pass-replay' as const,
            replayPassNames,
            ...(callbackMode === undefined
              ? {}
              : {
                  targetName: 'shadow-target',
                  ...(prefixCapture === undefined
                    ? {
                        onPassEncoded: (receipt: GraphTargetPassReplayReceipt) => {
                          callbackReceipts.push(receipt);
                          if (callbackMode === 'throws') throw new Error('callback failed');
                        },
                      }
                    : {
                        depthAttachmentPassName: prefixCapture.depthAttachmentPassName,
                        observeAfterPassName: prefixCapture.observeAfterPassName,
                        onPrefixEncoded: (receipt: GraphTargetPassReplayPrefixReceipt) => {
                          prefixReceipts.push(receipt);
                          if (callbackMode === 'throws') throw new Error('callback failed');
                        },
                      }),
                }),
          }
        : {
            name: 'standard-output-color',
            replayPassNames,
            buffer: {} as never,
            bytesPerRow: 256,
            width: 4,
            height: 2,
            expected: {
              format: 'rgba16float' as const,
              width: 4,
              height: 2,
              usage: GPU_TEXTURE_USAGE_COPY_SRC,
            },
          },
  } as never;
  const encoder = {
    copyTextureToBuffer: () => {
      copies += 1;
    },
    finish: () =>
      failureStage === 'finish'
        ? err(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'the selected graph replay command finishes',
              hint: 'repair the command encoder and retry',
            }),
          )
        : ok({} as never),
  } as never;
  const internals = {
    errorRegistry: { fire: (error: unknown) => errors.push(error) },
    device: {
      queue: {
        submit: () => {
          submits += 1;
          return failureStage === 'submit'
            ? err(
                new RhiError({
                  code: 'webgpu-runtime-error',
                  expected: 'the selected graph replay command submits',
                  hint: 'repair the queue submission and retry',
                }),
              )
            : ok(undefined);
        },
      },
    },
  } as never;
  let rejection: RendererOperationError<'frame-submit-rejected'> | undefined;
  const result = (() => {
    try {
      return executeCompiledFrameGraph(
        internals,
        frameState,
        { pipelineState: {} } as never,
        encoder,
        undefined,
        () => {
          commits += 1;
        },
      );
    } catch (error) {
      if (!(error instanceof RendererOperationError) || error.code !== 'frame-submit-rejected')
        throw error;
      rejection = error;
      return false;
    }
  })();
  return {
    result,
    rejection,
    errors,
    encodedPasses,
    callbackReceipts,
    prefixReceipts,
    graphExecutions,
    submits,
    commits,
    copies,
  };
}

describe('renderer successful-submit transaction', () => {
  it('detaches disposed World leases while preserving another live attachment', async () => {
    const host = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      {
        shaderManifestUrl: `data:application/json,${encodeURIComponent(
          JSON.stringify({
            schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
            entries: [],
            materialShaders: [],
            fragments: [],
            sources: {},
            receipts: [],
            entryPoints: [],
          }),
        )}`,
      },
    );
    expect((await host.initialization).ok).toBe(true);
    const renderer = exposeRenderer(host);
    const world = new World();
    const first = renderer.attach(world);
    const second = renderer.attach(world);
    if (!first.ok) throw first.error;
    if (!second.ok) throw second.error;
    const draw = (lease: typeof first.value) =>
      renderer.draw({
        leases: [lease],
        camera: { lease },
        environment: { lease },
      });
    try {
      first.value.dispose();
      const released = draw(first.value);
      expect(released).toMatchObject({ ok: false, error: { code: 'world-lease-invalid' } });
      const retained = draw(second.value);
      expect(retained.ok).toBe(true);
      if (retained.ok) await retained.value.completed;
      second.value.dispose();
      second.value.dispose();
      expect(draw(second.value)).toMatchObject({
        ok: false,
        error: { code: 'world-lease-invalid' },
      });
      const replacement = renderer.attach(world);
      if (!replacement.ok) throw replacement.error;
      const reattached = draw(replacement.value);
      expect(reattached.ok).toBe(true);
      if (reattached.ok) await reattached.value.completed;
      replacement.value.dispose();
    } finally {
      await renderer.dispose();
    }
  });

  it('publishes the renderer-created receipt object only after submit', async () => {
    const rendererHost = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      {
        shaderManifestUrl: `data:application/json,${encodeURIComponent(
          JSON.stringify({ entries: [] }),
        )}`,
      },
    );
    expect((await rendererHost.initialization).ok).toBe(true);
    const renderer = exposeRenderer(rendererHost);
    const events: Array<
      Extract<import('../render-contract').RendererEvent, { kind: 'frame-submitted' }>
    > = [];
    renderer.subscribe((event) => {
      if (event.kind === 'frame-submitted') events.push(event);
    });
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    const frame = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(frame.ok, frame.ok ? '' : JSON.stringify(frame.error)).toBe(true);
    if (!frame.ok) return;
    expect(events).toHaveLength(1);
    expect(events[0]?.receipt).toBe(frame.value);
    expect(rendererHost.inspect().observation.resourceStats).toEqual({
      allocationCount: 0,
      liveCount: 0,
      peakLiveCount: 0,
      mapCount: 0,
      readbackCount: 0,
      liveByteLength: 0,
    });
    const pending = renderer.inspect().frame;
    expect(pending.pendingCompletionCount).toBe(1);
    expect(pending.pendingCompletions).toEqual([
      expect.objectContaining({
        frameId: frame.value.frameId,
        deviceGeneration: frame.value.deviceGeneration,
        presentation: frame.value.presentation,
        queue: 'pending',
      }),
    ]);
    expect(Object.isFrozen(pending.pendingCompletions)).toBe(true);
    expect(Object.isFrozen(pending.pendingCompletions?.[0])).toBe(true);
    await frame.value.completed;
    expect(renderer.inspect().frame.pendingCompletionCount).toBe(0);
    expect(renderer.inspect().frame.pendingCompletions).toEqual([]);
    expect(pending.pendingCompletionCount).toBe(1);
    expect(pending.pendingCompletions?.[0]?.queue).toBe('pending');
    await renderer.dispose();
  });

  it('bounds pending receipt snapshots without releasing any original continuation', async () => {
    const host = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      {
        shaderManifestUrl: `data:application/json,${encodeURIComponent(
          JSON.stringify({ entries: [] }),
        )}`,
      },
    );
    expect((await host.initialization).ok).toBe(true);
    const renderer = exposeRenderer(host);
    const attachment = renderer.attach(new World());
    expect(attachment.ok).toBe(true);
    if (!attachment.ok) throw attachment.error;
    const attached = attachment.value;
    const receipts = Array.from({ length: 10 }, () => {
      const result = renderer.draw({
        leases: [attached],
        camera: { lease: attached },
        environment: { lease: attached },
      });
      expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
      if (!result.ok) throw result.error;
      return result.value;
    });
    const snapshot = renderer.inspect().frame;
    expect(snapshot.pendingCompletionCount).toBe(10);
    expect(snapshot.pendingCompletions?.map(({ frameId }) => frameId)).toEqual(
      receipts.slice(-8).map(({ frameId }) => frameId),
    );
    await Promise.all(receipts.map(({ completed }) => completed));
    expect(renderer.inspect().frame.pendingCompletionCount).toBe(0);
    expect(renderer.inspect().frame.pendingCompletions).toEqual([]);
    expect(snapshot.pendingCompletions).toHaveLength(8);
    await renderer.dispose();
  });

  it('fail-closes an all-domain request without an admitted LUT producer', async () => {
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      {
        shaderManifestUrl: `data:application/json,${encodeURIComponent(
          JSON.stringify({ entries: [] }),
        )}`,
      },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    const frame = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(frame.ok, frame.ok ? '' : JSON.stringify(frame.error)).toBe(true);
    if (!frame.ok || frame.value === undefined) return;
    expect(frame.value.graphGeneration).toBeTypeOf('number');
    expect(frame.value.backendId).toBe('null');
    const forgedGraphReceipt = Object.freeze({
      ...frame.value,
      graphGeneration: (frame.value.graphGeneration ?? 0) + 1,
    });
    const forgedGraph = await renderer.observe(forgedGraphReceipt, { include: ['timings'] });
    expect(forgedGraph.ok).toBe(false);
    if (!forgedGraph.ok) expect(forgedGraph.error.code).toBe('frame-receipt-stale');
    const duplicateDomain = await renderer.observe(frame.value, {
      include: ['linear-hdr', 'linear-hdr'],
    });
    expect(duplicateDomain.ok).toBe(false);
    if (!duplicateDomain.ok) expect(duplicateDomain.error.code).toBe('renderer-contract-failed');
    const domainsAndTimings = await renderer.observe(frame.value, {
      include: ['timings', 'linear-hdr'],
    });
    expect(domainsAndTimings.ok).toBe(false);
    if (!domainsAndTimings.ok)
      expect(domainsAndTimings.error.code).toBe('renderer-contract-failed');
    const observed = await renderer.observe(frame.value, {
      include: ['linear-hdr', 'linear-ldr', 'final-display'],
    });
    expect(observed.ok).toBe(false);
    if (!observed.ok) expect(observed.error.code).toBe('renderer-contract-failed');
    const duplicate = await renderer.observe(frame.value, {
      include: ['linear-hdr', 'linear-ldr', 'final-display'],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe('renderer-contract-failed');
    await renderer.dispose();
    const stale = await renderer.observe(frame.value, { include: ['linear-hdr'] });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('frame-receipt-stale');
  });

  it('rejects a receipt issued by another Renderer owner', async () => {
    const options = {
      shaderManifestUrl: `data:application/json,${encodeURIComponent(
        JSON.stringify({ entries: [] }),
      )}`,
    };
    const firstRenderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      options,
    );
    const secondRenderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      options,
    );
    expect((await firstRenderer.initialization).ok).toBe(true);
    expect((await secondRenderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = firstRenderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    const frame = firstRenderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(frame.ok, frame.ok ? '' : JSON.stringify(frame.error)).toBe(true);
    if (!frame.ok || frame.value === undefined) return;
    expect(frame.value.backendId).toBe('null');
    const crossRenderer = await secondRenderer.observe(frame.value, { include: ['timings'] });
    expect(crossRenderer.ok).toBe(false);
    if (!crossRenderer.ok) expect(crossRenderer.error.code).toBe('frame-receipt-stale');
    await firstRenderer.dispose();
    await secondRenderer.dispose();
  });

  it.each([
    'result',
    'throw',
  ] as const)('retries a failed buffer destroy without duplicate ownership or errors (%s)', async (failureMode) => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const buffer = device
      .createBuffer({ label: 'observation-retry', size: 256, usage: 0, mappedAtCreation: false })
      .unwrap();
    const texture = device
      .createTexture({
        label: 'observation-retry-source',
        size: { width: 1, height: 1, depthOrArrayLayers: 1 },
        format: 'rgba8unorm',
        usage: 0,
        textureBindingViewDimension: undefined,
      })
      .unwrap();
    const capture = {
      domain: 'linear-hdr' as const,
      format: 'rgba8unorm' as const,
      device,
      texture,
      buffer,
      frameNumber: 7,
      deviceGeneration: 3,
      graphGeneration: 11,
      backendId: 'null',
      width: 1,
      height: 1,
      bytesPerRow: 256,
    };
    const destroyed = new WeakSet<Buffer>();
    const failures = new WeakMap<Buffer, RendererContractFailureError>();
    const errors: RendererContractFailureError[] = [];
    const destroyError = new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'receipt-owned observation buffer destruction succeeds',
      hint: 'retry against the original device',
    });
    let attempts = 0;
    const originalDestroy = device.destroyBuffer.bind(device);
    const destroyBuffer = vi.spyOn(device, 'destroyBuffer').mockImplementation((handle) => {
      attempts += 1;
      if (attempts === 1) {
        if (failureMode === 'throw') throw destroyError;
        return err(destroyError);
      }
      return originalDestroy(handle);
    });
    try {
      const first = disposeObservationCaptureSet([capture], destroyed, failures, (failure) =>
        errors.push(failure),
      );
      expect(first?.code).toBe('renderer-contract-failed');
      expect(destroyed.has(buffer)).toBe(false);
      expect(errors).toHaveLength(1);
      const second = disposeObservationCaptureSet([capture], destroyed, failures, (failure) =>
        errors.push(failure),
      );
      expect(second).toBeUndefined();
      expect(destroyed.has(buffer)).toBe(true);
      expect(attempts).toBe(2);
      expect(errors).toHaveLength(1);
      expect(disposeObservationCaptureSet([capture], destroyed, failures, () => undefined)).toBe(
        undefined,
      );
      expect(attempts).toBe(2);
    } finally {
      destroyBuffer.mockRestore();
      device.destroyTexture(texture);
    }
  });

  it('keeps real Renderer observation requests isolated across receipts', async () => {
    const renderer = await constructRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      {
        shaderManifestUrl: `data:application/json,${encodeURIComponent(
          JSON.stringify({ entries: [] }),
        )}`,
      },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    const first = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    const second = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(first.ok, first.ok ? '' : JSON.stringify(first.error)).toBe(true);
    expect(second.ok, second.ok ? '' : JSON.stringify(second.error)).toBe(true);
    if (!first.ok || !second.ok || first.value === undefined || second.value === undefined) return;
    const firstPending = renderer.observe(first.value, {
      include: ['timings', 'linear-hdr', 'linear-ldr', 'final-display'],
    });
    const secondResult = await renderer.observe(second.value, {
      include: ['linear-hdr', 'linear-ldr', 'final-display'],
    });
    const firstResult = await firstPending;
    expect(firstResult.ok).toBe(false);
    expect(secondResult.ok).toBe(false);
    if (!firstResult.ok) expect(firstResult.error.code).toBe('renderer-contract-failed');
    if (!secondResult.ok) expect(secondResult.error.code).toBe('renderer-contract-failed');
    const duplicate = await renderer.observe(first.value, { include: ['linear-hdr'] });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe('renderer-contract-failed');
    await renderer.dispose();
    const stale = await renderer.observe(second.value, { include: ['linear-hdr'] });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('frame-receipt-stale');
  });

  it('keeps failed retries attached to their original buffer and frame', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const buffer = device
      .createBuffer({ label: 'observation-retry-a', size: 256, usage: 0, mappedAtCreation: false })
      .unwrap();
    const bufferB = device
      .createBuffer({ label: 'observation-retry-b', size: 256, usage: 0, mappedAtCreation: false })
      .unwrap();
    const texture = device
      .createTexture({
        label: 'observation-retry-source-a',
        size: { width: 1, height: 1, depthOrArrayLayers: 1 },
        format: 'rgba8unorm',
        usage: 0,
        textureBindingViewDimension: undefined,
      })
      .unwrap();
    const textureB = device
      .createTexture({
        label: 'observation-retry-source-b',
        size: { width: 1, height: 1, depthOrArrayLayers: 1 },
        format: 'rgba8unorm',
        usage: 0,
        textureBindingViewDimension: undefined,
      })
      .unwrap();
    const capture = {
      domain: 'linear-hdr' as const,
      format: 'rgba8unorm' as const,
      device,
      texture,
      buffer,
      frameNumber: 7,
      deviceGeneration: 3,
      graphGeneration: 11,
      backendId: 'null',
      width: 1,
      height: 1,
      bytesPerRow: 256,
    };
    const captureB = {
      ...capture,
      domain: 'linear-ldr' as const,
      texture: textureB,
      buffer: bufferB,
      frameNumber: 8,
    };
    const destroyed = new WeakSet<Buffer>();
    const failures = new WeakMap<Buffer, RendererContractFailureError>();
    const errors: RendererContractFailureError[] = [];
    const destroyError = new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'receipt-owned observation buffer destruction succeeds',
      hint: 'retry against the original device',
    });
    const attempts = new Map<Buffer, number>();
    const originalDestroy = device.destroyBuffer.bind(device);
    const destroyBuffer = vi.spyOn(device, 'destroyBuffer').mockImplementation((handle) => {
      const count = (attempts.get(handle) ?? 0) + 1;
      attempts.set(handle, count);
      if (handle === buffer && count === 1) return err(destroyError);
      return originalDestroy(handle);
    });
    try {
      expect(
        disposeObservationCaptureSet([capture, captureB], destroyed, failures, (failure) =>
          errors.push(failure),
        ),
      ).toBeDefined();
      expect(destroyed.has(buffer)).toBe(false);
      expect(destroyed.has(bufferB)).toBe(true);
      expect(errors).toHaveLength(1);
      expect(
        disposeObservationCaptureSet([capture], destroyed, failures, (failure) =>
          errors.push(failure),
        ),
      ).toBeUndefined();
      expect(destroyed.has(buffer)).toBe(true);
      expect(attempts.get(buffer)).toBe(2);
      expect(attempts.get(bufferB)).toBe(1);
      expect(errors).toHaveLength(1);
      expect(disposeObservationCaptureSet([captureB], destroyed, failures, () => undefined)).toBe(
        undefined,
      );
      expect(attempts.get(bufferB)).toBe(1);
    } finally {
      destroyBuffer.mockRestore();
      device.destroyTexture(texture);
      device.destroyTexture(textureB);
    }
  });

  it('replays selected passes without target-copy payload', () => {
    const replay = executeReplayCapture(['shadow-cascade-2'], undefined, 'pass-replay');

    expect(replay.result).toBe(true);
    expect(replay.graphExecutions).toBe(2);
    expect(replay.encodedPasses).toEqual([
      'scene',
      'shadow-cascade-2',
      'output',
      'shadow-cascade-2',
    ]);
    expect(replay.errors).toEqual([]);
    expect(replay.submits).toBe(1);
    expect(replay.commits).toBe(1);
    expect(replay.copies).toBe(0);
  });

  it('reports the resolved depth and target identities after selected pass encoding', () => {
    const replay = executeReplayCapture(['shadow-cascade-2'], undefined, 'pass-replay', 'valid');

    expect(replay.result).toBe(true);
    expect(replay.callbackReceipts).toHaveLength(1);
    const receipt = replay.callbackReceipts[0];
    expect(receipt).toMatchObject({
      passName: 'shadow-cascade-2',
      executionIndex: 1,
      graphGeneration: 7,
      targetName: 'shadow-target',
    });
    expect(receipt?.resolvedDepthStencilAttachmentView).toBe(receipt?.targetView);
    expect(receipt?.targetTextureIdentity).toBeGreaterThan(0);
    expect(replay.submits).toBe(1);
    expect(replay.commits).toBe(1);
  });

  it('observes a complete prefix once after a no-depth boundary pass', () => {
    const replay = executeReplayCapture(
      ['scene', 'shadow-cascade-2', 'output'],
      undefined,
      'pass-replay',
      'valid',
      {
        depthAttachmentPassName: 'shadow-cascade-2',
        observeAfterPassName: 'output',
      },
    );

    expect(replay.result).toBe(true);
    expect(replay.encodedPasses).toEqual([
      'scene',
      'shadow-cascade-2',
      'output',
      'scene',
      'shadow-cascade-2',
      'output',
    ]);
    expect(replay.callbackReceipts).toEqual([]);
    expect(replay.prefixReceipts).toHaveLength(1);
    expect(replay.prefixReceipts[0]).toMatchObject({
      observeAfterPassName: 'output',
      depthAttachmentPassName: 'shadow-cascade-2',
      passName: 'output',
      executionIndex: 2,
    });
    expect(replay.prefixReceipts[0]?.resolvedDepthStencilAttachmentView).toBe(
      replay.prefixReceipts[0]?.targetView,
    );
    expect(replay.submits).toBe(1);
    expect(replay.commits).toBe(1);
  });

  it.each([
    ['non-prefix', ['shadow-cascade-2', 'output'] as const, 'shadow-cascade-2', 'output'],
    ['anchor-after-boundary', ['scene', 'output'] as const, 'shadow-cascade-2', 'output'],
    [
      'boundary-not-last',
      ['scene', 'shadow-cascade-2', 'output'] as const,
      'shadow-cascade-2',
      'shadow-cascade-2',
    ],
  ] as const)('rejects invalid prefix observer selection: %s', (_label, replayPassNames, depthAttachmentPassName, observeAfterPassName) => {
    const replay = executeReplayCapture(replayPassNames, undefined, 'pass-replay', 'valid', {
      depthAttachmentPassName,
      observeAfterPassName,
    });

    expect(replay.result).toBe(false);
    expect(replay.graphExecutions).toBe(0);
    expect(replay.submits).toBe(0);
    expect(replay.commits).toBe(0);
    expect(replay.prefixReceipts).toEqual([]);
    expect(replay.errors[0]).toMatchObject({
      code: 'webgpu-runtime-error',
      detail: { error: { code: 'graph-target-capture-failed' } },
    });
  });

  it('rejects a no-depth anchor and does not submit the replay', () => {
    const replay = executeReplayCapture(['scene', 'output'], undefined, 'pass-replay', 'valid', {
      depthAttachmentPassName: 'output',
      observeAfterPassName: 'output',
    });

    expect(replay.result).toBe(false);
    expect(replay.submits).toBe(0);
    expect(replay.commits).toBe(0);
    expect(replay.prefixReceipts).toEqual([]);
    expect(replay.errors[0]).toMatchObject({
      detail: {
        error: {
          code: 'graph-target-capture-failed',
        },
      },
    });
  });

  it('does not submit when the prefix callback throws', () => {
    const replay = executeReplayCapture(
      ['scene', 'shadow-cascade-2', 'output'],
      undefined,
      'pass-replay',
      'throws',
      { depthAttachmentPassName: 'shadow-cascade-2', observeAfterPassName: 'output' },
    );

    expect(replay.result).toBe(false);
    expect(replay.submits).toBe(0);
    expect(replay.commits).toBe(0);
    expect(replay.prefixReceipts).toHaveLength(1);
    expect(replay.errors[0]).toMatchObject({
      detail: {
        error: {
          code: 'graph-target-capture-failed',
        },
      },
    });
  });

  it('accepts multiple depth passes and a no-depth boundary with one callback', () => {
    const replay = executeReplayCapture(
      ['shadow-cascade-0', 'shadow-cascade-1', 'spot-shadow', 'skybox'],
      undefined,
      'pass-replay',
      'valid',
      {
        depthAttachmentPassName: 'shadow-cascade-1',
        observeAfterPassName: 'skybox',
        passNames: ['shadow-cascade-0', 'shadow-cascade-1', 'spot-shadow', 'skybox'],
        depthPassNames: ['shadow-cascade-0', 'shadow-cascade-1', 'spot-shadow'],
      },
    );

    expect(replay.result).toBe(true);
    expect(replay.prefixReceipts).toHaveLength(1);
    expect(replay.prefixReceipts[0]).toMatchObject({
      passName: 'skybox',
      depthAttachmentPassName: 'shadow-cascade-1',
      observeAfterPassName: 'skybox',
    });
    expect(replay.submits).toBe(1);
    expect(replay.commits).toBe(1);
  });

  it('rejects a spot anchor when the target is a directional depth view', () => {
    const replay = executeReplayCapture(
      ['shadow-cascade-0', 'spot-shadow', 'skybox'],
      undefined,
      'pass-replay',
      'valid',
      {
        depthAttachmentPassName: 'spot-shadow',
        observeAfterPassName: 'skybox',
        passNames: ['shadow-cascade-0', 'spot-shadow', 'skybox'],
        depthPassNames: ['shadow-cascade-0', 'spot-shadow'],
      },
    );

    expect(replay.result).toBe(false);
    expect(replay.submits).toBe(0);
    expect(replay.commits).toBe(0);
    expect(replay.errors[0]).toMatchObject({
      detail: { error: { code: 'graph-target-capture-failed' } },
    });
  });

  it('rejects an unexecuted or repeated anchor before submit', () => {
    const unexecuted = executeReplayCapture(
      ['scene', 'shadow-cascade-2', 'output'],
      undefined,
      'pass-replay',
      'valid',
      {
        depthAttachmentPassName: 'shadow-cascade-2',
        observeAfterPassName: 'output',
        noEncodePassNames: ['shadow-cascade-2'],
      },
    );
    expect(unexecuted.result).toBe(false);
    expect(unexecuted.submits).toBe(0);
    expect(unexecuted.commits).toBe(0);

    const repeated = executeReplayCapture(
      ['scene', 'shadow-cascade-2', 'output'],
      undefined,
      'pass-replay',
      'valid',
      {
        depthAttachmentPassName: 'shadow-cascade-2',
        observeAfterPassName: 'output',
        repeatPassName: 'shadow-cascade-2',
      },
    );
    expect(repeated.result).toBe(false);
    expect(repeated.submits).toBe(0);
    expect(repeated.commits).toBe(0);
    expect(repeated.errors[0]).toMatchObject({
      detail: { error: { code: 'graph-target-capture-failed' } },
    });
  });

  it.each<ReplayCallbackMode>([
    'missing-target',
    'missing-depth',
    'mismatch-target',
    'throws',
  ])('fails pass-replay callback validation for %s before submit', (callbackMode) => {
    const replay = executeReplayCapture(
      ['shadow-cascade-2'],
      undefined,
      'pass-replay',
      callbackMode,
    );

    expect(replay.result).toBe(false);
    expect(replay.submits).toBe(0);
    expect(replay.commits).toBe(0);
    expect(replay.errors[0]).toMatchObject({
      code: 'webgpu-runtime-error',
      detail: { error: { code: 'graph-target-capture-failed' } },
    });
  });

  it.each([
    ['unknown', ['missing-pass']],
    ['duplicate', ['shadow-cascade-2', 'shadow-cascade-2']],
    ['empty', []],
  ] as const)('rejects %s pass-replay selection without target-copy fields', (_reason, replayPassNames) => {
    const replay = executeReplayCapture(replayPassNames, undefined, 'pass-replay');

    expect(replay.result).toBe(false);
    expect(replay.graphExecutions).toBe(0);
    expect(replay.encodedPasses).toEqual([]);
    expect(replay.submits).toBe(0);
    expect(replay.commits).toBe(0);
    expect(replay.copies).toBe(0);
    expect(replay.errors[0]).toMatchObject({
      code: 'webgpu-runtime-error',
      detail: { error: { code: 'graph-target-capture-failed' } },
    });
  });

  it('replays only the requested graph passes on the same submitted command', () => {
    const replay = executeReplayCapture(['shadow-cascade-2']);

    expect(replay.result).toBe(true);
    expect(replay.graphExecutions).toBe(2);
    expect(replay.encodedPasses).toEqual([
      'scene',
      'shadow-cascade-2',
      'output',
      'shadow-cascade-2',
    ]);
    expect(replay.errors).toEqual([]);
    expect(replay.submits).toBe(1);
    expect(replay.commits).toBe(1);
  });

  it.each<ReplayFailureStage>([
    'execute',
    'finish',
    'submit',
  ])('does not commit when replay transaction fails at %s', (failureStage) => {
    const replay = executeReplayCapture(['shadow-cascade-2'], failureStage);

    expect(replay.result).toBe(false);
    expect(replay.commits).toBe(0);
    expect(replay.submits).toBe(failureStage === 'submit' ? 1 : 0);
    if (failureStage === 'submit') expect(replay.rejection?.code).toBe('frame-submit-rejected');
  });

  it.each([
    ['unknown', ['missing-pass']],
    ['duplicate', ['shadow-cascade-2', 'shadow-cascade-2']],
    ['empty', []],
  ] as const)('rejects %s graph replay selection before submit', (_reason, replayPassNames) => {
    const replay = executeReplayCapture(replayPassNames);

    expect(replay.result).toBe(false);
    expect(replay.graphExecutions).toBe(0);
    expect(replay.encodedPasses).toEqual([]);
    expect(replay.submits).toBe(0);
    expect(replay.commits).toBe(0);
    expect(replay.errors[0]).toMatchObject({
      code: 'webgpu-runtime-error',
      detail: { error: { code: 'graph-target-capture-failed' } },
    });
  });

  it.each<Stage>([
    'build',
    'execute',
    'finish',
    'submit',
  ])('aborts atomically at %s', (failureAt) => {
    let submits = 0;
    let commits = 0;
    const before = {
      signature: 'stable',
      revision: 7,
      jitter: 3,
      previous: 'old',
      history: 4,
      frameIndex: 9,
    };
    const result = executeRendererFrameTransaction({
      build: () =>
        failureAt === 'build'
          ? { ok: false, stage: 'build' as const }
          : { ok: true, value: before },
      execute: () =>
        failureAt === 'execute'
          ? { ok: false, stage: 'execute' as const }
          : { ok: true, value: undefined },
      finish: () =>
        failureAt === 'finish'
          ? { ok: false, stage: 'finish' as const }
          : { ok: true, value: undefined },
      submit: () => {
        submits += 1;
        return failureAt === 'submit'
          ? { ok: false, stage: 'submit' as const }
          : { ok: true, value: undefined };
      },
      commit: () => {
        commits += 1;
      },
    });
    expect(result).toEqual({ ok: false, error: { stage: failureAt } });
    expect(submits).toBe(failureAt === 'submit' ? 1 : 0);
    expect(commits).toBe(0);
    expect(before).toEqual({
      signature: 'stable',
      revision: 7,
      jitter: 3,
      previous: 'old',
      history: 4,
      frameIndex: 9,
    });
  });

  it('publishes staged Environment, Fog, and Temporal state only after submit', () => {
    const published: string[] = [];
    const result = executeRendererFrameTransaction({
      build: () => ({ ok: true, value: { environment: 'env:2', fog: 'fog:2', temporal: 'taa:2' } }),
      execute: () => ({ ok: true, value: undefined }),
      finish: () => ({ ok: true, value: undefined }),
      submit: () => ({ ok: true, value: undefined }),
      commit: (candidate) =>
        published.push(`${candidate.environment}/${candidate.fog}/${candidate.temporal}`),
    });
    expect(result.ok).toBe(true);
    expect(published).toEqual(['env:2/fog:2/taa:2']);
  });

  it('rejects a missing temporal write before queue.submit and cleans the candidate', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const scope = DeviceScope.create(91, 'renderer');
    const frameState = {
      temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
      temporalGpuState: undefined,
      activeTemporalGpuState: undefined,
      retiringTemporalGpuStates: new Set(),
      pendingTemporalCommit: { kind: 'none' },
      environmentGeneration: undefined,
      environmentLifecycle: undefined,
    } as unknown as RenderFrameState;
    const candidate = getTemporalGpuState(frameState, device, scope, 8, 8);
    getTemporalBindGroupResources(candidate);
    const graphBuilder = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    expect(
      graphBuilder.addCopyPass('temporal-readiness-probe', {
        accesses: [],
        encode: () => undefined,
      }).ok,
    ).toBe(true);
    const compiled = graphBuilder.compile({
      device,
      surfaceSize: { width: 8, height: 8 },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    frameState.compiledFrameGraph = installedGraph(compiled.value, 'temporal-readiness-probe');
    const submits = vi.spyOn(device.queue, 'submit');
    const errors = new RhiErrorListenerRegistry();
    const result = executeCompiledFrameGraph(
      { device, errorRegistry: errors } as never,
      frameState,
      {
        encoder: device.createCommandEncoder({ label: 'temporal-readiness-probe' }).unwrap(),
        pipelineState: {},
      } as unknown as RenderPipelineFrame,
      device.createCommandEncoder({ label: 'temporal-readiness-probe-submit' }).unwrap(),
    );
    expect(result).toBe(false);
    expect(submits).not.toHaveBeenCalled();
    expect(frameState.activeTemporalGpuState).toBeUndefined();
    expect(frameState.temporalGpuState).toBeUndefined();
    expect(candidate.childScope.resourceDelta()).toBe(0);
    expect(candidate.childScope.state).toBe('retired');
  });

  it.each<TemporalResolveFailure>([
    'params',
    'bind-group',
    'pipeline',
  ])('rejects a real TAA resolve when %s fails and retries atomically', async (failureAt) => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const scope = DeviceScope.create(92, 'renderer');
    const environmentLifecycle = new EnvironmentLifecycle(scope);
    const activeEnvironment = environmentLifecycle.ensure(selectedEnvironment()).unwrap();
    environmentLifecycle.publish(activeEnvironment);
    const environmentFrame = selectedEnvironment('environment:candidate');
    const environmentGeneration = environmentLifecycle.ensure(environmentFrame).unwrap();
    const discardEnvironment = vi.spyOn(environmentLifecycle, 'discard');
    const publishEnvironment = vi.spyOn(environmentLifecycle, 'publish');
    const lastSuccessfulTemporalView = createTemporalView({
      antialias: 'taa',
      width: 4,
      height: 4,
      frameIndex: 6,
      historyValid: true,
      sampleTimeSeconds: 1,
    });
    const frameState = {
      temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
      temporalGpuState: undefined,
      activeTemporalGpuState: undefined,
      retiringTemporalGpuStates: new Set(),
      pendingTemporalCommit: {
        kind: 'taa',
        view: createTemporalView({
          antialias: 'taa',
          width: 4,
          height: 4,
          frameIndex: 6,
          historyValid: true,
          sampleTimeSeconds: 1.016,
        }),
      },
      environmentGeneration,
      environmentLifecycle,
      successfulTemporalFrameIndex: 7,
      lastSuccessfulTemporalView,
    } as unknown as RenderFrameState;
    const active = getTemporalGpuState(frameState, device, scope, 4, 4);
    getTemporalBindGroupResources(active);
    getTemporalParamsBuffer(active);
    stageTemporalGpuSubmit(active);
    expect(commitTemporalGpuSubmit(active)).toBe(true);
    frameState.lastSuccessfulTemporalView = lastSuccessfulTemporalView;
    frameState.activeTemporalGpuState = active;
    frameState.temporalGpuState = undefined;
    const candidate = getTemporalGpuState(frameState, device, scope, 8, 8);
    getTemporalBindGroupResources(candidate);
    getTemporalParamsBuffer(candidate);
    const graph = await buildTemporalResolveGraph(device);
    frameState.compiledFrameGraph = installedGraph(graph, 'temporal-resolve');

    const failure = new RhiError({
      code: 'webgpu-runtime-error',
      expected: `TAA ${failureAt} operation succeeds`,
      hint: 'repair the injected operation and retry the same frame',
    });
    const writeBuffer = vi.spyOn(device.queue, 'writeBuffer');
    const createBindGroup = vi.spyOn(device, 'createBindGroup');
    if (failureAt === 'params') {
      const originalWriteBuffer = device.queue.writeBuffer;
      writeBuffer.mockImplementation((buffer, offset, data, dataOffset, size) => {
        if (buffer === candidate.paramsBuffer) return err(failure);
        return originalWriteBuffer.call(device.queue, buffer, offset, data, dataOffset, size);
      });
    }
    if (failureAt === 'bind-group') createBindGroup.mockReturnValue(err(failure));
    const errors = new RhiErrorListenerRegistry();
    const observed: unknown[] = [];
    const gpuCommitAfterSubmit: number[] = [];
    errors.add((error) => observed.push(error));
    const submits = vi.spyOn(device.queue, 'submit');
    const failedFrame = temporalResolveFrame(
      device,
      scope,
      frameState,
      failureAt === 'pipeline' ? null : {},
    );
    const failed = executeCompiledFrameGraph(
      { device, errorRegistry: errors } as never,
      frameState,
      failedFrame,
      failedFrame.encoder,
      undefined,
      () => gpuCommitAfterSubmit.push(submits.mock.calls.length),
    );
    expect(failed).toBe(false);
    expect(submits).not.toHaveBeenCalled();
    expect(gpuCommitAfterSubmit).toEqual([]);
    expect(observed[0]).toMatchObject({ code: 'pass-encode-failed' });
    const cause = (observed[0] as { detail?: { cause?: unknown } }).detail?.cause;
    expect(cause).toBeInstanceOf(RhiError);
    expect(cause).toMatchObject({
      expected:
        failureAt === 'params'
          ? 'TAA resolve params upload succeeds'
          : failureAt === 'bind-group'
            ? 'TAA resolve bind group creation succeeds'
            : 'TAA resolve pipeline is ready before frame encoding',
    });
    expect(frameState.activeTemporalGpuState).toBe(active);
    expect(frameState.temporalGpuState).toBeUndefined();
    expect(candidate.childScope.resourceDelta()).toBe(0);
    expect(candidate.childScope.state).toBe('retired');
    expect(frameState.successfulTemporalFrameIndex).toBe(7);
    expect(active.childScope.state).toBe('active');

    writeBuffer.mockRestore();
    createBindGroup.mockRestore();
    expect(frameState.environmentGeneration).toBeUndefined();
    expect(discardEnvironment).toHaveBeenCalledTimes(1);
    expect(publishEnvironment).not.toHaveBeenCalled();
    expect(active.valid).toBe(true);
    expect(active.readIndex).toBe(1);
    expect(frameState.lastSuccessfulTemporalView).toBe(lastSuccessfulTemporalView);
    expect(frameState.lastSuccessfulTemporalView.sampleTimeSeconds).toBe(1);
    expect(environmentLifecycle.inspect().activeSignature).toBe(activeEnvironment.signature);
    expect(environmentLifecycle.inspect().lkgSignature).toBe(activeEnvironment.signature);
    frameState.environmentGeneration = environmentLifecycle.ensure(environmentFrame).unwrap();
    frameState.pendingTemporalCommit = {
      kind: 'taa',
      view: createTemporalView({
        antialias: 'taa',
        width: 8,
        height: 8,
        frameIndex: 7,
        historyValid: true,
        sampleTimeSeconds: 1.016,
      }),
    };
    const retryFrame = temporalResolveFrame(device, scope, frameState, {});
    const retried = executeCompiledFrameGraph(
      { device, errorRegistry: errors } as never,
      frameState,
      retryFrame,
      retryFrame.encoder,
      undefined,
      () => gpuCommitAfterSubmit.push(submits.mock.calls.length),
    );
    expect(retried).toBe(true);
    expect(submits).toHaveBeenCalledTimes(1);
    expect(gpuCommitAfterSubmit).toEqual([1]);
    expect(frameState.activeTemporalGpuState).not.toBe(active);
    expect(frameState.successfulTemporalFrameIndex).toBe(8);
    expect(frameState.lastSuccessfulTemporalView?.sampleTimeSeconds).toBe(1.016);
    expect(frameState.temporalGpuState).toBeUndefined();
    expect(frameState.retiringTemporalGpuStates.size).toBe(1);
    expect(publishEnvironment).toHaveBeenCalledTimes(1);
    expect(discardEnvironment).toHaveBeenCalledTimes(1);
    active.childScope.retire();
    frameState.activeTemporalGpuState?.childScope.retire();
    scope.dispose();
  });
});

import { executeAutoExposureFrameTransaction } from '../assembly/renderer-frame-transaction';
import { createAutoExposureState } from '../pipeline/standard-output/auto-exposure/state';
import { createTemporalFrameTransaction } from '../temporal/frame';

describe('renderer frame transaction ownership', () => {
  it('does not publish a LUT generation when submit fails', () => {
    let published = 0;
    const result = executeRendererFrameTransaction({
      build: () => ({ ok: true, value: { generation: 4, resident: 'lut:candidate' } }),
      execute: () => ({ ok: true, value: undefined }),
      finish: () => ({ ok: true, value: undefined }),
      submit: () => ({ ok: false, stage: 'submit' as const }),
      commit: () => {
        published += 1;
      },
    });
    expect(result).toEqual({ ok: false, error: { stage: 'submit' } });
    expect(published).toBe(0);
  });

  it('does not advance state when recording fails after graph construction', () => {
    const initial = createAutoExposureState({
      fallback: 1,
      targetGeneration: 7,
      deviceEpoch: 3,
    });
    if (!initial.ok) throw initial.error;
    const result = executeAutoExposureFrameTransaction(
      initial.value,
      { ev: 0.75, generation: 7, deviceEpoch: 3, frameId: 11 },
      { failAt: 'execute' },
    );

    expect(result.ok).toBe(false);
    expect(result.state).toBe(initial.value);
    expect(result.state.targetGeneration).toBe(7);
    expect(result.state.receipt.committed).toBe(false);
  });
});

describe('frame completion stage inspection', () => {
  it('keeps independent fences pending and snapshots detached until their producers settle', async () => {
    let finishQueue!: () => void;
    let finishReflection!: () => void;
    const queue = new Promise<void>((resolve) => {
      finishQueue = resolve;
    });
    const reflection = new Promise<void>((resolve) => {
      finishReflection = resolve;
    });
    const inspect = observeFrameCompletionStages(queue, reflection);
    const original = Promise.all([queue, reflection]);
    let completed = false;
    void original.then(() => {
      completed = true;
    });
    const pending = inspect();
    expect(pending).toEqual({ queue: 'pending', reflection: 'pending' });
    expect(Object.isFrozen(pending)).toBe(true);
    finishQueue();
    await queue;
    expect(inspect()).toEqual({ queue: 'fulfilled', reflection: 'pending' });
    expect(completed).toBe(false);
    finishReflection();
    await original;
    expect(inspect()).toEqual({ queue: 'fulfilled', reflection: 'fulfilled' });
    expect(pending).toEqual({ queue: 'pending', reflection: 'pending' });
  });

  it('handles diagnostic rejection while preserving the original producer failure', async () => {
    const error = new Error('original queue failure');
    const queue = Promise.reject(error);
    const inspect = observeFrameCompletionStages(queue, undefined);
    await expect(queue).rejects.toBe(error);
    expect(inspect()).toEqual({ queue: 'rejected', reflection: 'not-required' });
    const reflection = Promise.reject(error);
    const withReflection = observeFrameCompletionStages(Promise.resolve(), reflection);
    await expect(reflection).rejects.toBe(error);
    expect(withReflection()).toEqual({ queue: 'fulfilled', reflection: 'rejected' });
  });
});

it('reuses a retained TAA binding while preserving uploads, pipeline checks and resource replacement', async () => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const scope = DeviceScope.create(93, 'taa-binding-owner');
  const frameState = {
    temporalGpuState: undefined,
    activeTemporalGpuState: undefined,
    retiringTemporalGpuStates: new Set(),
  } as unknown as RenderFrameState;
  const graph = await buildTemporalResolveGraph(device);
  const groups = vi.spyOn(device, 'createBindGroup');
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  const execute = async (pipeline: object | null = {}) => {
    const frame = temporalResolveFrame(device, scope, frameState, pipeline);
    graph.execute(frame).unwrap();
    device.queue.submit([frame.encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
  };
  try {
    await execute();
    const firstWrites = writes.mock.calls.length;
    await execute();
    const count = () =>
      groups.mock.calls.filter(([desc]) => desc.label === 'taa-resolve-bind-group').length;
    expect(count()).toBe(1);
    expect(writes).toHaveBeenCalledTimes(firstWrites + 1);
    await expect(execute(null)).rejects.toBeDefined();
    expect(count()).toBe(1);
    const state = getTemporalGpuState(frameState, device, scope, 8, 8);
    const previous = state.paramsBuffer;
    state.paramsBuffer = device.createBuffer({ size: 32, usage: 0x48 }).unwrap();
    await execute();
    await execute();
    expect(count()).toBe(2);
    state.paramsBuffer = previous;
    await execute();
    expect(count()).toBe(2);
  } finally {
    (await graph.retire()).unwrap();
    scope.retire();
  }
});
