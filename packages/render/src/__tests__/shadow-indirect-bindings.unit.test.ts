import type { BindGroup, Buffer, RenderPipeline, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { GpuDrawSelection } from '../gpu-driven/draw-selection';
import {
  encodeDirectionalShadowPass,
  encodeStaticShadowPass,
  type GpuDrivenShadowBatch,
  type GpuDrivenShadowSubmission,
  recordGpuDrivenShadowIndirect,
} from '../record/shadow-pass';
import { ShadowRasterLedger } from '../record/shadow-raster-ledger';
import { replayShadowBundles } from './shadow-bundle.fixture';
import { preparedShadowFixture } from './shadow-indirect.fixture';

function batch(): GpuDrivenShadowBatch {
  return {
    indirectOffset: 0,
    pipeline: {} as RenderPipeline,
    vertexBuffer: {} as Buffer,
    materialGroup: {} as BindGroup,
    meshBindGroup: {} as BindGroup,
    visibleBindGroups: [{} as BindGroup],
    deformation: 'rigid',
  };
}

function submission(rows: readonly GpuDrivenShadowBatch[]): GpuDrivenShadowSubmission {
  return {
    view: { indirectBuffer: {} as Buffer, skinTaskBinding: () => ({ auxiliaryOffset: 768 }) },
    batches: rows.map((row, index) => ({ ...row, indirectOffset: index * 40 })),
  } as unknown as GpuDrivenShadowSubmission;
}

function recorder() {
  const groups = new Map<number, { group: BindGroup; offsets: readonly number[] }>();
  let pipeline: RenderPipeline | undefined;
  let vertex: Buffer | undefined;
  const draws: Array<{
    offset: number;
    pipeline: RenderPipeline | undefined;
    vertex: Buffer | undefined;
    material: BindGroup | undefined;
    mesh: BindGroup | undefined;
    meshOffsets: readonly number[] | undefined;
    visible: BindGroup | undefined;
  }> = [];
  const bind = vi.fn((index: number, group: BindGroup, offsets: readonly number[] = []) => {
    groups.set(index, { group, offsets: [...offsets] });
  });
  const draw = (_buffer: Buffer, offset: number) =>
    draws.push({
      offset,
      pipeline,
      vertex,
      material: groups.get(1)?.group,
      mesh: groups.get(2)?.group,
      meshOffsets: groups.get(2)?.offsets,
      visible: groups.get(3)?.group,
    });
  const pass = {
    executeBundles: vi.fn((bundles) => replayShadowBundles(pass, bundles)),
    setPipeline: vi.fn((value: RenderPipeline) => {
      pipeline = value;
    }),
    setScissorRect: vi.fn(),
    draw: vi.fn(),
    setVertexBuffer: vi.fn((_slot: number, value: Buffer) => {
      vertex = value;
    }),
    setIndexBuffer: vi.fn(),
    setBindGroup: bind,
    drawIndirect: vi.fn(draw),
    drawIndexedIndirect: vi.fn(draw),
  } as unknown as RhiRenderPassEncoder;
  return { pass, bind, draws };
}

function expectDraws(recorded: ReturnType<typeof recorder>, rows: readonly GpuDrivenShadowBatch[]) {
  let cursor = 0;
  for (const [batchId, row] of rows.entries()) {
    for (const [level, visible] of row.visibleBindGroups.entries()) {
      const draw = recorded.draws[cursor++];
      expect(draw?.offset).toBe(batchId * 40 + level * 20);
      expect(draw?.pipeline).toBe(row.pipeline);
      expect(draw?.vertex).toBe(row.vertexBuffer);
      expect(draw?.material).toBe(row.materialGroup);
      expect(draw?.mesh).toBe(row.meshBindGroup);
      expect(draw?.visible).toBe(visible);
      expect(draw?.meshOffsets).toEqual(row.deformation === 'skin' ? [0, 768] : [0]);
    }
  }
  expect(recorded.draws).toHaveLength(cursor);
}

describe('GPU shadow indirect binding state', () => {
  it('records prepared offsets directly without a second batch roster', () => {
    const first = batch();
    const rows = [240, 0, 100].map((indirectOffset) => ({ ...first, indirectOffset }));
    const recorded = recorder();
    recordGpuDrivenShadowIndirect(recorded.pass, {
      view: { indirectBuffer: {} as Buffer, skinTaskBinding: () => ({ auxiliaryOffset: 768 }) },
      batches: rows,
    } as unknown as GpuDrivenShadowSubmission);
    expect(recorded.draws.map(({ offset }) => offset)).toEqual([240, 0, 100]);
    expect(recorded.draws.every(({ material }) => material === first.materialGroup)).toBe(true);
  });

  it('binds shared material and mesh once while retaining every LOD draw', () => {
    const shared = batch();
    const rows = Array.from({ length: 64 }, () => ({
      ...shared,
      visibleBindGroups: [{} as BindGroup, {} as BindGroup],
    }));
    const input = submission(rows);
    const recorded = recorder();
    recordGpuDrivenShadowIndirect(recorded.pass, input);
    expect(recorded.bind.mock.calls.filter(([index]) => index === 1)).toHaveLength(1);
    expect(recorded.bind.mock.calls.filter(([index]) => index === 2)).toHaveLength(1);
    expectDraws(recorded, rows);
    // Each invocation starts from unknown pass state, including the next cascade.
    recordGpuDrivenShadowIndirect(recorded.pass, input);
    expect(recorded.bind.mock.calls.filter(([index]) => index === 1)).toHaveLength(2);
    expect(recorded.bind.mock.calls.filter(([index]) => index === 2)).toHaveLength(2);
    expect(recorded.draws).toHaveLength(256);
  });

  it('rebinds one physical index buffer when its decoding format changes', () => {
    const shared = { ...batch(), indexBuffer: {} as Buffer };
    const formats = ['uint16', 'uint16', 'uint32', 'uint32', 'uint16'] as const;
    const rows = formats.map((indexFormat) => ({ ...shared, indexFormat }));
    const recorded = recorder();
    recordGpuDrivenShadowIndirect(recorded.pass, submission(rows));
    expect(vi.mocked(recorded.pass.setIndexBuffer).mock.calls).toEqual([
      [shared.indexBuffer, 'uint16'],
      [shared.indexBuffer, 'uint32'],
      [shared.indexBuffer, 'uint16'],
    ]);
    expect(recorded.pass.drawIndexedIndirect).toHaveBeenCalledTimes(formats.length);
    expectDraws(recorded, rows);
  });

  it('keeps the setter format observation and propagates a failed format transition', () => {
    const shared = { ...batch(), indexBuffer: {} as Buffer };
    let reads = 0;
    const first = {
      ...shared,
      get indexFormat(): 'uint16' | 'uint32' {
        reads += 1;
        return reads === 1 ? 'uint16' : 'uint32';
      },
    };
    const recorded = recorder();
    const raw = {
      ...submission([]),
      batches: [first, { ...shared, indexFormat: 'uint32' as const }],
    };
    recordGpuDrivenShadowIndirect(recorded.pass, raw);
    expect(reads).toBe(2);
    expect(recorded.pass.setIndexBuffer).toHaveBeenCalledExactlyOnceWith(
      shared.indexBuffer,
      'uint32',
    );

    const failure = new Error('index binding unavailable');
    const rows = [
      { ...shared, indexFormat: 'uint16' as const },
      { ...shared, indexFormat: 'uint32' as const },
    ];
    const failed = recorder();
    vi.mocked(failed.pass.setIndexBuffer).mockImplementation((_buffer, format) => {
      if (format === 'uint32') throw failure;
    });
    let caught: unknown;
    try {
      recordGpuDrivenShadowIndirect(failed.pass, submission(rows));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(failed.pass.drawIndexedIndirect).toHaveBeenCalledTimes(1);
    vi.mocked(failed.pass.setIndexBuffer).mockImplementation(() => {});
    recordGpuDrivenShadowIndirect(failed.pass, submission(rows));
    expect(failed.pass.drawIndexedIndirect).toHaveBeenCalledTimes(3);
  });

  it('observes the setter buffer before its format and preserves the first failure', () => {
    const shared = batch();
    const trace: string[] = [];
    const buffer = {} as Buffer;
    const bufferFailure = new Error('index buffer getter failed');
    const formatFailure = new Error('index format getter failed');
    let bufferReads = 0,
      formatReads = 0;
    const row = {
      ...shared,
      get indexBuffer() {
        trace.push('buffer');
        if (++bufferReads === 3) throw bufferFailure;
        return buffer;
      },
      get indexFormat(): 'uint16' {
        trace.push('format');
        if (++formatReads === 2) throw formatFailure;
        return 'uint16';
      },
    };
    let caught: unknown;
    try {
      recordGpuDrivenShadowIndirect(recorder().pass, { ...submission([]), batches: [row] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(bufferFailure);
    expect(trace).toEqual(['buffer', 'format', 'buffer', 'buffer']);
  });

  it('rebinds changed physical groups and offset shapes while bindings survive pipeline changes', () => {
    const first = batch();
    const second = { ...first, materialGroup: {} as BindGroup, meshBindGroup: {} as BindGroup };
    const skin = { ...second, deformation: 'skin' as const };
    const otherPipeline = { ...skin, pipeline: {} as RenderPipeline };
    const rows = [first, first, second, skin, otherPipeline, first];
    const recorded = recorder();
    recordGpuDrivenShadowIndirect(recorded.pass, submission(rows));
    expectDraws(recorded, rows);
    const pipelines = [first.pipeline, otherPipeline.pipeline, first.pipeline];
    const pipelineCalls = vi.mocked(recorded.pass.setPipeline).mock.calls;
    expect(pipelineCalls).toHaveLength(pipelines.length);
    for (const [index, pipeline] of pipelines.entries())
      expect(pipelineCalls[index]?.[0]).toBe(pipeline);
    // Pipeline selection does not erase a binding. Resource and dynamic-offset
    // transitions still require each of these exact, ordered setter calls.
    const expectedBindings = [
      [1, first.materialGroup, [0]],
      [2, first.meshBindGroup, [0]],
      [3, first.visibleBindGroups[0], undefined],
      [1, second.materialGroup, [0]],
      [2, second.meshBindGroup, [0]],
      [2, skin.meshBindGroup, [0, 768]],
      [1, first.materialGroup, [0]],
      [2, first.meshBindGroup, [0]],
    ] as const;
    expect(recorded.bind.mock.calls).toHaveLength(expectedBindings.length);
    for (const [index, expected] of expectedBindings.entries()) {
      const actual = recorded.bind.mock.calls[index];
      expect(actual?.[0]).toBe(expected[0]);
      expect(actual?.[1]).toBe(expected[1]);
      expect(actual?.[2]).toEqual(expected[2]);
    }
  });
});

async function preparedFixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const buffer = device.createBuffer({ size: 4096, usage: 0xa8 }).unwrap();
  const replacement = device.createBuffer({ size: 4096, usage: 0xa8 }).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const group = () => device.createBindGroup({ layout, entries: [] }).unwrap();
  const pipelineLayout = device
    .createPipelineLayout({ bindGroupLayouts: [layout, layout, layout, layout] })
    .unwrap();
  const shared: GpuDrivenShadowBatch = {
    ...batch(),
    pipeline: device
      .createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shader, entryPoint: 'vs_main', buffers: [] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      })
      .unwrap(),
    vertexBuffer: buffer,
    materialGroup: group(),
    meshBindGroup: group(),
    visibleBindGroups: [group()],
  };
  return {
    ...preparedShadowFixture({
      device,
      buffer,
      layout,
      shared,
      view: group(),
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }),
    shared,
    replacement,
    group,
    dispose() {
      device.destroyBuffer(replacement).unwrap();
      device.destroyBuffer(buffer).unwrap();
    },
  };
}

it('retains native commands per projected batch through membership and local resource edits', async () => {
  const fixture = await preparedFixture();
  const recorded = recorder();
  const record = vi.spyOn(fixture.shadowView, 'recordShadow');
  try {
    encodeDirectionalShadowPass(fixture.context, recorded.pass, 0);
    const first = record.mock.calls[0]?.[1];
    expect(first).toHaveLength(64);
    expect(fixture.bundleRecording).toHaveBeenCalledTimes(64);
    encodeDirectionalShadowPass(fixture.context, recorded.pass, 0);
    expect(record.mock.calls[1]?.[1]).toEqual(first);
    expect(fixture.bundleRecording).toHaveBeenCalledTimes(64);
    expect(recorded.draws).toHaveLength(128);
    expect(vi.mocked(recorded.pass.executeBundles)).toHaveBeenCalledTimes(2);
    fixture.batches.pop();
    recorded.draws.length = 0;
    encodeDirectionalShadowPass(fixture.context, recorded.pass, 0);
    expect(fixture.bundleRecording).toHaveBeenCalledTimes(64);
    expect(recorded.draws).toHaveLength(63);
    const batch = fixture.batches.at(0);
    const projection = batch === undefined ? undefined : fixture.projections.get(batch.batchId);
    if (projection === undefined) throw Error('Missing first projected batch');
    projection.mesh = { ...projection.mesh, vertexBuffer: { handle: fixture.replacement } };
    encodeDirectionalShadowPass(fixture.context, recorded.pass, 0);
    expect(fixture.bundleRecording).toHaveBeenCalledTimes(65);
    expect(fixture.shadowView.inspect().shadowBundles).toMatchObject({ hits: 189, builds: 65 });
  } finally {
    record.mockRestore();
    fixture.dispose();
  }
});

it('resolves shared opaque resources once per view and observes the next resource generation', async () => {
  const fixture = await preparedFixture();
  const {
    context,
    shared,
    batches,
    projections,
    materialBuffer,
    replacement,
    seedMaterial,
    shadowMaterialBindGroups,
  } = fixture;
  const recorded = recorder();
  const lookups = vi.spyOn(shadowMaterialBindGroups, 'get');
  try {
    encodeDirectionalShadowPass(context, recorded.pass, 0);
    // One outer pass binding and one prepared opaque binding, independent of batch count.
    expect(lookups).toHaveBeenCalledTimes(2);
    expect(recorded.draws).toHaveLength(64);
    expect(recorded.draws.every(({ material }) => material === shared.materialGroup)).toBe(true);

    const next = fixture.group();
    materialBuffer.buffer = replacement;
    seedMaterial(next);
    lookups.mockClear();
    recorded.draws.length = 0;
    encodeDirectionalShadowPass(context, recorded.pass, 0);
    expect(lookups).toHaveBeenCalledTimes(2);
    expect(recorded.draws).toHaveLength(64);
    expect(recorded.draws.every(({ material }) => material === next)).toBe(true);

    projections.delete(batches.at(-1)?.batchId ?? -1);
    recorded.draws.length = 0;
    expect(() => encodeDirectionalShadowPass(context, recorded.pass, 0)).toThrow();
    expect(recorded.draws).toHaveLength(0);

    batches.length = 0;
    lookups.mockClear();
    encodeDirectionalShadowPass(context, recorded.pass, 0);
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(recorded.draws).toHaveLength(0);
  } finally {
    lookups.mockRestore();
    fixture.dispose();
  }
});

it('prepares static caster bindings once for every nonempty dirty region of the same pass', async () => {
  const fixture = await preparedFixture();
  const { context, pipelineLookup, shared, batches } = fixture;
  const recorded = recorder();
  const identity = { kind: 'directional' as const, index: 0 };
  const dirty = {
    size: 64,
    rects: [
      { x0: 0, y0: 0, x1: 0.25, y1: 0.5 },
      { x0: 0.75, y0: 0.5, x1: 1, y1: 1 },
    ],
  };
  try {
    encodeStaticShadowPass(context, recorded.pass, identity, dirty, true);
    expect(recorded.pass.setScissorRect).toHaveBeenNthCalledWith(1, 0, 0, 16, 32);
    expect(recorded.pass.setScissorRect).toHaveBeenNthCalledWith(2, 48, 32, 16, 32);
    expect(recorded.pass.draw).toHaveBeenCalledTimes(2);
    const scissorOrder = vi.mocked(recorded.pass.setScissorRect).mock.invocationCallOrder;
    const clearOrder = vi.mocked(recorded.pass.draw).mock.invocationCallOrder;
    const drawOrder = vi.mocked(recorded.pass.drawIndirect).mock.invocationCallOrder;
    for (let region = 0; region < dirty.rects.length; region++) {
      expect(scissorOrder[region]).toBeLessThan(clearOrder[region] ?? 0);
      expect(clearOrder[region]).toBeLessThan(drawOrder[region * batches.length] ?? 0);
      if (region > 0) {
        expect(drawOrder[region * batches.length - 1]).toBeLessThan(scissorOrder[region] ?? 0);
      }
    }
    expect(recorded.draws.map(({ offset }) => offset)).toEqual(
      [...batches, ...batches].map(({ indirectOffset }) => indirectOffset),
    );
    expect(recorded.draws.every(({ material }) => material === shared.materialGroup)).toBe(true);
    expect(pipelineLookup).toHaveBeenCalledTimes(1);

    // The reuse ends at this invocation; replaced material resources reach the next pass.
    const replacementGroup = fixture.group();
    fixture.materialBuffer.buffer = fixture.replacement;
    fixture.seedMaterial(replacementGroup);
    pipelineLookup.mockClear();
    recorded.draws.length = 0;
    encodeStaticShadowPass(
      context,
      recorded.pass,
      identity,
      {
        ...dirty,
        rects: dirty.rects.slice(0, 1),
      },
      true,
    );
    expect(pipelineLookup).toHaveBeenCalledTimes(1);
    expect(recorded.draws).toHaveLength(batches.length);
    expect(recorded.draws.every(({ material }) => material === replacementGroup)).toBe(true);

    pipelineLookup.mockClear();
    recorded.draws.length = 0;
    encodeStaticShadowPass(context, recorded.pass, identity, { ...dirty, rects: [] });
    encodeStaticShadowPass(context, recorded.pass, identity, {
      ...dirty,
      rects: [{ x0: 1, y0: 1, x1: 1, y1: 1 }],
    });
    expect(pipelineLookup).not.toHaveBeenCalled();
    expect(recorded.draws).toHaveLength(0);

    fixture.projections.delete(batches.at(-1)?.batchId ?? -1);
    expect(() => encodeStaticShadowPass(context, recorded.pass, identity, dirty)).toThrow();
    expect(recorded.draws).toHaveLength(0);
  } finally {
    fixture.dispose();
  }
});

it('accepts a proved empty partial update before composing the retained static layer', async () => {
  const fixture = await preparedFixture();
  fixture.batches.length = 0;
  const context = fixture.context;
  const pool = context.gpuDrivenShadowViews;
  if (pool === undefined) throw new Error('Missing shadow view owner');
  const source = pool.submission({ kind: 'directional', index: 0 });
  if (source === undefined) throw new Error('Missing shadow submission');
  const submission = vi.spyOn(pool, 'submission').mockImplementation((identity) => ({
    ...source,
    identity,
    generation: 2,
    cache: 'invalidated',
    selection: new GpuDrawSelection([]),
  }));
  const recorded = recorder();
  try {
    expect(() => encodeDirectionalShadowPass(context, recorded.pass, 0)).toThrow(
      'submitted static shadow depth',
    );
    encodeStaticShadowPass(
      context,
      recorded.pass,
      { kind: 'directional', index: 0 },
      {
        size: 64,
        rects: [],
      },
    );
    expect(recorded.draws).toHaveLength(0);
    expect(() => encodeDirectionalShadowPass(context, recorded.pass, 0)).not.toThrow();
  } finally {
    submission.mockRestore();
    fixture.dispose();
  }
});

it('counts actual prepared shadow bundle commands on every successful execution, including cache hits', async () => {
  const fixture = await preparedFixture();
  const target = recorder();
  const ledger = new ShadowRasterLedger();
  try {
    for (const frameId of [7, 8]) {
      ledger.begin(true, frameId);
      const slot = ledger.evaluate({ kind: 'directional', index: 0 }, 'content-changed');
      ledger.encode(
        slot,
        target.pass,
        (pass) => encodeDirectionalShadowPass(fixture.context, pass, 0),
        'shadowCascade0',
      );
      ledger.commit();
      expect(ledger.captureWorkload(frameId)?.[0]?.commands).toMatchObject({
        bundleCalls: 1,
        knownBundleIndirectDraws: 64,
        knownBundleIndexedIndirectDraws: 0,
        indirectDraws: 0,
        indexedIndirectDraws: 0,
      });
    }
    expect(fixture.bundleRecording).toHaveBeenCalledTimes(64);
    fixture.batches.pop();
    ledger.begin(true, 9);
    const slot = ledger.evaluate({ kind: 'directional', index: 0 }, 'membership-changed');
    ledger.encode(
      slot,
      target.pass,
      (pass) => encodeDirectionalShadowPass(fixture.context, pass, 0),
      'shadowCascade0',
    );
    ledger.commit();
    expect(ledger.captureWorkload(9)?.[0]?.commands.knownBundleIndirectDraws).toBe(63);
  } finally {
    fixture.dispose();
  }
});
