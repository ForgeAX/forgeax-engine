import { compiledRenderGraphGeneration, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import { ReflectionProbeRecordOwner } from '../../reflection/record-owner';
import { createRenderWorld, renderSubmission } from '../../world/render-world';
import { ViewSsrAdmission } from '../../world/ssr-admission-systems';
import {
  type CubeCaptureFrameInput,
  createFrameRecordingAttempt,
  stageFrameCaptureCompletion,
} from '../frame';
import {
  type FrameGraphTargets,
  getTextureIdentity,
  type RenderFrameState,
} from '../frame-snapshot';
import type { RenderSystemInternals } from '../render-context';

async function fixture(counter: number) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const builder = new RenderGraphBuilder();
  const handle = builder
    .createTexture('reflection-fallback-linear-hdr', {
      format: 'rgba16float',
      size: { width: 1, height: 1 },
    })
    .unwrap();
  const view = builder.view(handle).unwrap();
  builder
    .addRasterPass('fallback', {
      accesses: [{ resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      encode() {},
    })
    .unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const access = graph as typeof graph & Omit<FrameGraphTargets, 'graphGeneration'>;
  const targets: FrameGraphTargets = {
    graphGeneration: compiledRenderGraphGeneration(graph),
    getColorTargetTexture: (name) => access.getColorTargetTexture(name),
    getColorTargetView: (name) => access.getColorTargetView(name),
    getColorTargetDescriptor: (name) => access.getColorTargetDescriptor(name),
  };
  const texture = targets.getColorTargetTexture('reflection-fallback-linear-hdr');
  const descriptor = targets.getColorTargetDescriptor('reflection-fallback-linear-hdr');
  if (texture === undefined || descriptor === undefined) throw new Error('Missing fallback target');
  const world = createRenderWorld();
  const viewEntity = world
    .spawn({
      component: ViewSsrAdmission,
      data: {
        state: world.allocUniqueRef('ViewSsrAdmission', {
          frame: renderSubmission(world).frame,
          outcome: { kind: 'resolved', reflectionFallbackDemand: true },
        }),
      },
    })
    .unwrap();
  renderSubmission(world).accepted = true;
  const internals = {
    device,
    deviceScope: { owner: 'test', generation: 0 },
    assets: {},
    gpuStore: { getCubemapIbl: () => undefined },
    captureReflectionFallbackReadback: true,
    renderWorld: world,
    viewEntity,
  } as unknown as RenderSystemInternals;
  const owner = new ReflectionProbeRecordOwner(internals);
  // biome-ignore lint/complexity/useLiteralKeys: Exercise the existing producer staging authority.
  const tickets = owner['stageFallbackProjections'](
    [],
    new Map([['receiver', { kind: 'skylight' }]]),
    new Map(),
    7,
    {
      entityHandle: 1,
      equirectHandle: 1,
      color: [1, 1, 1],
      intensity: 1,
      rotation: [0, 0, 0, 1],
    },
    undefined,
  ).tickets;
  const state = {
    frameNumber: 7,
    graphGeneration: counter,
    compiledFrameGraph: { graph, targets, topologyKey: 'fallback' },
    reflectionFallbackObservationSource: { texture, descriptor, frameId: 7 },
  } as unknown as RenderFrameState;
  const capture = {
    state: {},
    reflectionProbes: {
      completeSubmission: (
        ...args: Parameters<
          NonNullable<CubeCaptureFrameInput['reflectionProbes']>['completeSubmission']
        >
      ) =>
        // biome-ignore lint/complexity/useLiteralKeys: Preserve the real strict publication owner.
        owner['completeSubmission'](args[0], tickets, args[1], args[2]),
    },
  } as unknown as CubeCaptureFrameInput;
  const attempt = createFrameRecordingAttempt(undefined);
  attempt.submitted = true;
  const readback = {
    linearHdr: [1, 1, 1, 1] as const,
    hash: 'actual-target-control',
    graphGeneration: targets.graphGeneration,
    textureIdentity: getTextureIdentity(texture),
  };
  const finish = async () => {
    stageFrameCaptureCompletion(internals, state, attempt, capture, true);
    await state.reflectionFallbackCompletion;
  };
  return { owner, state, attempt, readback, targets, graph, finish };
}

it.each([
  34, 36,
])('publishes installed graph identity independently of view counter %i', async (counter) => {
  const f = await fixture(counter);
  f.attempt.completion = Promise.resolve();
  f.attempt.fallbackReadback = Promise.resolve(f.readback);
  expect(f.targets.graphGeneration).not.toBe(counter);
  await f.finish();
  expect(f.state.graphGeneration).toBe(counter);
  expect(f.owner.inspect().reflectionFallback).toMatchObject({ state: 'active', frameId: 7 });
  expect(f.owner.inspect().reflectionFallbackInspection.failureCode).toBeUndefined();
  await f.graph.retire();
});

it('keeps the submitted identity after a graph is replaced while its fence is pending', async () => {
  const f = await fixture(34);
  let complete!: () => void;
  f.attempt.completion = new Promise<void>((resolve) => {
    complete = resolve;
  });
  f.attempt.fallbackReadback = Promise.resolve(f.readback);
  const pending = f.finish();
  expect(f.owner.inspect().reflectionFallback.state).not.toBe('active');
  f.state.compiledFrameGraph = null;
  f.state.graphGeneration += 1;
  complete();
  await pending;
  expect(f.owner.inspect().reflectionFallback).toMatchObject({ state: 'active', frameId: 7 });
  await f.graph.retire();
});

it.each([
  'graphGeneration',
  'textureIdentity',
] as const)('rejects a real %s mismatch', async (field) => {
  const f = await fixture(34);
  f.attempt.completion = Promise.resolve();
  f.attempt.fallbackReadback = Promise.resolve({ ...f.readback, [field]: f.readback[field] + 1 });
  await f.finish();
  expect(f.owner.inspect().reflectionFallback.state).not.toBe('active');
  expect(f.owner.inspect().reflectionFallbackInspection.failureCode).toBe(
    'reflection-fallback-identity-mismatch',
  );
  await f.graph.retire();
});

it('rejects a non-neutral output without an installed graph authority', async () => {
  const f = await fixture(34);
  f.state.compiledFrameGraph = null;
  f.attempt.completion = Promise.resolve();
  f.attempt.fallbackReadback = Promise.resolve(f.readback);
  await f.finish();
  expect(f.owner.inspect().reflectionFallback.state).not.toBe('active');
  expect(f.owner.inspect().reflectionFallbackInspection.failureCode).toBe(
    'reflection-fallback-output-missing',
  );
  await f.graph.retire();
});
