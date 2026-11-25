import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { assert, describe, expect, it } from 'vitest';
import type { RenderInspection } from '../../render-contract.js';
import { inspectWaterRenderCapabilities, inspectWaterRenderGraph } from '../capabilities.js';

describe('Water graph capability facts', () => {
  it.each([
    ['update-depth', 'advancedShallow'],
    ['radix', 'oceanFft'],
  ] as const)('follows shared %s production through publication into the water material', async (kernel, field) => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const shared = new RenderGraphBuilder();
    const state = shared
      .createTexture('water-advanced-state', { format: 'rgba32float', size: 'surface' })
      .unwrap();
    const published = shared
      .createTexture('water-advanced-material', { format: 'rgba32float', size: 'surface' })
      .unwrap();
    shared
      .addComputePass(`water-advanced-${kernel}`, {
        accesses: [{ resource: shared.view(state).unwrap(), usage: 'storage-write' }],
        encode() {},
      })
      .unwrap();
    shared
      .addComputePass('water-advanced-publish', {
        accesses: [
          { resource: shared.view(state).unwrap(), usage: 'sampled-read' },
          { resource: shared.view(published).unwrap(), usage: 'storage-write' },
        ],
        encode() {},
      })
      .unwrap();
    const producer = shared.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
    const publishedTexture = producer.getColorTargetTexture('water-advanced-material');
    assert(publishedTexture);
    const main = new RenderGraphBuilder();
    let failImport = false;
    const imported = main
      .importTexture(
        'shared:water-advanced-material',
        { format: 'rgba32float', size: 'surface', usage: 4 },
        () => {
          if (failImport) throw new Error('owned import failure');
          return publishedTexture;
        },
      )
      .unwrap();
    const output = main
      .createTexture('water-slw-optics-hdr', { format: 'rgba16float', size: 'surface' })
      .unwrap();
    const outputView = main.view(output).unwrap();
    main
      .addRasterPass('water-slw-inner-color', {
        accesses: [
          { resource: main.view(imported).unwrap(), usage: 'sampled-read' },
          { resource: outputView, usage: 'color-attachment' },
        ],
        colorAttachments: [
          { view: outputView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
        encode() {},
      })
      .unwrap();
    const consumer = main.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
    const unexecuted = inspectWaterRenderGraph(consumer.inspect(), {
      frameId: 7,
      deviceGeneration: 1,
      graph: producer.inspect(),
    });
    consumer.execute({ encoder: device.createCommandEncoder().unwrap() }).unwrap();
    const graph = inspectWaterRenderGraph(consumer.inspect(), {
      frameId: 7,
      deviceGeneration: 1,
      graph: producer.inspect(),
    });
    const inspect = (waterGraph = graph) =>
      inspectWaterRenderCapabilities({
        state: 'alive',
        frame: { frameId: 7, deviceGeneration: 1 },
        features: [],
        waterGraph,
        reflectionProbes: { reflectionFallback: { source: 'none', state: 'inactive' } },
      } as unknown as RenderInspection)[field];
    expect(inspect()).toBe(true);
    expect(inspect(unexecuted)).toBe(false);
    if (!graph?.shared) throw new Error('Expected inspected shared graph');
    const importedAllocation = graph.resources.find(
      (resource) => resource.label === 'shared:water-advanced-material',
    )?.physicalAllocationKey;
    expect(importedAllocation).toBeDefined();
    expect(
      inspect({
        ...graph,
        resources: graph.resources.map((resource) =>
          resource.label === 'shared:water-advanced-material'
            ? { ...resource, physicalAllocationKey: `${importedAllocation}:unrelated` }
            : resource,
        ),
      }),
    ).toBe(false);
    expect(inspect({ ...graph, shared: { ...graph.shared, frameId: 6 } })).toBe(false);
    expect(inspect({ ...graph, shared: { ...graph.shared, deviceGeneration: 0 } })).toBe(false);
    expect(
      inspect({
        ...graph,
        passes: graph.passes.map((pass) => ({
          ...pass,
          accesses: pass.accesses.filter((access) => access.usage !== 'sampled-read'),
        })),
      }),
    ).toBe(false);
    expect(
      inspect({
        ...graph,
        resources: graph.resources.map((resource) => ({
          ...resource,
          descriptor:
            resource.descriptor.kind === 'texture'
              ? { ...resource.descriptor, width: 32 }
              : resource.descriptor,
        })),
      }),
    ).toBe(false);
    expect(
      inspect({
        ...graph,
        shared: {
          ...graph.shared,
          graph: {
            ...graph.shared.graph,
            passes: graph.shared.graph.passes.map((pass) => ({ ...pass, dependencies: [] })),
          },
        },
      }),
    ).toBe(false);
    failImport = true;
    expect(consumer.execute({ encoder: device.createCommandEncoder().unwrap() }).ok).toBe(false);
    expect(
      inspect(
        inspectWaterRenderGraph(consumer.inspect(), {
          frameId: 7,
          deviceGeneration: 1,
          graph: producer.inspect(),
        }),
      ),
    ).toBe(false);
    (await consumer.retire()).unwrap();
    (await producer.retire()).unwrap();
  });

  it.each([
    ['update-depth', 'advancedShallow'],
    ['radix', 'oceanFft'],
  ] as const)('follows local %s publication into its Water material consumer', async (kernel, field) => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const graph = new RenderGraphBuilder();
    const state = graph
      .createTexture('water-advanced-state', { format: 'rgba32float', size: 'surface' })
      .unwrap();
    const published = graph
      .createTexture('water-advanced-material', { format: 'rgba32float', size: 'surface' })
      .unwrap();
    graph
      .addComputePass(`water-advanced-${kernel}`, {
        accesses: [{ resource: graph.view(state).unwrap(), usage: 'storage-write' }],
        encode() {},
      })
      .unwrap();
    graph
      .addComputePass('water-advanced-publish', {
        accesses: [
          { resource: graph.view(state).unwrap(), usage: 'sampled-read' },
          { resource: graph.view(published).unwrap(), usage: 'storage-write' },
        ],
        encode() {},
      })
      .unwrap();
    const output = graph
      .createTexture('water-slw-optics-hdr', { format: 'rgba16float', size: 'surface' })
      .unwrap();
    const outputView = graph.view(output).unwrap();
    graph
      .addRasterPass('water-slw-inner-color', {
        accesses: [
          { resource: graph.view(published).unwrap(), usage: 'sampled-read' },
          { resource: outputView, usage: 'color-attachment' },
        ],
        colorAttachments: [
          { view: outputView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
        encode() {},
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
    const inspect = (waterGraph = inspectWaterRenderGraph(compiled.inspect())) =>
      inspectWaterRenderCapabilities({
        state: 'alive',
        frame: { frameId: 7, deviceGeneration: 1 },
        features: [],
        waterGraph,
        reflectionProbes: { reflectionFallback: { source: 'none', state: 'inactive' } },
      } as unknown as RenderInspection)[field];
    expect(inspect()).toBe(true);
    const inspected = inspectWaterRenderGraph(compiled.inspect());
    assert(inspected);
    expect(
      inspect({
        ...inspected,
        passes: inspected.passes.map((pass) => ({ ...pass, dependencies: [] })),
      }),
    ).toBe(false);
    (await compiled.retire()).unwrap();
  });

  it('requires the current shared raster fluid-field export and an actual view consumer', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const shared = new RenderGraphBuilder();
    const fields = shared
      .createTexture('water-fluid-material-fields', { format: 'rgba32float', size: 'surface' })
      .unwrap();
    const fieldView = shared.view(fields).unwrap();
    shared
      .addRasterPass('water-fluid-atlas0-field0', {
        accesses: [{ resource: fieldView, usage: 'color-attachment' }],
        colorAttachments: [
          { view: fieldView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
        encode() {},
      })
      .unwrap();
    const producer = shared.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
    const publishedTexture = producer.getColorTargetTexture('water-fluid-material-fields');
    assert(publishedTexture);
    const main = new RenderGraphBuilder();
    const imported = main
      .importTexture(
        'shared:water-fluid-material-fields',
        { format: 'rgba32float', size: 'surface', usage: 4 },
        () => publishedTexture,
      )
      .unwrap();
    const output = main
      .createTexture('water-slw-optics-hdr', { format: 'rgba16float', size: 'surface' })
      .unwrap();
    const outputView = main.view(output).unwrap();
    main
      .addRasterPass('water-slw-inner-color', {
        accesses: [
          { resource: main.view(imported).unwrap(), usage: 'sampled-read' },
          { resource: outputView, usage: 'color-attachment' },
        ],
        colorAttachments: [
          { view: outputView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
        encode() {},
      })
      .unwrap();
    const consumer = main.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
    consumer.execute({ encoder: device.createCommandEncoder().unwrap() }).unwrap();
    const inspect = (frameId = 7, deviceGeneration = 1) =>
      inspectWaterRenderCapabilities({
        state: 'alive',
        frame: { frameId: 7, deviceGeneration: 1 },
        features: ['water-fluid-simulation'],
        waterGraph: inspectWaterRenderGraph(consumer.inspect(), {
          frameId,
          deviceGeneration,
          graph: producer.inspect(),
        }),
        reflectionProbes: { reflectionFallback: { source: 'none', state: 'inactive' } },
      } as unknown as RenderInspection);
    expect(inspect().fluidSimulation).toBe(true);
    expect(inspect(6).fluidSimulation).toBe(false);
    expect(inspect(7, 0).fluidSimulation).toBe(false);
    expect(inspect().riverBake).toBe('unavailable');
    (await consumer.retire()).unwrap();
    (await producer.retire()).unwrap();
  });
  it('distinguishes retained WaterInfo from production by this submitted frame', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const shared = new RenderGraphBuilder();
    const target = shared
      .createTexture('water-info-target', { format: 'rgba16float', size: 'surface' })
      .unwrap();
    shared
      .addComputePass('water-info-finalize-target', {
        accesses: [{ resource: shared.view(target).unwrap(), usage: 'storage-write' }],
        encode() {},
      })
      .unwrap();
    const producer = shared.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
    const main = new RenderGraphBuilder();
    const imported = main
      .importTexture(
        'shared:water-info-target',
        { format: 'rgba16float', size: 'surface', usage: 0x04 },
        () => {
          throw new Error('inspection only');
        },
      )
      .unwrap();
    const output = main
      .createTexture('water-underwater-output', { format: 'rgba16float', size: 'surface' })
      .unwrap();
    const outputView = main.view(output).unwrap();
    main
      .addRasterPass('underwater-scene-copy', {
        accesses: [
          { resource: main.view(imported).unwrap(), usage: 'sampled-read' },
          { resource: outputView, usage: 'color-attachment' },
        ],
        colorAttachments: [
          { view: outputView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
        encode() {},
      })
      .unwrap();
    const composed = main
      .createTexture('water-underwater-composed', { format: 'rgba16float', size: 'surface' })
      .unwrap();
    const composedView = main.view(composed).unwrap();
    main
      .addRasterPass('underwater-cooked-post-process', {
        accesses: [
          { resource: outputView, usage: 'sampled-read' },
          { resource: composedView, usage: 'color-attachment' },
        ],
        colorAttachments: [
          { view: composedView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
        encode() {},
      })
      .unwrap();
    const consumer = main.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
    const inspect = (sharedFrame: number, sharedDevice = 1) =>
      inspectWaterRenderCapabilities({
        state: 'alive',
        frame: { frameId: 7, deviceGeneration: 1 },
        features: ['water-info-producer', 'water-underwater-post-process'],
        waterGraph: inspectWaterRenderGraph(consumer.inspect(), {
          frameId: sharedFrame,
          deviceGeneration: sharedDevice,
          graph: producer.inspect(),
        }),
        reflectionProbes: { reflectionFallback: { source: 'none', state: 'inactive' } },
      } as unknown as RenderInspection);
    expect(inspect(6).waterInfo).toEqual({ available: true, active: true, execution: 'retained' });
    expect(inspect(7, 0).waterInfo).toEqual({
      available: true,
      active: true,
      execution: 'retained',
    });
    expect(inspect(7).waterInfo).toEqual({ available: true, active: true, execution: 'produced' });
    expect(inspect(7).underwater).toEqual({ available: true, active: true, execution: 'executed' });
    expect(inspect(7).cpuMesh).toBe('unavailable');
    (await consumer.retire()).unwrap();
    (await producer.retire()).unwrap();
  });

  it('rejects registered features and named passes without resource production and consumption', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const builder = new RenderGraphBuilder();
    for (const name of [
      'water-no-water-color-copy',
      'water-depth-prepass',
      'water-slw-inner-color',
      'water-ssr-trace',
      'water-ssr-temporal',
      'water-reflection-composite',
      'water-info-finalize',
      'water-underwater',
    ]) {
      builder.addComputePass(name, { accesses: [], encode() {} }).unwrap();
    }
    const compiled = builder.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
    const facts = inspectWaterRenderCapabilities({
      state: 'alive',
      frame: { frameId: 1, deviceGeneration: 1 },
      features: [
        'water-info-producer',
        'water-gpu-mesh',
        'water-fluid-simulation',
        'water-underwater-post-process',
      ],
      waterGraph: inspectWaterRenderGraph(compiled.inspect()),
      reflectionProbes: { reflectionFallback: { source: 'skylight', state: 'active' } },
    } as unknown as RenderInspection);
    expect(facts).toMatchObject({
      noWaterSceneCopy: false,
      singleLayerOptics: false,
      waterSurfaceDepthNormalVelocity: false,
      waterSurfaceSsr: false,
      captureSky: false,
      waterInfo: { available: true, active: false, execution: 'inactive' },
      gpuMesh: false,
      fluidSimulation: false,
      underwater: { available: true, active: false, execution: 'inactive' },
      deferredLighting: false,
    });
    (await compiled.retire()).unwrap();
  });
});
