import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { RenderFeatureExecutionFrame } from '../features/frame-execution';
import type { RenderFeaturePlanExecutionPass } from '../features/host';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import { projectRenderFeaturePlans } from '../features/render-graph-contribution';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing compute chain fixture value');
  return value;
}

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const session = owner.beginFeature('chain', 0);
  const passes: RenderFeaturePlanExecutionPass[] = [];
  for (let emitter = 0; emitter < 2; emitter++) {
    const program = session
      .prepareProgram(`emitter-${emitter}`, {
        wgsl: 'synthetic',
        entryPoints: ['step'],
        bindings: [{ entries: [{ binding: 0, visibility: 4, buffer: { type: 'uniform' } }] }],
      })
      .unwrap();
    for (let tick = 0; tick < 4; tick++) {
      const name = `emitter-${emitter}.tick-${tick}`;
      const runtime = session
        .prepareBuffer(`${name}.runtime`, {
          size: 16,
          usage: ['uniform'],
          data: new Uint32Array([tick, 0, 0, 0]),
        })
        .unwrap();
      const bindings = session
        .prepareBindings(name, {
          program,
          entries: [{ binding: 0, buffer: runtime }],
        })
        .unwrap();
      const gpuCompute = {
        program,
        bindings,
        dispatches: [{ entryPoint: 'step', workgroups: [1] as const }],
      };
      passes.push({
        featureIdentity: 'chain',
        order: 0,
        name,
        gpuCompute,
        resolvedGpuCompute: session.resolveComputePass('chain', gpuCompute).unwrap(),
      });
    }
  }
  return { device, owner, session, passes };
}

it('coalesces adjacent emitter ticks while reading each logical pass from the current frame', async () => {
  const { device, owner, passes } = await fixture();
  const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
  projectRenderFeaturePlans(builder, [{ featureIdentity: 'chain', order: 0, passes }], {
    resolveTarget: () => undefined,
  }).unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  try {
    expect(graph.inspect().passes.map((pass) => pass.name)).toEqual([
      'emitter-0.tick-0',
      'emitter-1.tick-0',
    ]);
    for (const ticks of [4, 1, 0, 3]) {
      const encoder = device.createCommandEncoder().unwrap();
      const begin = encoder.beginComputePass.bind(encoder);
      const groups: unknown[] = [];
      const begins = vi.spyOn(encoder, 'beginComputePass').mockImplementation((descriptor) => {
        const pass = begin(descriptor);
        const bind = pass.setBindGroup.bind(pass);
        vi.spyOn(pass, 'setBindGroup').mockImplementation((index, group, offsets) => {
          groups.push(group);
          bind(index, group, offsets);
        });
        return pass;
      });
      const active = passes.map((pass, index) => ({ ...pass, enabled: index % 4 < ticks }));
      graph
        .execute({
          encoder,
          featureExecutions: [{ featureIdentity: 'chain', order: 0, passes: active }],
        })
        .unwrap();
      expect(begins).toHaveBeenCalledTimes(ticks === 0 ? 0 : 2);
      expect(groups).toEqual(
        active
          .filter((pass) => pass.enabled)
          .map((pass) => pass.resolvedGpuCompute?.dispatches[0]?.bindGroup),
      );
    }
  } finally {
    await graph.retire();
    owner.dispose().unwrap();
  }
});

it('reads each view scope of the same feature from the current submission', async () => {
  const { device, owner, passes } = await fixture();
  const framePasses = passes.slice(0, 4);
  const viewPasses = passes.slice(4);
  const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
  projectRenderFeaturePlans(
    builder,
    [
      { featureIdentity: 'chain', order: 0, passes: framePasses },
      { featureIdentity: 'chain', order: 0, passes: viewPasses },
    ],
    { resolveTarget: () => undefined },
  ).unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  try {
    for (const ticks of [1, 0, 3]) {
      const activeView = viewPasses.map((pass, index) => ({ ...pass, enabled: index < ticks }));
      const groups: unknown[] = [];
      const begun = device.createCommandEncoder().unwrap();
      const open = begun.beginComputePass.bind(begun);
      const begin = vi.spyOn(begun, 'beginComputePass').mockImplementation((descriptor) => {
        const compute = open(descriptor),
          bind = compute.setBindGroup.bind(compute);
        vi.spyOn(compute, 'setBindGroup').mockImplementation((index, group, offsets) => {
          groups.push(group);
          bind(index, group, offsets);
        });
        return compute;
      });
      graph
        .execute({
          encoder: begun,
          featureExecutions: [
            { featureIdentity: 'chain', order: 0, passes: framePasses },
            {
              featureIdentity: 'unrelated',
              order: 1,
              passes: viewPasses.map((pass) => ({ ...pass, featureIdentity: 'unrelated' })),
            },
            { featureIdentity: 'chain', order: 0, passes: activeView },
          ],
        })
        .unwrap();
      expect(begin).toHaveBeenCalledTimes(ticks === 0 ? 1 : 2);
      expect(groups).toEqual(
        [...framePasses, ...activeView.filter((pass) => pass.enabled)].map(
          (pass) => pass.resolvedGpuCompute?.dispatches[0]?.bindGroup,
        ),
      );
    }
  } finally {
    await graph.retire();
    owner.dispose().unwrap();
  }
});

it.each([
  'frame',
  'view:first',
])('keeps duplicate coalesced local names within their current %s owner', async (firstScope) => {
  const { device, owner, passes } = await fixture();
  const views = [passes.slice(0, 4), passes.slice(4)].map((group, view) => ({
    featureIdentity: 'chain',
    order: 0,
    scope: view === 0 ? firstScope : 'view:second',
    passes: group.map((pass, index) => ({
      ...pass,
      name: index === 1 ? 'shared-local' : `view-${view}-${index}`,
    })),
  }));
  const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
  projectRenderFeaturePlans(builder, views, { resolveTarget: () => undefined }).unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  try {
    expect(graph.inspect().passes.map((pass) => pass.name)).toEqual(['view-0-0', 'view-1-0']);
    const encoder = device.createCommandEncoder().unwrap(),
      begin = encoder.beginComputePass.bind(encoder);
    const groups: unknown[] = [];
    vi.spyOn(encoder, 'beginComputePass').mockImplementation((descriptor) => {
      const compute = begin(descriptor),
        bind = compute.setBindGroup.bind(compute);
      vi.spyOn(compute, 'setBindGroup').mockImplementation((index, group, offsets) => {
        groups.push(group);
        bind(index, group, offsets);
      });
      return compute;
    });
    graph.execute({ encoder, featureExecutions: views }).unwrap();
    expect(groups).toEqual(
      views.flatMap((view) =>
        view.passes.map((pass) => pass.resolvedGpuCompute?.dispatches[0]?.bindGroup),
      ),
    );
  } finally {
    await graph.retire();
    owner.dispose().unwrap();
  }
});

it('keeps rejecting duplicate declared graph pass names across scopes', async () => {
  const { owner, passes } = await fixture();
  try {
    const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
    const result = projectRenderFeaturePlans(
      builder,
      [
        { featureIdentity: 'chain', order: 0, scope: 'frame', passes: passes.slice(0, 4) },
        {
          featureIdentity: 'chain',
          order: 0,
          scope: 'view:second',
          passes: passes.slice(4).map((pass, index) => ({
            ...pass,
            name: index === 0 ? required(passes[0]).name : pass.name,
          })),
        },
      ],
      { resolveTarget: () => undefined },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'duplicate-pass-name' } });
  } finally {
    owner.dispose().unwrap();
  }
});

it('keeps a copy boundary between adjacent ticks', async () => {
  const { device, owner, passes } = await fixture();
  const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
  const copy: RenderFeaturePlanExecutionPass = {
    featureIdentity: 'chain',
    order: 0,
    name: 'copy',
    resolvedGpuCopies: [],
  };
  projectRenderFeaturePlans(
    builder,
    [
      {
        featureIdentity: 'chain',
        order: 0,
        passes: [required(passes[0]), copy, ...passes.slice(1, 4)],
      },
    ],
    {
      resolveTarget: () => undefined,
    },
  ).unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  try {
    expect(graph.inspect().passes.map((pass) => pass.name)).toEqual([
      'emitter-0.tick-0',
      'copy',
      'emitter-0.tick-1',
    ]);
  } finally {
    await graph.retire();
    owner.dispose().unwrap();
  }
});

it('keeps sampled and storage target work outside a buffer-only chain', async () => {
  const { device, owner, passes } = await fixture();
  const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
  const texture = builder
    .createTexture('target', {
      format: 'rgba8unorm',
      size: { width: 1, height: 1 },
      usage: 4 | 8,
    })
    .unwrap();
  const view = builder.view(texture).unwrap();
  const logical = passes.slice(0, 4).map((pass, index) => ({
    ...pass,
    resolvedGpuCompute: {
      ...required(pass.resolvedGpuCompute),
      ...(index === 1 ? { storageTargets: ['target'] } : {}),
      ...(index === 2 ? { sampledTargets: ['target'] } : {}),
    },
  }));
  projectRenderFeaturePlans(builder, [{ featureIdentity: 'chain', order: 0, passes: logical }], {
    resolveTarget: () => ({ texture, view }),
  }).unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  try {
    expect(graph.inspect().passes.map((pass) => pass.name)).toEqual(
      logical.map((pass) => pass.name),
    );
  } finally {
    await graph.retire();
    owner.dispose().unwrap();
  }
});

it('keeps distinct access roles for an aliased physical buffer in separate passes', async () => {
  const { device, owner, session, passes } = await fixture();
  const reference = session.prepareBuffer('shared', { size: 16, usage: ['storage'] }).unwrap();
  const resource = required(session.resolveBuffer(reference));
  const logical = passes.slice(0, 2).map((pass, index) => ({
    ...pass,
    resolvedGpuCompute: {
      ...required(pass.resolvedGpuCompute),
      buffers: [
        {
          ...resource,
          name: `alias-${index}`,
          access: index === 0 ? ('storage-read' as const) : ('storage-read-write' as const),
        },
      ],
    },
  }));
  const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
  projectRenderFeaturePlans(builder, [{ featureIdentity: 'chain', order: 0, passes: logical }], {
    resolveTarget: () => undefined,
  }).unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  try {
    expect(graph.inspect().passes.map((pass) => pass.name)).toEqual(
      logical.map((pass) => pass.name),
    );
  } finally {
    await graph.retire();
    owner.dispose().unwrap();
  }
});

it('reports the failing logical tick inside a merged physical pass', async () => {
  const { device, owner, passes } = await fixture();
  const reportError = vi.fn();
  const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
  projectRenderFeaturePlans(builder, [{ featureIdentity: 'chain', order: 0, passes }], {
    resolveTarget: () => undefined,
    reportError,
  }).unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    const begin = encoder.beginComputePass.bind(encoder);
    vi.spyOn(encoder, 'beginComputePass').mockImplementation((descriptor) => {
      const pass = begin(descriptor);
      const bind = pass.setBindGroup.bind(pass);
      vi.spyOn(pass, 'setBindGroup').mockImplementation((index, group, offsets) => {
        if (group === required(passes[2]).resolvedGpuCompute?.dispatches[0]?.bindGroup)
          throw new Error('Injected binding failure');
        bind(index, group, offsets);
      });
      return pass;
    });
    expect(graph.execute({ encoder }).ok).toBe(false);
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError.mock.calls[0]?.[0]).toMatchObject({
      code: 'render-feature-draw-recording-failed',
      detail: { featureIdentity: 'chain', operation: 'emitter-0.tick-2' },
    });
  } finally {
    await graph.retire();
    owner.dispose().unwrap();
  }
});

it('does not coalesce across a pass selector gap', async () => {
  const { device, owner, passes } = await fixture();
  const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
  projectRenderFeaturePlans(builder, [{ featureIdentity: 'chain', order: 0, passes }], {
    resolveTarget: () => undefined,
    passNames: new Set(['emitter-0.tick-0', 'emitter-0.tick-2', 'emitter-0.tick-3']),
  }).unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  try {
    expect(graph.inspect().passes.map((pass) => pass.name)).toEqual([
      'emitter-0.tick-0',
      'emitter-0.tick-2',
    ]);
  } finally {
    await graph.retire();
    owner.dispose().unwrap();
  }
});
