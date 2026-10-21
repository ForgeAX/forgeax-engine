import { err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { MaterialResource } from '../../material-resource';
import type { DispatchEntry } from '../../render-system-extract';
import { MaterialFrame } from '../../scene/material-dispatch';
import { makeZeroCameraFallbackSnapshot } from '../frame-snapshot';
import { recordGeometryDraws } from '../main-pass-geometry';
import { CPU_SETUP_SHADER, cpuSetupFixture } from './main-pass-cpu-setup-fixture';

it.each([
  true,
  false,
])('does no CPU buffer binding or instance upload for wholly claimed geometry (indexed=%s)', async (indexed) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  f.add({ entity: 1, indexed, instances: 2, claimed: [0, 1, 2] });
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  const groups = vi.spyOn(device, 'createBindGroup');
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const vertex = vi.spyOn(pass, 'setVertexBuffer');
  const index = vi.spyOn(pass, 'setIndexBuffer');
  try {
    f.record(pass);
    expect(vertex).toHaveBeenCalledTimes(0);
    expect(index).toHaveBeenCalledTimes(0);
    expect(writes).toHaveBeenCalledTimes(0);
    expect(groups).toHaveBeenCalledTimes(0);
    expect(f.receipts).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it.each([
  true,
  false,
])('sets up mixed and subsequent CPU geometry exactly once while retaining sparse draw indices (indexed=%s)', async (indexed) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const mixed = f.add({ entity: 1, indexed, instances: 2, claimed: [0, 2] });
  f.add({ entity: 2, indexed, instances: 3, claimed: [0, 1, 2] });
  const next = f.add({ entity: 3, indexed, submeshes: 1 });
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const vertex = vi.spyOn(pass, 'setVertexBuffer');
  const index = vi.spyOn(pass, 'setIndexBuffer');
  const draw = vi.spyOn(pass, indexed ? 'drawIndexed' : 'draw');
  try {
    f.record(pass);
    expect(vertex.mock.calls).toEqual([
      [0, mixed.mesh.vertexBuffer.handle],
      [0, next.mesh.vertexBuffer.handle],
    ]);
    expect(index).toHaveBeenCalledTimes(indexed ? 2 : 0);
    expect(writes.mock.calls.filter(([buffer]) => buffer !== f.meshUniformBuffer)).toHaveLength(1);
    expect(writes.mock.calls.filter(([buffer]) => buffer === f.meshUniformBuffer)).toHaveLength(1);
    expect(draw.mock.calls).toEqual(
      indexed
        ? [
            [3, 2, 3, 0, 0],
            [3, 1, 0, 0, 0],
          ]
        : [
            [3, 2, 3, 0],
            [3, 1, 0, 0],
          ],
    );
    expect(f.receipts).toEqual([
      { entity: 1, submesh: 1 },
      { entity: 3, submesh: 0 },
    ]);
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('prepares the retained mesh slot once and draws every submesh when nothing is claimed', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const entry = f.add({ entity: 1, instances: 2 });
  Object.assign(entry, { meshSlot: 7 });
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const vertex = vi.spyOn(pass, 'setVertexBuffer');
  const groups = vi.spyOn(pass, 'setBindGroup');
  try {
    f.record(pass);
    expect(vertex).toHaveBeenCalledTimes(1);
    expect(
      groups.mock.calls.filter(([slot]) => slot === 2).map(([, , offsets]) => offsets),
    ).toEqual([[7 * 256], [7 * 256], [7 * 256]]);
    expect(writes.mock.calls.filter(([buffer]) => buffer !== f.meshUniformBuffer)).toHaveLength(1);
    expect(writes.mock.calls.filter(([buffer]) => buffer === f.meshUniformBuffer)).toHaveLength(1);
    expect(f.receipts.map(({ submesh }) => submesh)).toEqual([0, 1, 2]);
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it.each([
  'material',
  'dispatch',
] as const)('does no CPU setup when the %s selector excludes every submesh', async (filter) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  f.add({ entity: 1, instances: 2 });
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const vertex = vi.spyOn(pass, 'setVertexBuffer');
  try {
    recordGeometryDraws(
      f.c,
      pass,
      filter === 'material' ? new Map([[0, new Set([99])]]) : null,
      [[0]],
      1,
      f.meshGroup,
      f.meshGroup,
      () => f.materialGroup,
      'forward',
      filter === 'dispatch' ? [] : undefined,
    );
    expect(vertex).toHaveBeenCalledTimes(0);
    expect(writes).toHaveBeenCalledTimes(0);
    expect(f.c.bindGroupCounts.createBindGroup).toBe(0);
    expect(f.receipts).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('skips the entire failed instance entry and preserves the following ordinary draw', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  f.add({ entity: 1, instances: 2 });
  f.add({ entity: 2, submeshes: 1 });
  const failure = new RhiError({
    code: 'rhi-not-available',
    expected: 'instance allocation',
    hint: 'retry the frame',
  });
  const allocation = vi.spyOn(device, 'createBuffer').mockReturnValue(err(failure));
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    f.record(pass);
    expect(allocation).toHaveBeenCalledTimes(1);
    expect(f.receipts).toEqual([{ entity: 2, submesh: 0 }]);
    expect(f.errors).toEqual([failure]);
  } finally {
    pass.end();
    allocation.mockRestore();
    f.dispose();
  }
});

it('preserves the temporal pass eligibility instead of skipping every GPU-claimed entity', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  f.add({ entity: 1, claimed: [0, 1, 2] });
  const lod = f.add({ entity: 2, claimed: [0, 1, 2] });
  f.gpuLodLevels.set(lod.source.material, 2);
  lod.source.material.adopt({
    ...lod.source.material.snapshot,
    materialShaderId: 'forgeax::default-standard-pbr',
  });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const vertex = vi.spyOn(pass, 'setVertexBuffer');
  try {
    f.record(pass, 'temporal');
    expect(vertex).toHaveBeenCalledTimes(1);
    expect(f.receipts).toEqual([0, 1, 2].map((submesh) => ({ entity: 1, submesh })));
  } finally {
    pass.end();
    f.dispose();
  }
});

it('restores shared mesh, pipeline and instance state after a Points/Lines draw and a GPU-only entry', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const pointsPipeline = cpuSetupFixture(device, module);
  const first = f.add({ entity: 1, instances: 2, submeshes: 1 });
  const points = f.add({ entity: 2, submeshes: 1 });
  f.add({ entity: 3, claimed: [0, 1, 2] });
  const last = f.add({ entity: 4, submeshes: 1 });
  Object.assign(first, { stencilReference: 9 });
  Object.assign(points, { stencilReference: 17 });
  Object.assign(last, { mesh: first.mesh, stencilReference: 9 });
  Object.assign(last.source, { instances: first.source.instances });
  Object.assign(points.source, { pointsLines: {}, transform: { world: new Float32Array(16) } });
  Object.assign(f.c.runtime, {
    getMaterialShaderPipelineEntry: (shader: string) => ({
      pipeline: shader === 'forgeax::points-lines' ? pointsPipeline.pipeline : f.pipeline,
      group2Contract: 'mesh',
    }),
  });
  const viewBuffer = device.createBuffer({ size: 2048, usage: 64 | 8 }).unwrap();
  Object.assign(f.c.pipelineState, { pointsLinesViewBuffer: viewBuffer });
  Object.assign(f.c, {
    camera: makeZeroCameraFallbackSnapshot(),
    targetW: 32,
    targetH: 32,
    pointsLines: {
      prepare: (entry: unknown) =>
        entry === points
          ? {
              vertexBuffer: points.mesh.vertexBuffer.handle,
              indexBuffer: points.mesh.indexBuffer?.handle,
              layoutProjection: points.mesh.layoutProjection,
              plan: { drawCount: 1, indexCount: 3 },
            }
          : undefined,
    },
  });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const vertex = vi.spyOn(pass, 'setVertexBuffer');
  const index = vi.spyOn(pass, 'setIndexBuffer');
  const pipeline = vi.spyOn(pass, 'setPipeline');
  const group = vi.spyOn(pass, 'setBindGroup');
  const stencil = vi.spyOn(pass, 'setStencilReference');
  try {
    f.record(pass);
    expect(vertex.mock.calls).toEqual([
      [0, first.mesh.vertexBuffer.handle],
      [0, points.mesh.vertexBuffer.handle],
      [0, first.mesh.vertexBuffer.handle],
    ]);
    expect(index.mock.calls.map(([buffer]) => buffer)).toEqual([
      first.mesh.indexBuffer?.handle,
      points.mesh.indexBuffer?.handle,
      first.mesh.indexBuffer?.handle,
    ]);
    expect(pipeline.mock.calls).toEqual([[f.pipeline], [pointsPipeline.pipeline], [f.pipeline]]);
    const instances = group.mock.calls
      .filter(([slot]) => slot === 3)
      .map(([, bindGroup]) => bindGroup);
    expect(instances).toHaveLength(3);
    expect(instances[2]).toBe(instances[0]);
    expect(instances[1]).not.toBe(instances[0]);
    expect(stencil.mock.calls).toEqual([[9], [17], [9]]);
    expect(f.receipts).toEqual([
      { entity: 1, submesh: 0 },
      { entity: 2, submesh: undefined },
      { entity: 4, submesh: 0 },
    ]);
  } finally {
    pass.end();
    f.dispose();
    pointsPipeline.dispose();
    device.destroyBuffer(viewBuffer).unwrap();
  }
});

it('keeps Points/Lines parameter addresses distinct across local Pass rosters', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const rows = [f.add({ entity: 1, submeshes: 1 }), f.add({ entity: 2, submeshes: 1 })];
  for (const [index, row] of rows.entries()) {
    const matrix = new Float32Array(row.source.transform.world);
    matrix[12] = index === 0 ? 2 : -2;
    Object.assign(row.source, { pointsLines: {}, transform: { world: matrix } });
  }
  const viewBuffer = device.createBuffer({ size: 2048, usage: 64 | 8 }).unwrap();
  Object.assign(f.c.pipelineState, { pointsLinesViewBuffer: viewBuffer });
  Object.assign(f.c, {
    camera: makeZeroCameraFallbackSnapshot(),
    targetW: 32,
    targetH: 32,
    pointsLines: {
      prepare: (row: (typeof rows)[number]) => ({
        vertexBuffer: row.mesh.vertexBuffer.handle,
        indexBuffer: row.mesh.indexBuffer?.handle,
        layoutProjection: row.mesh.layoutProjection,
        plan: { drawCount: 1, indexCount: 3 },
      }),
    },
  });
  const uploads: { offset: number; x: number }[] = [];
  const write = device.queue.writeBuffer.bind(device.queue);
  const spy = vi
    .spyOn(device.queue, 'writeBuffer')
    .mockImplementation((buffer, offset, bytes, ...rest) => {
      if (buffer === viewBuffer) {
        const floats = ArrayBuffer.isView(bytes)
          ? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
          : new Float32Array(bytes);
        uploads.push({ offset, x: floats[28] as number });
      }
      return write(buffer, offset, bytes, ...rest);
    });
  const encoder = device.createCommandEncoder().unwrap();
  try {
    for (const row of rows) {
      const pass = encoder.beginRenderPass({ colorAttachments: [] });
      const slots = [[row.renderableIndex]];
      recordGeometryDraws(
        { ...f.c, validatedOrdered: [row], materialSlotIndices: slots },
        pass,
        null,
        slots,
        1,
        f.meshGroup,
        f.meshGroup,
        () => f.materialGroup,
      );
      pass.end();
    }
    expect(uploads).toEqual([
      { offset: 0, x: 2 },
      { offset: 256, x: -2 },
    ]);
    expect(f.errors).toEqual([]);
  } finally {
    spy.mockRestore();
    f.dispose();
    device.destroyBuffer(viewBuffer).unwrap();
  }
});

it.each([
  'forward',
  'temporal',
] as const)('preserves per-material multipass order and temporal deduplication in %s', async (kind) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const entry = f.add({ entity: 1, submeshes: 2 });
  const secondSubmesh = entry.mesh.submeshes[1];
  if (secondSubmesh === undefined) throw new Error('Missing second fixture submesh');
  Object.assign(secondSubmesh, { materialSlot: 1 });
  Object.assign(entry.source, {
    materials: [
      entry.source.material,
      new MaterialResource({ ...entry.source.material.snapshot, materialHandle: 8 }),
    ],
  });
  const secondMaterial = entry.source.materials[1];
  if (secondMaterial === undefined) throw new Error('Missing second fixture material');
  Object.assign(f.c, {
    materialFrame: new MaterialFrame(undefined).with(entry.source.material).with(secondMaterial),
    materialSlots: entry.source.materials.map((material) => material.snapshot),
    materialSlotIndices: [[0, 1]],
  });
  const makeDispatch = (
    materialHandle: number,
    passIndex: number,
    stencilReference?: number,
  ): DispatchEntry => ({
    renderableIndex: 0,
    entityIndex: 0,
    materialHandle,
    passIndex,
    queue: 2000,
    layer: 0,
    tags: { SurfaceKind: 'standard', SurfaceModule: 'fixture', GeometryVariant: 'mesh' },
    renderState: undefined,
    defines: undefined,
    vertexEntry: undefined,
    fragmentEntry: undefined,
    materialShaderId: 'forgeax::default-unlit',
    ...(stencilReference === undefined ? {} : { stencilReference }),
  });
  const dispatch = [
    makeDispatch(7, 0),
    makeDispatch(8, 0),
    makeDispatch(7, 1),
    makeDispatch(7, 2, 1),
    makeDispatch(7, 3, 2),
    makeDispatch(7, 4, 1),
  ];
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    const record = (selected: readonly DispatchEntry[]) =>
      recordGeometryDraws(
        f.c,
        pass,
        null,
        [[0, 1]],
        1,
        f.meshGroup,
        f.meshGroup,
        () => f.materialGroup,
        kind,
        selected,
      );
    record(dispatch);
    expect(f.receipts.map(({ submesh }) => submesh)).toEqual(
      kind === 'forward' ? [0, 0, 0, 0, 0, 1] : [0, 0, 0, 1],
    );
    f.receipts.length = 0;
    record([makeDispatch(8, 0)]);
    expect(f.receipts.map(({ submesh }) => submesh)).toEqual([1]);
    f.receipts.length = 0;
    record([
      new Proxy(makeDispatch(7, 0), {
        has() {
          throw new Error('Recording must not reflect the raw dispatch');
        },
      }),
    ]);
    expect(f.receipts.map(({ submesh }) => submesh)).toEqual([0]);
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('prepares mesh bindings only when a CPU submesh survives GPU ownership', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  f.add({ entity: 1, claimed: [0, 1, 2] });
  let pageReads = 0;
  Object.defineProperty(f.c.pipelineState.meshStorageBuffer, 'pages', {
    get: () => {
      pageReads++;
      return undefined;
    },
  });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    // Observe recording before the separate submission upload flush reads its buffer owner.
    f.record(pass, 'forward', f.prepareSelection(), () => expect(pageReads).toBe(0));
    expect(f.receipts).toEqual([]);
    pageReads = 0;
    f.selectedDraws.clear();
    f.record(pass);
    expect(f.receipts).toEqual([0, 1, 2].map((submesh) => ({ entity: 1, submesh })));
    expect(pageReads).toBeGreaterThan(0);
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});
