import type { Buffer } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { vi } from 'vitest';
import { stageFeatureFrame } from '../../__tests__/feature-frame-driver';
import { DeviceScope } from '../../device/device-scope';
import { createFullscreenRenderFeature } from '../../features/fullscreen';
import { createRenderFeatureHost } from '../../features/host';
import type { RenderFeatureWork } from '../../features/plan';
import {
  createRenderFeatureGpuWorkOwner,
  ownRenderFeatureProgramData,
} from '../../features/prepared-gpu-work';
import type { RenderFeature } from '../../features/types';
import type { RenderSystemInternals } from '../../record/render-context';
import * as sharedGraphs from '../feature-graph-systems';
import { RENDER_FEATURE_GRAPH_ENCODE_SYSTEM } from '../graph-seal-systems';
import { frameEncoder } from '../record-systems';
import {
  endRenderFrame,
  publishRenderSubmission,
  RenderRecord,
  renderSubmission,
  runRenderRecord,
} from '../render-world';

function program(readOnly = false) {
  return ownRenderFeatureProgramData({
    wgsl: 'synthetic',
    entryPoints: ['main'],
    bindings: [
      {
        entries: [
          {
            binding: 0,
            visibility: 4,
            buffer: { type: readOnly ? ('read-only-storage' as const) : ('storage' as const) },
          },
        ],
      },
    ],
  });
}

export async function sharedNativeFixture() {
  let device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  let module = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  let scope = DeviceScope.create(0, 'shared-native-test');
  const buffers: { device: typeof device; buffer: Buffer }[] = [];
  const buffer = () => {
    const value = device.createBuffer({ size: 128, usage: 0x8c }).unwrap();
    buffers.push({ device, buffer: value });
    return value;
  };
  let source = buffer(),
    target = buffer();
  const gpuWork = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(module) }),
  });
  const writerProgram = program(),
    readerProgram = program(true);
  const conflictProgram = ownRenderFeatureProgramData({
    wgsl: 'synthetic-conflict',
    entryPoints: ['main'],
    bindings: [
      {
        entries: [
          { binding: 0, visibility: 4, buffer: { type: 'storage' as const } },
          { binding: 1, visibility: 4, buffer: { type: 'read-only-storage' as const } },
        ],
      },
    ],
  });
  const submitted = vi.fn<(data: null) => void>(),
    aborted = vi.fn<(data: null) => void>();
  const state = {
    count: 1,
    groups: 1,
    offset: 0,
    disabled: false,
    copies: true,
    mixed: false,
    secondNative: false,
    conflict: false,
    copyEnabled: true,
    fullscreen: false,
  };
  function work(count: number, prefix = '', groups = state.groups): RenderFeatureWork {
    const row: RenderFeatureWork = { scope: 'frame', resources: [], passes: [] };
    const resources =
      row.resources as import('../../features/plan').RenderFeatureResourceDeclaration[];
    const passes = row.passes as import('../../features/plan').RenderFeaturePassDeclaration[];
    resources.push(
      {
        kind: 'compute-program',
        name: 'writer',
        program: state.conflict ? conflictProgram : writerProgram,
      },
      { kind: 'compute-program', name: 'reader', program: readerProgram },
      {
        kind: 'prepared-gpu-resource',
        name: 'source',
        resource: { kind: 'buffer', value: source, size: 128, usage: ['storage', 'copy-src'] },
      },
      {
        kind: 'prepared-gpu-resource',
        name: 'target',
        resource: { kind: 'buffer', value: target, size: 128, usage: ['storage', 'copy-src'] },
      },
      {
        kind: 'compute-bindings',
        name: 'write-bindings',
        program: 'writer',
        entries: [
          { binding: 0, resource: 'source' },
          ...(state.conflict ? [{ binding: 1, resource: 'target' }] : []),
        ],
      },
      {
        kind: 'compute-bindings',
        name: 'read-bindings',
        program: 'reader',
        entries: [{ binding: 0, resource: 'target' }],
      },
    );
    for (let index = 0; index < count; index++) {
      passes.push({
        kind: 'compute',
        name: `${prefix}write-${index}`,
        enabled: !state.disabled,
        program: 'writer',
        bindings: 'write-bindings',
        dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [groups] }],
      });
      if (state.copies)
        passes.push({
          kind: 'copy',
          name: `${prefix}copy-${index}`,
          enabled: !state.disabled,
          copies: [
            {
              enabled: state.copyEnabled,
              source: 'source',
              sourceOffset: state.offset,
              destination: 'target',
              destinationOffset: state.offset + 4,
              size: 4,
            },
          ],
        });
      passes.push({
        kind: 'compute',
        name: `${prefix}read-${index}`,
        enabled: !state.disabled,
        program: 'reader',
        bindings: 'read-bindings',
        dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [groups + 1] }],
      });
    }
    return row;
  }
  const feature: RenderFeature<null> = {
    identity: 'native-shared',
    extract: () => ok(null),
    plan: (_source, context) => {
      const native = context.createNativePlan?.();
      if (native === undefined) throw new Error('Missing native writer');
      return ok(native.finish([{ ...native.scope('frame'), ...work(state.count) }]));
    },
    onFrameSubmitted: submitted,
    onFrameAborted: aborted,
  };
  const raw: RenderFeature<null> = {
    identity: 'raw-shared',
    extract: () => ok(null),
    plan: () => ok({ work: state.mixed ? [work(1, 'raw-')] : [] }),
  };
  const second: RenderFeature<null> = {
    identity: 'second-native-shared',
    extract: () => ok(null),
    plan: (_source, context) => {
      const native = context.createNativePlan?.();
      if (native === undefined) throw new Error('Missing second native writer');
      return ok(
        native.finish(
          state.secondNative ? [{ ...native.scope('frame'), ...work(1, 'second-', 9) }] : [],
        ),
      );
    },
  };
  const fullscreen = createFullscreenRenderFeature({
    identity: 'shared-test-outline',
    source: '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }',
    stage: 'before-temporal',
    reads: ['sceneColor', { key: 'depth', sampleType: 'depth' }],
    params: { byteSize: 80, defaultValue: new Uint8Array(80) },
    enabled: () => state.fullscreen,
  });
  const host = createRenderFeatureHost([feature, second, raw, fullscreen]).unwrap();
  const world = host.world;
  const internals = {
    device,
    deviceScope: scope,
    canvas: { width: 8, height: 8 },
    renderWorld: world,
    errorRegistry: { fire: vi.fn() },
    framePassNames: [],
  } as unknown as RenderSystemInternals;
  world.removeSystem(RenderRecord, RENDER_FEATURE_GRAPH_ENCODE_SYSTEM).unwrap();
  let frame = 0;
  function stage(count = state.count) {
    state.count = count;
    const sealed = stageFeatureFrame(host, [
      {
        identity: 'main',
        render: true,
        worlds: [],
        owner: 0,
        frameNumber: ++frame,
        generation: scope.generation,
        caps: device.caps,
        gpuWork,
      },
    ]);
    if (sealed.kind !== 'sealed') throw new Error(`Feature frame ${sealed.kind}`);
    if (sealed.batch.frame.errors.length) throw sealed.batch.frame.errors[0];
    sharedGraphs.stageSharedFeatureGraph(world, internals);
    const recorded = runRenderRecord(world, { device, frameId: frame });
    if (!recorded.ok) throw recorded.error;
    const outcome = sharedGraphs.sharedFeatureGraphOutcome(world);
    return { outcome, encoder: frameEncoder(world), sealed };
  }
  function prepare(count = state.count) {
    const { outcome, encoder, sealed } = stage(count);
    if (outcome?.ok !== true) throw new Error('Shared graph did not compile');
    return { receipt: outcome.receipt, encoder, sealed };
  }
  function finish(accepted = true, completion = Promise.resolve()) {
    publishRenderSubmission(world, {
      accepted,
      completion,
      creditCompletion: undefined,
      generation: scope.generation,
    });
    endRenderFrame(world);
  }
  return {
    state,
    host,
    world,
    internals,
    submitted,
    aborted,
    prepare,
    stage,
    finish,
    encode: (encoder: ReturnType<typeof frameEncoder>) =>
      sharedGraphs.encodeSharedFeatureGraph(world, encoder),
    scope: () => scope,
    source: () => source,
    target: () => target,
    replaceBuffer: () => {
      source = buffer();
    },
    alias: (value: boolean) => {
      target = value ? source : buffer();
    },
    async replaceDevice() {
      scope.dispose();
      device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      module = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
      scope = DeviceScope.create(scope.generation + 1, 'shared-native-test');
      source = buffer();
      target = buffer();
      Object.assign(internals, { device, deviceScope: scope });
    },
    async dispose() {
      if (renderSubmission(world).open) finish(false);
      host.dispose().unwrap();
      gpuWork.dispose().unwrap();
      scope.dispose();
      for (const entry of buffers) entry.device.destroyBuffer(entry.buffer).unwrap();
      await Promise.resolve();
    },
  };
}

export function recordDispatches(encoder: ReturnType<typeof frameEncoder>) {
  const groups: number[][] = [];
  const begin = encoder.beginComputePass.bind(encoder);
  const compute = vi.spyOn(encoder, 'beginComputePass').mockImplementation((...args) => {
    const pass = begin(...args);
    vi.spyOn(pass, 'dispatchWorkgroups').mockImplementation((x, y = 1, z = 1) => {
      groups.push([x, y, z]);
    });
    return pass;
  });
  return { groups, compute, copies: vi.spyOn(encoder, 'copyBufferToBuffer') };
}
