import { World } from '@forgeax/engine-ecs';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import { resolveFeatureWorkResources } from '../features/frame-plan';
import { createRenderFeatureHost, getRenderFeaturePlanExecutionProjection } from '../features/host';
import {
  cloneRenderFeaturePlanSignatureSnapshot,
  renderFeaturePlanSignature,
  renderFeaturePlanSignatureSnapshotEquals,
  validateRenderFeaturePlan,
} from '../features/plan';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import {
  createRenderFeatureProjectionState,
  projectRenderFeaturePlans,
} from '../features/render-graph-contribution';
import { RhiErrorListenerRegistry } from '../lifecycle';
import type { RenderFrameState } from '../record/frame-snapshot';
import { getRenderFeatureGraphState } from '../record/typed-frame-graph';
import type { RenderPipelineFrame } from '../render-pipeline';
import {
  abortStagedTemporalGpuState,
  commitTemporalGpuSubmit,
  getTemporalGpuState,
  stageTemporalGpuWrite,
  temporalReadIndex,
} from '../temporal/gpu';
import { abortFeatureFrame, prepareFeatureFrame } from './feature-frame-driver';
import { executeCompiledFrameGraph } from './frame-recording-driver';

it.each([
  'atomic',
  'atomic-skipped',
  'atomic-disabled',
  'ordinary',
] as const)('keeps actual compute receipt boundaries for %s', async (mode) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'null-rhi-compute' })).unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const host = createRenderFeatureHost([
    {
      identity: 'compute-boundaries',
      extract: () => ok(undefined),
      plan: () =>
        ok({
          work: [
            {
              scope: 'frame',
              ...(mode === 'ordinary' ? {} : { submission: 'atomic' as const }),
              resources: [
                {
                  kind: 'compute-program',
                  name: 'program',
                  program: {
                    wgsl: 'null-rhi-compute',
                    entryPoints: ['main'],
                    bindings: [
                      { entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }] },
                    ],
                  },
                },
                { kind: 'buffer', name: 'storage', size: 16, usage: ['storage'] },
                {
                  kind: 'compute-bindings',
                  name: 'binding',
                  program: 'program',
                  entries: [{ binding: 0, resource: 'storage' }],
                },
              ],
              passes: ['first', 'second'].map((name) => ({
                kind: 'compute' as const,
                name,
                enabled: !(name === 'second' && mode === 'atomic-disabled'),
                program: 'program',
                bindings: 'binding',
                dispatches: [
                  { kind: 'direct' as const, entryPoint: 'main', workgroups: [1] as const },
                ],
              })),
            },
          ],
        }),
    },
  ]).unwrap();
  try {
    const batch = prepareFeatureFrame(host, [
      {
        identity: 'view',
        render: true,
        world: new World(),
        frameNumber: 1,
        generation: 0,
        caps: device.caps,
        gpuWork: gpu,
      },
    ]);
    expect(batch.frame.errors).toEqual([]);
    const plans = batch.frame.plans;
    const builder = new RenderGraphBuilder<RenderPipelineFrame>();
    projectRenderFeaturePlans(
      builder,
      plans.map(getRenderFeaturePlanExecutionProjection).filter((value) => value !== undefined),
      { state: createRenderFeatureProjectionState(), resolveTarget: () => undefined },
    ).unwrap();
    const graph = builder.compile({ device, surfaceSize: { width: 4, height: 4 } }).unwrap();
    expect(graph.inspect().passes.map((pass) => pass.name)).toEqual(
      mode === 'ordinary' ? ['first'] : ['first', 'second'],
    );
    const noTarget = () => undefined;
    const frameState = {
      retiringTemporalGpuStates: new Set(),
      compiledFrameGraph: {
        graph,
        topologyKey: 'compute-boundaries',
        targets: {
          getColorTargetDescriptor: noTarget,
          getColorTargetView: noTarget,
          getColorTargetTexture: noTarget,
          graphGeneration: 0,
        },
      },
    } as unknown as RenderFrameState;
    const internals = { device, errorRegistry: new RhiErrorListenerRegistry() } as never;
    getRenderFeatureGraphState(internals).plans = plans;
    const submit = vi.spyOn(device.queue, 'submit');
    const accepted = executeCompiledFrameGraph(
      internals,
      frameState,
      {
        encoder: device.createCommandEncoder().unwrap(),
        pipelineState: {},
        targetW: 4,
        targetH: 4,
      } as never,
      (pass, encode) => {
        if (!(mode === 'atomic-skipped' && pass.name === 'second')) encode();
      },
    );
    expect(accepted).toBe(mode === 'atomic' || mode === 'ordinary');
    expect(submit).toHaveBeenCalledTimes(mode === 'atomic' || mode === 'ordinary' ? 1 : 0);
  } finally {
    abortFeatureFrame(host);
    host.dispose();
    gpu.dispose().unwrap();
  }
});

it('preserves atomic submission through closure, snapshot and topology signatures', () => {
  const plain = { resources: [], passes: [] };
  const atomic = { ...plain, submission: 'atomic' as const };
  expect(resolveFeatureWorkResources([{ ...atomic, scope: 'frame' }])[0]?.closure.submission).toBe(
    'atomic',
  );
  expect(cloneRenderFeaturePlanSignatureSnapshot(atomic).submission).toBe('atomic');
  expect(
    renderFeaturePlanSignatureSnapshotEquals(
      plain,
      cloneRenderFeaturePlanSignatureSnapshot(atomic),
    ),
  ).toBe(false);
  expect(renderFeaturePlanSignature(atomic)).not.toBe(renderFeaturePlanSignature(plain));
  expect(validateRenderFeaturePlan('test', { ...plain, submission: 'partial' as never }).ok).toBe(
    false,
  );
});

it('admits explicit attachment clears but rejects drawless loads and sampled work', () => {
  const clear = {
    kind: 'raster' as const,
    name: 'seed',
    colorAttachments: [{ target: 'output', loadOp: 'clear' as const, storeOp: 'store' as const }],
    draws: [],
  };
  const targets = [
    {
      name: 'output',
      kind: 'color' as const,
      format: 'rgba16float' as const,
      sampleCount: 1 as const,
    },
  ];
  expect(validateRenderFeaturePlan('seed', { resources: [], passes: [clear] }, targets).ok).toBe(
    true,
  );
  expect(
    validateRenderFeaturePlan(
      'seed',
      {
        resources: [],
        passes: [
          { ...clear, colorAttachments: [{ target: 'output', storeOp: 'store', loadOp: 'load' }] },
        ],
      },
      targets,
    ).ok,
  ).toBe(false);
  expect(
    validateRenderFeaturePlan(
      'seed',
      { resources: [], passes: [{ ...clear, sampledTargets: ['output'] }] },
      targets,
    ).ok,
  ).toBe(false);
});

it.each([
  'complete',
  'skip-producer',
  'skip-consumer',
  'taa-only',
] as const)('uses actual graph encoding and physical submission for %s', async (mode) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({
      createShaderModule: () => {
        throw new Error('Copy work has no shader');
      },
    }),
  });
  const host = createRenderFeatureHost([
    {
      identity: 'atomic-copy',
      extract: () => ok(undefined),
      plan: () =>
        ok({
          work:
            mode === 'taa-only'
              ? []
              : [
                  {
                    scope: 'frame',
                    submission: 'atomic',
                    resources: [
                      {
                        kind: 'buffer',
                        name: 'source',
                        size: 4,
                        usage: ['copy-src'],
                        data: new Uint32Array([17]),
                      },
                      { kind: 'buffer', name: 'middle', size: 4, usage: ['copy-src'] },
                      {
                        kind: 'buffer',
                        name: 'destination',
                        size: 4,
                        usage: ['copy-src'],
                      },
                    ],
                    passes: [
                      {
                        kind: 'copy',
                        name: 'producer',
                        copies: [{ source: 'source', destination: 'middle', size: 4 }],
                      },
                      {
                        kind: 'copy',
                        name: 'consumer',
                        copies: [{ source: 'middle', destination: 'destination', size: 4 }],
                      },
                    ],
                  },
                ],
        }),
    },
  ]).unwrap();
  const batch = prepareFeatureFrame(host, [
    {
      identity: 'view',
      render: true,
      world: new World(),
      frameNumber: 1,
      generation: 0,
      caps: device.caps,
      gpuWork: gpu,
    },
  ]);
  expect(batch.frame.errors).toEqual([]);
  const plans = batch.frame.plans;
  const scope = DeviceScope.create(123, 'atomic-test');
  const frameState = { retiringTemporalGpuStates: new Set() } as unknown as RenderFrameState;
  const state = getTemporalGpuState(frameState, device, scope, 4, 4, true);
  const builder = new RenderGraphBuilder<RenderPipelineFrame>();
  const projected = projectRenderFeaturePlans(
    builder,
    plans.map(getRenderFeaturePlanExecutionProjection).filter((value) => value !== undefined),
    { state: createRenderFeatureProjectionState(), resolveTarget: () => undefined },
  );
  expect(projected.ok).toBe(true);
  builder
    .addCopyPass('taa-writer', {
      accesses: [],
      encode: () => stageTemporalGpuWrite(frameState, state),
    })
    .unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 4, height: 4 } }).unwrap();
  const noTarget = () => undefined;
  frameState.compiledFrameGraph = {
    graph,
    topologyKey: 'atomic-test',
    targets: {
      getColorTargetDescriptor: noTarget,
      getColorTargetView: noTarget,
      getColorTargetTexture: noTarget,
      graphGeneration: 0,
    },
  } as never;
  const internals = { device, errorRegistry: new RhiErrorListenerRegistry() } as never;
  getRenderFeatureGraphState(internals).plans = plans;
  const submit = vi.spyOn(device.queue, 'submit');
  const skipped =
    mode === 'skip-producer' ? 'producer' : mode === 'skip-consumer' ? 'consumer' : undefined;
  try {
    const accepted = executeCompiledFrameGraph(
      internals,
      frameState,
      {
        encoder: device.createCommandEncoder().unwrap(),
        pipelineState: {},
        targetW: 4,
        targetH: 4,
      } as never,
      (pass, encode) => {
        if (pass.name !== skipped) encode();
      },
    );
    const expected = skipped === undefined;
    expect(accepted).toBe(expected);
    expect(submit).toHaveBeenCalledTimes(expected ? 1 : 0);
    if (expected) expect(commitTemporalGpuSubmit(state)).toBe(true);
    else abortStagedTemporalGpuState(frameState);
    expect(temporalReadIndex(state)).toBe(expected ? 1 : 0);
  } finally {
    abortFeatureFrame(host);
    host.dispose();
    gpu.dispose().unwrap();
    scope.retire();
  }
});
