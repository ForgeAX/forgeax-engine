import { type GraphAccess, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { Buffer, RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { RenderFeatureExecutionFrame } from '../features/frame-execution';
import {
  createRenderFeatureHost,
  getRenderFeaturePlanExecutionProjection,
  type RenderFeatureFrameBatch,
  type RenderFeaturePlanExecution,
  runRenderFeatureFrame,
} from '../features/host';
import type { RenderFeaturePlannedFrame, RenderFeatureWork } from '../features/plan';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import { createRenderFeatureProjectionState } from '../features/render-graph-contribution';
import { createRenderFeatureTarget } from '../features/targets';
import {
  inspectTransientViewGraphs,
  projectTransientViewPlans,
  selectTransientViewPlans,
  transientViewExecutionEligible,
} from '../features/transient-view-graph';
import type { RenderFeature } from '../features/types';
import { createPreparedGraphicsResolver } from '../prepare/prepared-graphics-resolver';

const identity = 'test.transient-particles';
const size = { width: 8, height: 4 };
const shaderSource = `
@group(0) @binding(0) var<storage, read_write> vertices: array<u32>;
@group(0) @binding(1) var<storage, read_write> commands: array<u32>;
@compute @workgroup_size(1) fn project() { vertices[0] = vertices[0]; commands[0] = 3u; }
@vertex fn vertex(@location(0) p: vec3f) -> @builtin(position) vec4f { return vec4f(p, 1.0); }
@fragment fn fragment() -> @location(0) vec4f { return vec4f(1.0); }
`;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing transient graph fixture value');
  return value;
}

function work(count: number, epoch: number): RenderFeatureWork {
  const resources: RenderFeatureWork['resources'][number][] =
    count === 0
      ? []
      : [
          {
            kind: 'compute-program',
            name: 'projection',
            program: {
              wgsl: shaderSource,
              entryPoints: ['project'],
              bindings: [
                {
                  entries: [
                    { binding: 0, visibility: 4, buffer: { type: 'storage' } },
                    { binding: 1, visibility: 4, buffer: { type: 'storage' } },
                  ],
                },
              ],
            },
          },
          {
            kind: 'graphics-program',
            name: 'graphics',
            program: {
              shader: 'test::transient',
              vertexLayout: 'position',
              colorFormats: ['rgba8unorm'],
            },
          },
        ];
  if (count > 0)
    resources.push({
      kind: 'graphics-bindings',
      name: 'graphics-bindings',
      program: 'graphics',
      values: { group: 0 },
    });
  const passes: RenderFeatureWork['passes'][number][] = [];
  for (let index = 0; index < count; index++) {
    const name = `epoch-${epoch}.emitter-${index}`;
    resources.push(
      {
        kind: 'buffer',
        name: `${name}.seed`,
        size: 36,
        usage: ['copy-src'],
        data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      },
      { kind: 'buffer', name: `${name}.vertices`, size: 36, usage: ['storage', 'vertex'] },
      {
        kind: 'buffer',
        name: `${name}.indirect`,
        size: 16,
        usage: ['storage', 'indirect'],
        data: new Uint32Array([3, 1, 0, 0]),
      },
      {
        kind: 'vertex-data',
        name: `${name}.vertex-data`,
        layout: 'position',
        buffer: `${name}.vertices`,
      },
      {
        kind: 'compute-bindings',
        name: `${name}.bindings`,
        program: 'projection',
        entries: [
          { binding: 0, resource: `${name}.vertices` },
          { binding: 1, resource: `${name}.indirect` },
        ],
      },
    );
    passes.push(
      {
        kind: 'copy',
        name: `${name}.copy`,
        copies: [{ source: `${name}.seed`, destination: `${name}.vertices`, size: 36 }],
      },
      {
        kind: 'compute',
        name: `${name}.project`,
        program: 'projection',
        bindings: `${name}.bindings`,
        dispatches: [{ kind: 'direct', entryPoint: 'project', workgroups: [1] }],
      },
      {
        kind: 'raster',
        name: `${name}.raster`,
        colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
        draws: [
          {
            program: 'graphics',
            bindings: ['graphics-bindings'],
            vertexData: [{ slot: 0, resource: `${name}.vertex-data` }],
            draw: { kind: 'draw-indirect', resource: `${name}.indirect`, offset: 0 },
          },
        ],
      },
    );
  }
  return { scope: { view: 'main' }, resources, passes };
}

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: shaderSource })).unwrap();
  const graphicsLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const graphicsBindings = device.createBindGroup({ layout: graphicsLayout, entries: [] }).unwrap();
  const graphics = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [graphicsLayout] }).unwrap(),
      vertex: {
        module: shader,
        entryPoint: 'vertex',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        ],
      },
      fragment: { module: shader, entryPoint: 'fragment', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  let count = 0,
    epoch = 0;
  const feature: RenderFeature<undefined> = {
    identity,
    viewGraph: 'transient',
    extract: () => ok(undefined),
    plan: () => ok({ work: [work(count, epoch)] }),
  };
  const host = createRenderFeatureHost([feature]).unwrap();
  const target = createRenderFeatureTarget({
    name: 'color',
    kind: 'scene-color',
    format: 'rgba8unorm',
    sampleCount: 1,
  });
  const batches: RenderFeatureFrameBatch[] = [];
  function prepare(next: number, nextEpoch: number) {
    count = next;
    epoch = nextEpoch;
    const batch = runRenderFeatureFrame(host, [
      {
        identity: 'main',
        render: true,
        worlds: [],
        owner: 0,
        frameNumber: epoch + 1,
        generation: 0,
        caps: device.caps,
        gpuWork: gpu,
        targets: [target],
        createPreparedGraphicsResolver: (input) =>
          createPreparedGraphicsResolver({
            device,
            featureIdentity: input.featureIdentity,
            featureOrder: input.order,
            generation: input.generation,
            capabilityAvailable: true,
            lookup: input.lookup,
            resolvePipeline: () => ok(graphics),
            resolveBindings: () => ok(graphicsBindings),
            resolveGpuBuffer: (reference) => gpu.resolveBuffer(input.featureIdentity, reference),
          }),
      },
    ]);
    batches.push(batch);
    const view = required(batch.views.get('main'));
    expect(view.errors).toEqual([]);
    batch.commitPreparedResources();
    const plan = required(view.plans[0]);
    const execution = required(getRenderFeaturePlanExecutionProjection(plan));
    return { batch, plan, execution };
  }
  return {
    device,
    graphics,
    prepare,
    async dispose() {
      for (const batch of batches) {
        batch.onAborted();
        for (const resources of batch.preparedResourceBatches) resources.release().unwrap();
      }
      gpu.dispose().unwrap();
      host.dispose();
    },
  };
}

type Frame = RenderFeatureExecutionFrame & { readonly mesh: Buffer };

function observe(encoder: RhiCommandEncoder) {
  const vertices: Buffer[] = [],
    indirect: Buffer[] = [],
    copies: [Buffer, Buffer][] = [],
    events: string[] = [];
  const beginRender = encoder.beginRenderPass.bind(encoder);
  encoder.beginRenderPass = (descriptor) => {
    const pass = beginRender(descriptor),
      set = pass.setVertexBuffer.bind(pass),
      draw = pass.drawIndirect.bind(pass);
    pass.setVertexBuffer = (slot, buffer, offset, bytes) => {
      vertices.push(buffer);
      return set(slot, buffer, offset, bytes);
    };
    pass.drawIndirect = (buffer, offset) => {
      indirect.push(buffer);
      return draw(buffer, offset);
    };
    return pass;
  };
  const copy = encoder.copyBufferToBuffer.bind(encoder);
  function recordCopy(
    source: Buffer,
    sourceOffset: number,
    destination: Buffer,
    destinationOffset: number,
    bytes: number,
  ): void;
  function recordCopy(source: Buffer, destination: Buffer, bytes?: number): void;
  function recordCopy(
    source: Buffer,
    offsetOrDestination: number | Buffer,
    destinationOrBytes?: Buffer | number,
    destinationOffset?: number,
    bytes?: number,
  ) {
    if (typeof offsetOrDestination === 'number') {
      const destination = destinationOrBytes as Buffer;
      copies.push([source, destination]);
      copy(source, offsetOrDestination, destination, required(destinationOffset), required(bytes));
    } else {
      copies.push([source, offsetOrDestination]);
      copy(source, offsetOrDestination, destinationOrBytes as number | undefined);
    }
  }
  encoder.copyBufferToBuffer = recordCopy;
  return { vertices, indirect, copies, events };
}

function parent(
  f: Awaited<ReturnType<typeof fixture>>,
  initial: { plan: RenderFeaturePlannedFrame; execution: RenderFeaturePlanExecution },
) {
  const builder = new RenderGraphBuilder<Frame>(),
    owner = {},
    slots = new Map<string, { complete: boolean; names: Set<string> }>();
  const mesh = builder
    .importBuffer('scene-mesh', { size: 36, usage: 0x20 }, (frame) => frame.mesh)
    .unwrap();
  const color = builder.createTexture('color', { format: 'rgba8unorm', size: 'surface' }).unwrap();
  const view = builder.view(color).unwrap();
  builder
    .addRasterPass('scene', {
      accesses: [
        { resource: mesh, usage: 'vertex-read' },
        { resource: view, usage: 'color-attachment' },
      ],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      encode: ({ pass, resources }) => {
        pass.setPipeline(f.graphics);
        pass.setVertexBuffer(0, resources.buffer(mesh).unwrap());
        pass.draw(3);
      },
    })
    .unwrap();
  const state = createRenderFeatureProjectionState();
  const options = { state, resolveTarget: () => ({ texture: color, view }) };
  const context = {
    owner,
    device: f.device,
    surfaceSize: size,
    ports: [{ resource: view, usage: 'color-attachment' }] as GraphAccess[],
    slots,
  };
  const selected = selectTransientViewPlans(
    owner,
    [initial.plan],
    [initial.execution],
    true,
  ).identities;
  projectTransientViewPlans(builder, [initial.execution], selected, options, context).unwrap();
  // Repeated Standard contribution calls must preserve the one owning slot.
  projectTransientViewPlans(builder, [initial.execution], selected, options, context).unwrap();
  builder
    .addCopyPass('after', { accesses: [{ resource: view, usage: 'copy-src' }], encode: () => {} })
    .unwrap();
  return { owner, graph: builder.compile({ device: f.device, surfaceSize: size }).unwrap() };
}

describe('transient Standard view graph integration', () => {
  it.each([
    'ordinary-signature',
    'generation',
    'order',
    'scope',
    'scope-tag',
  ] as const)('retains the parent graph dependency on %s changes', async (field) => {
    const f = await fixture();
    try {
      const current = f.prepare(1, 0),
        owner = {};
      const { viewGraph: _isolated, ...base } = current.plan;
      const ordinary: RenderFeaturePlannedFrame = { ...base, featureIdentity: 'test.ordinary' };
      const ordinaryExecution = {
        ...current.execution,
        featureIdentity: ordinary.featureIdentity,
        passes: [],
      };
      const plans = [current.plan, ordinary],
        executions = [current.execution, ordinaryExecution];
      if (field === 'scope-tag') {
        plans[0] = { ...current.plan, scope: { view: 'frame' } };
        executions[0] = { ...current.execution, scope: 'view:frame' };
      }
      const before = selectTransientViewPlans(owner, plans, executions, true).topologySignature;
      if (field === 'ordinary-signature')
        plans[1] = { ...ordinary, signature: `${ordinary.signature}:changed` };
      if (field === 'generation')
        plans[0] = { ...current.plan, generation: current.plan.generation + 1 };
      if (field === 'scope' || field === 'scope-tag')
        plans[0] = { ...current.plan, scope: 'frame' };
      if (field === 'order')
        executions[0] = { ...current.execution, order: current.execution.order + 1 };
      expect(selectTransientViewPlans(owner, plans, executions, true).topologySignature).not.toBe(
        before,
      );
    } finally {
      await f.dispose();
    }
  });
  it('compiles one parent across empty, many, fewer and empty current Host executions', async () => {
    const f = await fixture(),
      initial = f.prepare(0, 0),
      p = parent(f, initial);
    const parentGeneration = p.graph.inspect().generation;
    const allMeshes: Buffer[] = [],
      particleBuffers: Buffer[] = [];
    let selectionSignature: string | undefined;
    const hostSignatures = new Set<string>();
    try {
      expect(p.graph.inspect().passes.map((pass) => pass.kind)).toEqual([
        'raster',
        'subgraph',
        'copy',
      ]);
      for (const [epoch, count] of [0, 3, 1, 0].entries()) {
        const current = epoch === 0 ? initial : f.prepare(count, epoch);
        const selection = selectTransientViewPlans(
          p.owner,
          [current.plan],
          [current.execution],
          true,
        );
        expect(selection.identities.has(identity)).toBe(true);
        selectionSignature ??= selection.topologySignature;
        expect(selection.topologySignature).toBe(selectionSignature);
        expect(
          selectTransientViewPlans(p.owner, [current.plan], [current.execution], false).identities
            .size,
        ).toBe(0);
        hostSignatures.add(current.plan.signature);
        const mesh = f.device.createBuffer({ size: 36, usage: 0x20 }).unwrap();
        allMeshes.push(mesh);
        const encoder = f.device.createCommandEncoder().unwrap(),
          seen = observe(encoder);
        p.graph
          .execute({ encoder, mesh, featureExecutions: [current.execution] }, (pass, encode) => {
            seen.events.push(pass.name);
            encode();
          })
          .unwrap();
        encoder.finish().unwrap();
        const expectedPasses = current.execution.passes.map((pass) => pass.name);
        expect(seen.events).toEqual([
          'scene',
          required(p.graph.inspect().passes[1]).name,
          ...expectedPasses,
          'after',
        ]);
        expect(seen.vertices[0]).toBe(mesh);
        const expectedVertices = current.execution.passes.flatMap((pass) =>
          (pass.graphics?.draws ?? []).map((draw) => {
            const resource = pass.resolvedGraphics?.resolve(required(draw.vertexData[0]).resource);
            if (resource?.kind !== 'vertex-data')
              throw new Error('Missing actual prepared vertex buffer');
            return resource.handle;
          }),
        );
        const expectedIndirect = current.execution.passes.flatMap((pass) =>
          (pass.graphics?.draws ?? []).map((draw) => {
            if (draw.kind !== 'draw-indirect') throw new Error('Expected an indirect draw');
            return required(pass.resolvedGraphics?.resolveGpuBuffer?.(draw.command.buffer)).buffer;
          }),
        );
        expect(seen.vertices.slice(1)).toEqual(expectedVertices);
        expect(seen.indirect).toEqual(expectedIndirect);
        expect(seen.copies).toEqual(
          current.execution.passes.flatMap((pass) =>
            (pass.resolvedGpuCopies ?? []).map((copy) => [
              copy.source.buffer,
              copy.destination.buffer,
            ]),
          ),
        );
        expect(expectedVertices).toHaveLength(count);
        particleBuffers.push(...expectedVertices);
        expect(p.graph.inspect().generation).toBe(parentGeneration);
      }
      expect(hostSignatures.size).toBeGreaterThan(1);
      expect(new Set(allMeshes).size).toBe(4);
      expect(new Set(particleBuffers).size).toBe(4);
      expect(inspectTransientViewGraphs(p.owner)).toMatchObject({
        childBuilds: 0,
        childCompiles: 0,
        commandFrames: 4,
        childFailures: 0,
      });
    } finally {
      await p.graph.retire();
      await f.dispose();
    }
  });

  it('stops the whole frame after a current child recording failure', async () => {
    const f = await fixture(),
      initial = f.prepare(0, 0),
      p = parent(f, initial);
    try {
      const current = f.prepare(1, 1),
        encoder = f.device.createCommandEncoder().unwrap(),
        seen = observe(encoder);
      const begin = encoder.beginComputePass.bind(encoder);
      encoder.beginComputePass = (descriptor) => {
        const pass = begin(descriptor);
        pass.dispatchWorkgroups = () => {
          throw new Error('actual Null child encoder failure');
        };
        return pass;
      };
      const result = p.graph.execute(
        {
          encoder,
          mesh: f.device.createBuffer({ size: 36, usage: 0x20 }).unwrap(),
          featureExecutions: [current.execution],
        },
        (pass, encode) => {
          seen.events.push(pass.name);
          encode();
        },
      );
      expect(result.ok).toBe(false);
      expect(seen.events).not.toContain('after');
      expect(seen.indirect).toEqual([]);
    } finally {
      await p.graph.retire();
      await f.dispose();
    }
  });

  it.each([
    'shadow',
    'depth-before-pass',
  ] as const)('keeps %s work on the ordinary projection path', async (kind) => {
    const f = await fixture();
    try {
      const current = f.prepare(1, 0),
        raster = required(current.execution.passes.find((pass) => pass.graphics !== undefined));
      const execution: RenderFeaturePlanExecution = {
        ...current.execution,
        passes: [
          kind === 'shadow'
            ? { ...raster, shadowCaster: true }
            : { ...raster, graphics: { ...required(raster.graphics), sceneDepth: 'before-pass' } },
        ],
      };
      expect(transientViewExecutionEligible(execution)).toBe(false);
      const plans: readonly RenderFeaturePlannedFrame[] = [current.plan];
      expect(selectTransientViewPlans({}, plans, [execution], true).identities.size).toBe(0);
    } finally {
      await f.dispose();
    }
  });
  it.each([
    'clear',
    'discard',
  ] as const)('keeps depth %s on the ordinary graph path', async (operation) => {
    const f = await fixture();
    try {
      const current = f.prepare(1, 0);
      const raster = required(current.execution.passes.find((pass) => pass.graphics !== undefined));
      const graphics = required(raster.graphics);
      const execution: RenderFeaturePlanExecution = {
        ...current.execution,
        passes: [
          {
            ...raster,
            graphics: {
              ...graphics,
              attachments: {
                ...graphics.attachments,
                depthStencil: {
                  resource: 'depth',
                  format: 'depth24plus',
                  depthLoadOp: operation === 'clear' ? 'clear' : 'load',
                  depthStoreOp: operation === 'discard' ? 'discard' : 'store',
                },
              },
            },
          },
        ],
      };
      expect(transientViewExecutionEligible(execution)).toBe(false);
      expect(selectTransientViewPlans({}, [current.plan], [execution], true).identities.size).toBe(
        0,
      );
    } finally {
      await f.dispose();
    }
  });
});

it.each([
  [false, 'raster'],
  [true, 'raster'],
  [false, 'compute'],
  [true, 'compute'],
] as const)('preserves the recording error owner commands=%s stage=%s', async (commands, stage) => {
  const f = await fixture();
  let graph: ReturnType<typeof parent>['graph'] | undefined;
  try {
    const current = f.prepare(1, 0),
      builder = new RenderGraphBuilder<Frame>(),
      errors: unknown[] = [];
    const color = builder
        .createTexture('review-color', { format: 'rgba8unorm', size: 'surface' })
        .unwrap(),
      view = builder.view(color).unwrap();
    builder
      .addRasterPass('scene', {
        accesses: [{ resource: view, usage: 'color-attachment' }],
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
        encode: () => {},
      })
      .unwrap();
    projectTransientViewPlans(
      builder,
      [current.execution],
      new Set(commands ? [identity] : []),
      {
        resolveTarget: () => ({ texture: color, view }),
        reportError: (error) => errors.push(error),
      },
      {
        owner: {},
        device: f.device,
        surfaceSize: size,
        ports: [{ resource: view, usage: 'color-attachment' }],
        slots: new Map(),
      },
    ).unwrap();
    graph = builder.compile({ device: f.device, surfaceSize: size }).unwrap();
    const encoder = f.device.createCommandEncoder().unwrap(),
      begin = encoder.beginRenderPass.bind(encoder);
    if (stage === 'raster')
      encoder.beginRenderPass = (descriptor) => {
        const pass = begin(descriptor);
        pass.setPipeline = () => {
          throw Error('review-backend-failure');
        };
        return pass;
      };
    else {
      const begin = encoder.beginComputePass.bind(encoder);
      encoder.beginComputePass = (descriptor) => {
        const pass = begin(descriptor);
        pass.setPipeline = () => {
          throw Error('review-backend-failure');
        };
        return pass;
      };
    }
    const frame: Frame = {
      encoder,
      mesh: f.device.createBuffer({ size: 36, usage: 0x20 }).unwrap(),
      featureExecutions: [current.execution],
    };
    expect(graph.execute(frame).ok).toBe(false);
    expect(errors).toHaveLength(1);
  } finally {
    await graph?.retire();
    await f.dispose();
  }
});

it.each([false, true])('review named pass filter survives commands=%s', async (commands) => {
  const f = await fixture();
  let graph: ReturnType<typeof parent>['graph'] | undefined;
  try {
    const current = f.prepare(1, 0),
      builder = new RenderGraphBuilder<Frame>();
    const color = builder
        .createTexture('review-color', { format: 'rgba8unorm', size: 'surface' })
        .unwrap(),
      view = builder.view(color).unwrap();
    builder
      .addRasterPass('scene', {
        accesses: [{ resource: view, usage: 'color-attachment' }],
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
        encode: () => {},
      })
      .unwrap();
    const raster = required(current.execution.passes.find((pass) => pass.graphics !== undefined));
    projectTransientViewPlans(
      builder,
      [current.execution],
      new Set(commands ? [identity] : []),
      { resolveTarget: () => ({ texture: color, view }), passNames: new Set([raster.name]) },
      {
        owner: {},
        device: f.device,
        surfaceSize: size,
        ports: [{ resource: view, usage: 'color-attachment' }],
        slots: new Map(),
      },
    ).unwrap();
    graph = builder.compile({ device: f.device, surfaceSize: size }).unwrap();
    const names: string[] = [];
    const frame: Frame = {
      encoder: f.device.createCommandEncoder().unwrap(),
      mesh: f.device.createBuffer({ size: 36, usage: 0x20 }).unwrap(),
      featureExecutions: [current.execution],
    };
    expect(
      graph.execute(frame, (pass, encode) => {
        names.push(pass.name);
        encode();
      }).ok,
    ).toBe(true);
    expect(names.filter((name) => name !== 'scene' && !name.startsWith('feature-view:'))).toEqual([
      raster.name,
    ]);
  } finally {
    await graph?.retire();
    await f.dispose();
  }
});

it('review filtered dynamic work either restores ordinary invalidation or follows current passes on retained graph', async () => {
  const f = await fixture();
  let graph: ReturnType<typeof parent>['graph'] | undefined;
  const stable = (execution: RenderFeaturePlanExecution): RenderFeaturePlanExecution => {
    let index = 0;
    return {
      ...execution,
      passes: execution.passes.map((pass) =>
        pass.graphics ? { ...pass, name: `stage-raster-${index++}` } : pass,
      ),
    };
  };
  try {
    const initial = f.prepare(1, 0),
      first = stable(initial.execution),
      owner = {};
    const selection = selectTransientViewPlans(owner, [initial.plan], [first], true);
    const builder = new RenderGraphBuilder<Frame>(),
      color = builder
        .createTexture('filtered-color', { format: 'rgba8unorm', size: 'surface' })
        .unwrap(),
      view = builder.view(color).unwrap();
    builder
      .addRasterPass('scene', {
        accesses: [{ resource: view, usage: 'color-attachment' }],
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
        encode: () => {},
      })
      .unwrap();
    projectTransientViewPlans(
      builder,
      [first],
      selection.identities,
      {
        resolveTarget: () => ({ texture: color, view }),
        passNames: new Set(['stage-raster-0', 'stage-raster-1']),
      },
      {
        owner,
        device: f.device,
        surfaceSize: size,
        ports: [{ resource: view, usage: 'color-attachment' }],
        slots: new Map(),
      },
    ).unwrap();
    graph = builder.compile({ device: f.device, surfaceSize: size }).unwrap();
    const current = f.prepare(2, 1),
      execution = stable(current.execution),
      next = selectTransientViewPlans(owner, [current.plan], [execution], true);
    if (selection.identities.size === 0) {
      expect(next.topologySignature).toBeUndefined();
      expect(current.plan.signature).not.toBe(initial.plan.signature);
      return;
    }
    expect(next.topologySignature).toBe(selection.topologySignature);
    const names: string[] = [],
      frame: Frame = {
        encoder: f.device.createCommandEncoder().unwrap(),
        mesh: f.device.createBuffer({ size: 36, usage: 0x20 }).unwrap(),
        featureExecutions: [execution],
      };
    expect(
      graph.execute(frame, (pass, encode) => {
        names.push(pass.name);
        encode();
      }).ok,
    ).toBe(true);
    expect(names.filter((name) => name !== 'scene' && !name.startsWith('feature-view:'))).toEqual([
      'stage-raster-0',
      'stage-raster-1',
    ]);
  } finally {
    await graph?.retire();
    await f.dispose();
  }
});

it.each([
  false,
  true,
])('review compute grouping stops at an excluded copy/compute commands=%s', async (commands) => {
  const f = await fixture();
  let graph: ReturnType<typeof parent>['graph'] | undefined;
  try {
    const current = f.prepare(2, 0),
      work = current.execution.passes;
    const execution = {
      ...current.execution,
      passes: [work[0], work[1], work[3], work[4], work[2], work[5]],
    };
    const selected = required(work[1]),
      builder = new RenderGraphBuilder<Frame>(),
      color = builder
        .createTexture('compute-filter-color', { format: 'rgba8unorm', size: 'surface' })
        .unwrap(),
      view = builder.view(color).unwrap();
    builder
      .addRasterPass('scene', {
        accesses: [{ resource: view, usage: 'color-attachment' }],
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
        encode: () => {},
      })
      .unwrap();
    projectTransientViewPlans(
      builder,
      [execution],
      new Set(commands ? [identity] : []),
      { resolveTarget: () => ({ texture: color, view }), passNames: new Set([selected.name]) },
      {
        owner: {},
        device: f.device,
        surfaceSize: size,
        ports: [{ resource: view, usage: 'color-attachment' }],
        slots: new Map(),
      },
    ).unwrap();
    graph = builder.compile({ device: f.device, surfaceSize: size }).unwrap();
    const names: string[] = [],
      encoder = f.device.createCommandEncoder().unwrap(),
      begin = encoder.beginComputePass.bind(encoder);
    let dispatches = 0;
    encoder.beginComputePass = (descriptor) => {
      const pass = begin(descriptor),
        dispatch = pass.dispatchWorkgroups.bind(pass);
      pass.dispatchWorkgroups = (...args) => {
        dispatches++;
        dispatch(...args);
      };
      return pass;
    };
    const frame: Frame = {
      encoder,
      mesh: f.device.createBuffer({ size: 36, usage: 0x20 }).unwrap(),
      featureExecutions: [execution],
    };
    expect(
      graph.execute(frame, (pass, encode) => {
        names.push(pass.name);
        encode();
      }).ok,
    ).toBe(true);
    expect(names.filter((name) => name !== 'scene' && !name.startsWith('feature-view:'))).toEqual([
      selected.name,
    ]);
    expect(dispatches).toBe(1);
  } finally {
    await graph?.retire();
    await f.dispose();
  }
});

it('does not isolate a feature when another requested view needs the ordinary graph', async () => {
  const f = await fixture();
  try {
    const current = f.prepare(1, 0);
    const raster = required(current.execution.passes.find((pass) => pass.graphics !== undefined));
    const other: RenderFeaturePlanExecution = {
      ...current.execution,
      scope: 'view:other',
      passes: [
        {
          ...raster,
          graphics: { ...required(raster.graphics), sceneDepth: 'before-pass' },
        },
      ],
    };
    const selection = selectTransientViewPlans(
      {},
      [current.plan, { ...current.plan, scope: { view: 'other' } }],
      [current.execution, other],
      true,
    );
    expect(selection.identities.size).toBe(0);
    expect(selection.topologySignature).toBeUndefined();
  } finally {
    await f.dispose();
  }
});
