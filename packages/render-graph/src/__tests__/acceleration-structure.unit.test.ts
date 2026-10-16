import type { RhiCommandEncoder, RhiDevice, Tlas } from '@forgeax/engine-rhi';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { RenderGraphBuilder } from '../builder.js';

const LIMITS = {
  maxBlasGeometryCount: 4,
  maxBlasPrimitiveCount: 1024,
  maxTlasInstanceCount: 16,
  maxAccelerationStructuresPerShaderStage: 1,
};

async function device(rayQuery: boolean): Promise<RhiDevice> {
  const adapter = new RhiNullAdapter(rayQuery ? { rayQuery: LIMITS } : {});
  return (await adapter.requestDevice()).unwrap();
}

interface Frame {
  readonly encoder: RhiCommandEncoder;
  readonly tlas: Tlas;
}

function traceGraph(): {
  readonly graph: RenderGraphBuilder<Frame>;
  readonly built: Tlas[];
  readonly traced: Tlas[];
} {
  const graph = new RenderGraphBuilder<Frame>();
  const built: Tlas[] = [];
  const traced: Tlas[] = [];
  const tlas = graph
    .importAccelerationStructure('scene.tlas', { maxInstances: 4 }, (frame) => frame.tlas)
    .unwrap();
  const output = graph.createBuffer('radiance', { size: 16 }).unwrap();
  graph
    .addComputePass('trace', {
      accesses: [
        { resource: tlas, usage: 'acceleration-structure-read' },
        { resource: output, usage: 'storage-write' },
      ],
      encode: ({ resources }) => {
        traced.push(resources.accelerationStructure(tlas).unwrap());
      },
    })
    .unwrap();
  // Declared after its reader on purpose: the build must still be a prior write
  // for a reader declared later, and a reader declared earlier must not see it.
  graph
    .addCopyPass('build', {
      accesses: [{ resource: tlas, usage: 'acceleration-structure-build' }],
      encode: ({ resources }) => {
        built.push(resources.accelerationStructure(tlas).unwrap());
      },
    })
    .unwrap();
  graph
    .addComputePass('trace-again', {
      accesses: [
        { resource: tlas, usage: 'acceleration-structure-read' },
        { resource: output, usage: 'storage-read-write' },
      ],
      encode: ({ resources }) => {
        traced.push(resources.accelerationStructure(tlas).unwrap());
      },
    })
    .unwrap();
  return { graph, built, traced };
}

describe('render graph acceleration structures', () => {
  it('orders readers after the build write and resolves the imported TLAS per frame', async () => {
    const rhi = await device(true);
    const { graph, built, traced } = traceGraph();
    const compiled = graph.compile({ device: rhi, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const info = compiled.inspect();
    expect(info.passes).toMatchObject([
      { name: 'trace', dependencies: [] },
      { name: 'build', dependencies: ['trace'] },
      { name: 'trace-again', dependencies: ['trace', 'build'] },
    ]);
    expect(info.resources.find((resource) => resource.label === 'scene.tlas')).toMatchObject({
      kind: 'acceleration-structure',
      origin: 'imported',
      descriptor: { kind: 'acceleration-structure', maxInstances: 4 },
      derivedUsage: 0,
      byteSizeUnknownReason: 'imported-owner',
    });
    const tlas = rhi.createTlas({ maxInstances: 4 }).unwrap();
    const encoder = rhi.createCommandEncoder({}).unwrap();
    expect(compiled.execute({ encoder, tlas }).ok).toBe(true);
    expect(built).toEqual([tlas]);
    expect(traced).toEqual([tlas, tlas]);
    expect((await compiled.retire()).ok).toBe(true);
  });

  it('reports ray-query capability absence as data before allocation', async () => {
    const rhi = await device(false);
    const { graph } = traceGraph();
    const compiled = graph.compile({ device: rhi, surfaceSize: { width: 1, height: 1 } });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.error.code).toBe('capability-missing');
    expect(compiled.error.detail).toMatchObject({
      passName: 'trace',
      capability: 'ray-query',
      resourceLabel: 'scene.tlas',
      usage: 'acceleration-structure-read',
    });
  });

  it('accepts builds only in copy passes', async () => {
    const rhi = await device(true);
    const graph = new RenderGraphBuilder<Frame>();
    const tlas = graph
      .importAccelerationStructure('scene.tlas', { maxInstances: 1 }, (frame) => frame.tlas)
      .unwrap();
    graph
      .addComputePass('build-in-compute', {
        accesses: [{ resource: tlas, usage: 'acceleration-structure-build' }],
        encode: () => undefined,
      })
      .unwrap();
    const compiled = graph.compile({ device: rhi, surfaceSize: { width: 1, height: 1 } });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.error.code).toBe('access-conflict');
    expect(compiled.error.detail).toMatchObject({
      passName: 'build-in-compute',
      usage: 'acceleration-structure-build',
    });
  });

  it('rejects resolving the TLAS from a pass that did not declare it', async () => {
    const rhi = await device(true);
    const graph = new RenderGraphBuilder<Frame>();
    const tlas = graph
      .importAccelerationStructure('scene.tlas', { maxInstances: 1 }, (frame) => frame.tlas)
      .unwrap();
    const data = graph.createBuffer('data', { size: 16 }).unwrap();
    let code: string | undefined;
    graph
      .addCopyPass('build', {
        accesses: [{ resource: tlas, usage: 'acceleration-structure-build' }],
        encode: () => undefined,
      })
      .unwrap();
    graph
      .addComputePass('undeclared', {
        accesses: [{ resource: data, usage: 'storage-write' }],
        encode: ({ resources }) => {
          const resolved = resources.accelerationStructure(tlas);
          code = resolved.ok ? undefined : resolved.error.code;
        },
      })
      .unwrap();
    const compiled = graph.compile({ device: rhi, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const encoder = rhi.createCommandEncoder({}).unwrap();
    const frame = { encoder, tlas: rhi.createTlas({ maxInstances: 1 }).unwrap() };
    expect(compiled.execute(frame).ok).toBe(true);
    expect(code).toBe('resource-not-declared-by-pass');
  });
});
