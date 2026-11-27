import { type BindGroup, err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { createViewportHitCapture } from '../../assembly/viewport-hit-proxy';
import * as environment from '../../environment/bindings';
import { IndirectPassBindings } from '../../gpu-driven/production-raster-encode';
import { captureMaterialSnapshot, MaterialResource } from '../../material-resource';
import type { DispatchEntry } from '../../render-system-extract';
import { CapturedSceneTransform } from '../../scene/captured-transform';
import { MaterialFrame } from '../../scene/material-dispatch';
import { FirstEntryMap } from '../first-entry-map';
import { makeZeroCameraFallbackSnapshot } from '../frame-snapshot';
import type { RenderBundleCounters } from '../geometry-recording';
import { recordGeometryDraws } from '../main-pass-geometry';
import { flushMeshDrawUploads, MESH_PER_ENTITY_STRIDE, prepareMeshDraw } from '../mesh-ssbo';
import { ShadowDirectCommands } from '../shadow-direct-commands';
import {
  CPU_SETUP_SHADER,
  cpuSetupFixture,
  fixtureMaterialBinding,
  nativeGeometryFixture,
} from './main-pass-cpu-setup-fixture';

it.each([
  'forgeax::default-unlit',
  'game::paint',
])('selects %s once across uniform-only materials and keeps both binding addresses', async (shader) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const native = nativeGeometryFixture(f);
  for (const pass of f.c.dispatch ?? []) Object.assign(pass, { materialShaderId: shader });
  const second = f.entries[1]?.source.material;
  if (second === undefined) throw new Error('missing second material');
  const programRead = vi.fn(
    (_id: string, _request?: { readonly alphaMask?: boolean }) => undefined,
  );
  Object.assign(f.c.runtime, { getMaterialShaderArtifact: programRead });
  const record = () => {
    f.acceptMaterials();
    const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
    const addresses: number[] = [];
    programRead.mockClear();
    try {
      native.record(pass, (slot) => {
        addresses.push(slot);
        return 0;
      });
      expect(addresses).toEqual([0, 1]);
      return programRead.mock.calls.filter(([, request]) => request?.alphaMask !== undefined)
        .length;
    } finally {
      pass.end();
    }
  };
  try {
    for (const row of f.entries) {
      const resource = row.source.material;
      resource.adopt(
        captureMaterialSnapshot({
          ...resource.snapshot,
          materialShaderId: shader,
          roughness: row.renderableIndex,
        }),
      );
    }
    const shared = record();
    second.adopt(
      captureMaterialSnapshot({ ...second.snapshot, paramSnapshot: { alphaCutoff: 0.5 } }),
    );
    const masked = record();
    expect([shared, masked]).toEqual([1, 2]);
  } finally {
    f.dispose();
  }
});

it.each([
  true,
  false,
])('consumes the prepared row-order proof and preserves reordered recording (ordered=%s)', async (ordered) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  f.add({ entity: 1, submeshes: 1 });
  f.add({ entity: 2, submeshes: 1 });
  const first = f.entries[0];
  if (first === undefined) throw new Error('missing first native mesh row');
  const physicalSlot = first.meshSlot;
  if (physicalSlot === undefined) throw new Error('missing prepared mesh address');
  const slotReads = vi.fn(() => physicalSlot);
  Object.defineProperty(first, 'meshSlot', { get: slotReads, configurable: true });
  const dispatch: DispatchEntry[] = f.entries.map((row) => ({
    entityIndex: row.source.entityKey,
    renderableIndex: row.renderableIndex,
    materialHandle: 7,
    passIndex: 0,
    queue: 2000,
    layer: 0,
    tags: { LightMode: 'Forward' },
    renderState: undefined,
    defines: undefined,
    vertexEntry: undefined,
    fragmentEntry: undefined,
    materialShaderId: 'forgeax::default-unlit',
  }));
  const byRow = dispatch.map((entry) =>
    new FirstEntryMap<number, DispatchEntry | DispatchEntry[]>().set(7, entry),
  );
  const keys = vi.fn(function* () {
    yield 0;
    yield 1;
  });
  const rows = ordered ? f.entries : [...f.entries].reverse();
  Object.assign(f.c, {
    validatedOrdered: rows,
    dispatch,
    materialSlotIndices: [[0], [0]],
    geometryMaterialPasses: {
      dispatch,
      validatedOrdered: rows,
      temporal: false,
      ordered,
      groups: { temporal: false, size: 2, get: (index: number) => byRow[index], keys },
    },
  });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const bind = vi.spyOn(pass, 'setBindGroup');
  const materialBinds = () => bind.mock.calls.filter(([slot]) => slot === 1);
  const record = (selected: readonly DispatchEntry[]) =>
    recordGeometryDraws(
      f.c,
      pass,
      null,
      f.c.materialSlotIndices,
      1,
      f.meshGroup,
      f.meshGroup,
      fixtureMaterialBinding(f.materialGroup, (slot) => slot * 256),
      'forward',
      selected,
    );
  const submittedMaterialRows = vi.spyOn(f.c.materialSlotIndices, 'at');
  try {
    record(dispatch);
    expect(submittedMaterialRows).toHaveBeenCalledTimes(rows.length);
    expect(f.receipts.map((receipt) => receipt.entity)).toEqual([1, 2]);
    expect(materialBinds()).toHaveLength(1);
    if (ordered) expect(keys.mock.calls.length).toBe(0);
    else expect(keys.mock.calls.length).toBeGreaterThan(0);
    slotReads.mockClear();
    f.receipts.length = 0;
    record(dispatch);
    // Binding and staging consume one prepared physical address per row.
    expect(slotReads).toHaveBeenCalledTimes(1);
    expect(f.receipts.map((receipt) => receipt.entity)).toEqual([1, 2]);

    const storage = f.c.pipelineState.meshStorageBuffer;
    flushMeshDrawUploads(device.queue, storage);
    // Another view can write different bytes at this same address.
    const moved = first.source.transform.world.slice();
    moved[12] = 5;
    prepareMeshDraw(f.c, {
      ...first,
      source: { ...first.source, transform: { world: moved } },
    });
    flushMeshDrawUploads(device.queue, storage);
    slotReads.mockClear();
    f.receipts.length = 0;
    record(dispatch);
    const writes = vi.spyOn(device.queue, 'writeBuffer');
    try {
      expect(flushMeshDrawUploads(device.queue, storage)).toBe(1);
      const changed = writes.mock.calls.find(
        ([buffer, offset]) =>
          buffer === storage.buffer && offset === physicalSlot * MESH_PER_ENTITY_STRIDE,
      );
      expect(changed).toBeDefined();
      const [, , bytes, offset] = changed ?? [];
      if (!(bytes instanceof Uint8Array)) throw new Error('missing staged mesh bytes');
      expect(
        new DataView(bytes.buffer, bytes.byteOffset).getFloat32((offset ?? 0) + 48, true),
      ).toBe(first.source.transform.world[12]);
    } finally {
      writes.mockRestore();
    }
    expect(slotReads).toHaveBeenCalledTimes(1);
    expect(f.receipts.map((receipt) => receipt.entity)).toEqual([1, 2]);

    f.receipts.length = 0;
    bind.mockClear();
    record([...dispatch].reverse());
    expect(f.receipts.map((receipt) => receipt.entity)).toEqual([2, 1]);
    expect(materialBinds()).toHaveLength(2);

    f.receipts.length = 0;
    bind.mockClear();
    Object.assign(f.c, { materialSlotIndices: [[0], [1]] });
    record(dispatch);
    expect(f.receipts.map((receipt) => receipt.entity)).toEqual([1, 2]);
    expect(materialBinds()).toHaveLength(2);
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it.each([
  false,
  true,
])('records the current native rows and physical addresses on every draw (instanced=%s)', async (instanced) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const prepared = nativeGeometryFixture(f, false, instanced ? 2 : undefined);
  const first = prepared.first;
  const counters: RenderBundleCounters = { hits: 0, misses: 0, visitedDraws: 0 };
  Object.assign(f.c, { profilePhase: (_phase: string, action: () => unknown) => action() });
  f.c.frameState.renderBundleCounters = counters;
  const record = (offset = 0) => {
    const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
    const executeBundles = vi.spyOn(pass, 'executeBundles');
    f.receipts.length = 0;
    prepared.record(pass, offset);
    pass.end();
    expect(f.receipts).toEqual([
      { entity: 1, submesh: 0 },
      { entity: 2, submesh: 0 },
    ]);
    return executeBundles.mock.calls.length;
  };
  try {
    expect(record()).toBe(0);
    expect(record()).toBe(0);
    expect(counters.geometry?.['display/forward/color']?.direct?.draws).toBe(4);
    flushMeshDrawUploads(device.queue, f.c.pipelineState.meshStorageBuffer);
    // A different pass can change mesh bytes while keeping all command addresses.
    const world = first.source.transform.world.slice();
    world[12] = 5;
    prepareMeshDraw(f.c, { ...first, source: { ...first.source, transform: { world } } });
    flushMeshDrawUploads(device.queue, f.c.pipelineState.meshStorageBuffer);
    const selectionReads = prepared.selectionReads;
    expect(record()).toBe(0);
    expect(counters.geometry?.['display/forward/color']?.direct?.draws).toBe(6);
    expect(prepared.selectionReads - selectionReads).toBe(2);
    expect(flushMeshDrawUploads(device.queue, f.c.pipelineState.meshStorageBuffer)).toBe(1);
    // A new pose and new instance bytes retain their physical addresses.
    const oldInstances = first.source.instances;
    const transforms = oldInstances?.transforms.slice();
    if (transforms !== undefined) transforms[12] = 7;
    const nextRow = {
      ...first,
      source: {
        ...first.source,
        transform: { world },
        ...(oldInstances === undefined || transforms === undefined
          ? {}
          : { instances: { ...oldInstances, revision: oldInstances.revision + 1, transforms } }),
      },
    };
    const nextRows = [nextRow, f.entries[1]];
    Object.assign(f.c, {
      validatedOrdered: nextRows,
      geometryMaterialPasses: { ...f.c.geometryMaterialPasses, validatedOrdered: nextRows },
      materialSlots: [...f.c.materialSlots],
      materialSlotIndices: f.c.materialSlotIndices.map((slots) => [...slots]),
    });
    const writes = vi.spyOn(device.queue, 'writeBuffer');
    expect(record()).toBe(0);
    expect(counters.geometry?.['display/forward/color']?.direct?.draws).toBe(8);
    if (instanced) {
      const instanceWrite = writes.mock.calls.find(
        ([, , data]) => data instanceof Float32Array && data[12] === 7,
      );
      expect(instanceWrite).toBeDefined();
    }
    writes.mockClear();
    expect(flushMeshDrawUploads(device.queue, f.c.pipelineState.meshStorageBuffer)).toBe(1);
    const written = writes.mock.calls[0]?.[2];
    if (!(written instanceof Uint8Array)) throw new Error('missing current mesh payload');
    expect(new DataView(written.buffer, written.byteOffset).getFloat32(48, true)).toBe(5);
    writes.mockRestore();
    expect(record(256)).toBe(0);
    expect(counters.geometry?.['display/forward/color']?.direct).toEqual({ ranges: 5, draws: 10 });
    expect(prepared.selectionReads - selectionReads).toBe(6);
    expect(f.errors).toEqual([]);
  } finally {
    f.dispose();
  }
});

it('visits live draws for a hit capture after three ordinary color submissions', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const prepared = nativeGeometryFixture(f);
  const counters: RenderBundleCounters = { hits: 0, misses: 0, visitedDraws: 0 };
  Object.assign(f.c, { profilePhase: (_phase: string, action: () => unknown) => action() });
  f.c.frameState.renderBundleCounters = counters;
  const record = () => {
    const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
    prepared.record(pass);
    pass.end();
  };
  try {
    record();
    record();
    record();
    expect(counters.geometry?.['display/forward/color']?.direct?.draws).toBe(6);
    const reads = prepared.selectionReads;
    const camera = makeZeroCameraFallbackSnapshot();
    const capture = createViewportHitCapture(camera);
    Object.assign(f.c, { camera, viewportHit: capture });
    record();
    expect(counters.geometry?.['display/forward/color']?.direct?.draws).toBe(8);
    expect(prepared.selectionReads - reads).toBe(2);
    // The fixture's synthetic pipeline has no production raster provenance.
    expect(capture.failure).toBe('geometry-coverage');
  } finally {
    f.dispose();
  }
});

it.each([
  false,
  true,
])('records the changing physical offset and the independent second draw for 60 frames (selected=%s)', async (selected) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const prepared = nativeGeometryFixture(f, selected);
  const counters: RenderBundleCounters = { hits: 0, misses: 0 };
  Object.assign(f.c, { profilePhase: (_phase: string, action: () => unknown) => action() });
  f.c.frameState.renderBundleCounters = counters;
  try {
    for (let frame = 0; frame < 60; frame++) {
      const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
      const materialOffsets: number[] = [];
      const meshOffsets: number[] = [];
      let addressWord: Uint32Array | undefined;
      const set = pass.setBindGroup.bind(pass);
      vi.spyOn(pass, 'setBindGroup').mockImplementation((...args: Parameters<typeof set>) => {
        const [index, , offsets, start, count] = args;
        if (index === 1 || index === 2) {
          expect(offsets).toBeInstanceOf(Uint32Array);
          expect([start, count]).toEqual([0, 1]);
          addressWord ??= offsets as Uint32Array;
          expect(offsets).toBe(addressWord);
          (index === 1 ? materialOffsets : meshOffsets).push(addressWord[0] as number);
        }
        return set(...args);
      });
      const offset = frame % 2 === 0 ? 0 : 512;
      f.receipts.length = 0;
      prepared.record(pass, (slot) => (slot === 0 ? offset : 0));
      pass.end();
      expect(materialOffsets).toEqual([offset, 256]);
      expect(meshOffsets).toEqual([0, MESH_PER_ENTITY_STRIDE]);
      expect(f.receipts).toEqual([
        { entity: 1, submesh: 0 },
        { entity: 2, submesh: 0 },
      ]);
    }
    expect(counters.geometry?.['display/forward/color']?.direct).toEqual({
      ranges: 60,
      draws: 120,
    });
    expect(prepared.selectionReads).toBe(120);
    expect(f.errors).toEqual([]);
  } finally {
    f.dispose();
  }
});

it('looks up texture-backed instance slots by the source entity', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  f.add({ entity: 37, instances: 2, submeshes: 1 });
  const lookup = vi.fn(() => undefined);
  Object.assign(f.c, {
    gpuDrivenScene: {},
    gpuDrivenSceneSlotForEntity: lookup,
  });
  Object.assign(f.c.pipelineState, {
    sceneDirectPipelineLayout: {},
    sceneDirectInstancesBindGroupLayout: {},
  });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    f.record(pass);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(37);
    expect(f.receipts.map((receipt) => receipt.entity)).toEqual([37]);
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

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

it('records a new physical index format even when consecutive rows share the buffer', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const a = f.add({ entity: 1, submeshes: 2 });
  const b = f.add({ entity: 2, submeshes: 2 });
  Object.assign(b.mesh, { indexBuffer: a.mesh.indexBuffer, indexFormat: 'uint16' });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const index = vi.spyOn(pass, 'setIndexBuffer');
  const offsets: number[] = [];
  const set = pass.setBindGroup.bind(pass);
  vi.spyOn(pass, 'setBindGroup').mockImplementation((...args: Parameters<typeof set>) => {
    if (args[0] === 2) offsets.push(args[2]?.[0] ?? -1);
    return Reflect.apply(set, pass, args);
  });
  try {
    f.record(pass);
    expect(index.mock.calls).toEqual([
      [a.mesh.indexBuffer?.handle, 'uint32'],
      [a.mesh.indexBuffer?.handle, 'uint16'],
    ]);
    expect(offsets).toEqual([0, 256]);
    expect(f.receipts).toHaveLength(4);
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
  const meshOffsets: number[][] = [];
  const set = pass.setBindGroup.bind(pass);
  vi.spyOn(pass, 'setBindGroup').mockImplementation((...args: Parameters<typeof set>) => {
    const [index, , offsets, start, count] = args;
    if (index === 2) {
      const begin = start ?? 0;
      meshOffsets.push(
        Array.from(offsets ?? []).slice(begin, begin + (count ?? offsets?.length ?? 0)),
      );
    }
    return set(...args);
  });
  try {
    f.record(pass);
    expect(vertex).toHaveBeenCalledTimes(1);
    expect(meshOffsets).toEqual([[7 * 256]]);
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
      fixtureMaterialBinding(f.materialGroup),
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
      slot: () => 0,
      submission: (entry: unknown) =>
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
      slot: (row: (typeof rows)[number]) => rows.indexOf(row),
      submission: (row: (typeof rows)[number]) => ({
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
        fixtureMaterialBinding(f.materialGroup),
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
        fixtureMaterialBinding(f.materialGroup),
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

it('binds the current view per admitted pipeline selection across changing draws', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  f.add({ entity: 1, submeshes: 64 });
  const other = f.add({ entity: 2, submeshes: 64 });
  other.source.material.adopt({
    ...other.source.material.snapshot,
    materialShaderId: 'test::alternate-view',
  });
  let needsDepth: string | undefined;
  const inspect = vi.fn((shader: string) => ({
    ok: true,
    value: {
      receipt: {
        bindings: shader === needsDepth ? 'render-lit-material-and-scene-depth' : 'material',
      },
    },
  }));
  Object.assign(f.c.runtime, { shaderRegistry: { findMaterialArtifact: inspect } });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const parity = vi.spyOn(CapturedSceneTransform, 'reflected');
  const pipelines = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  try {
    for (let frame = 0; frame < 4; frame++) {
      const moved = other.source.transform.world;
      moved[12] = frame;
      moved[0] = frame % 2 === 0 ? 1 : -1;
      parity.mockClear();
      pipelines.mockClear();
      inspect.mockClear();
      f.receipts.length = 0;
      f.record(pass);
      expect(f.receipts).toHaveLength(128);
      expect(parity.mock.results.map((r) => r.value)).toEqual([false, moved[0] < 0]);
      expect(
        pipelines.mock.calls.map(([shader, , state]) => [shader, state?.frontFace ?? 'ccw']),
      ).toEqual([
        ['forgeax::default-unlit', 'ccw'],
        ['test::alternate-view', moved[0] < 0 ? 'cw' : 'ccw'],
      ]);
      expect(inspect.mock.calls.map(([id]) => id)).toEqual([
        'forgeax::default-unlit',
        'test::alternate-view',
      ]);
    }
    // A later pass admits its own current inputs. This one now requires an actual depth image.
    needsDepth = 'test::alternate-view';
    f.receipts.length = 0;
    expect(() => f.record(pass)).toThrow(/scene-depth snapshot/);
    expect(f.receipts).toHaveLength(64);
  } finally {
    pipelines.mockRestore();
    parity.mockRestore();
    pass.end();
    f.dispose();
  }
});

it('shares a resolved draw pipeline across draws and retries a pending one per draw', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  f.add({ entity: 1, submeshes: 3 });
  const runtime = f.c.runtime as unknown as {
    getMaterialShaderPipelineEntry: (...args: unknown[]) => unknown;
  };
  const resolved = runtime.getMaterialShaderPipelineEntry;
  const lookups = vi.fn(resolved);
  runtime.getMaterialShaderPipelineEntry = lookups;
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const draw = vi.spyOn(pass, 'drawIndexed');
  try {
    f.record(pass);
    expect(draw).toHaveBeenCalledTimes(3);
    expect(lookups).toHaveBeenCalledTimes(1);
    const pending = vi.fn(() => null);
    runtime.getMaterialShaderPipelineEntry = pending;
    draw.mockClear();
    f.record(pass);
    expect(pending).toHaveBeenCalledTimes(3);
    expect(draw).toHaveBeenCalledTimes(0);
  } finally {
    pass.end();
    f.dispose();
  }
});

it.each(
  [[0, 1, 2], [2, 0, 1], [1], [9, 2, 0, 1]].map((order) => ({ order })),
)('records selected order $order with original row and material addresses', async ({ order }) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  for (let i = 0; i < 3; i++) f.add({ entity: i + 1, submeshes: 1 });
  const selected = order.map(
    (renderableIndex) =>
      ({
        renderableIndex,
        entityIndex: renderableIndex,
        materialHandle: 7,
        passIndex: 0,
        queue: 2000,
        layer: 0,
        tags: {},
      }) as DispatchEntry,
  );
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    recordGeometryDraws(
      f.c,
      pass,
      null,
      f.c.materialSlotIndices,
      1,
      f.meshGroup,
      f.meshGroup,
      fixtureMaterialBinding(f.materialGroup),
      'forward',
      selected,
    );
    expect(f.receipts.map((receipt) => receipt.entity)).toEqual(
      order.filter((index) => index < 3).map((index) => index + 1),
    );
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('keeps an omitted color pass pending until its owned pipeline is compiled', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const entry = f.add({ entity: 1, submeshes: 1 });
  entry.source.material.adopt({
    ...entry.source.material.snapshot,
    materialShaderId: 'test::pending-color',
  });
  const prepare = vi.fn().mockReturnValue(null);
  Object.assign(f.c.runtime, { prepareMaterialShaderPipelineEntry: prepare });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    f.record(pass);
    expect(f.receipts).toEqual([]);
    expect(f.c.frameState.pipelinePreparationPending).toBe(true);
    expect(f.c.frameState.pipelinePreparationPendingReason).toMatchObject({
      code: 'material-pipeline-preparation',
      entity: 1,
      pass: 'forward',
    });
    delete f.c.frameState.pipelinePreparationPending;
    delete f.c.frameState.pipelinePreparationPendingReason;
    prepare.mockReturnValue({ pipeline: f.pipeline, group2Contract: 'mesh' });
    f.record(pass);
    expect(f.receipts).toEqual([{ entity: 1, submesh: 0 }]);
    expect(f.c.frameState.pipelinePreparationPending).toBeUndefined();
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('requests the selected pipeline before a pending material binding blocks recording', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  f.add({ entity: 1, submeshes: 1 });
  const requested = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    expect(() =>
      recordGeometryDraws(
        f.c,
        pass,
        null,
        f.c.materialSlotIndices,
        1,
        f.meshGroup,
        f.meshGroup,
        () => {
          throw new Error('material texture is pending');
        },
        'forward',
      ),
    ).toThrow('material texture is pending');
    expect(requested).toHaveBeenCalled();
    expect(f.receipts).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('requests later material pipelines without binding an earlier pending pipeline', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  for (const entity of [1, 2]) {
    const entry = f.add({ entity, instances: 2, submeshes: 1 });
    entry.source.material.adopt({
      ...entry.source.material.snapshot,
      materialShaderId: `test::pending-${entity}`,
    });
  }
  const prepare = vi.fn().mockReturnValue(null);
  Object.assign(f.c.runtime, { prepareMaterialShaderPipelineEntry: prepare });
  f.acceptMaterials();
  const binding = vi.fn(() => {
    throw new Error('pending material must not bind');
  });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const vertices = vi.spyOn(pass, 'setVertexBuffer');
  const indices = vi.spyOn(pass, 'setIndexBuffer');
  const lookup = vi.fn((entity: number) => ({ slot: entity }));
  const lastInstance = vi.fn(() => 6);
  const takeUpload = vi.fn(() => ({ ranges: [], bytes: 0 }));
  Object.assign(f.c, {
    gpuDrivenScene: { instanceIndexForSlot: lastInstance, takeInstanceUpload: takeUpload },
    gpuDrivenSceneSlotForEntity: lookup,
  });
  Object.assign(f.c.pipelineState, {
    sceneDirectPipelineLayout: {},
    sceneDirectInstancesBindGroupLayout: {},
  });
  const record = (resolveBinding: Parameters<typeof recordGeometryDraws>[7]) =>
    recordGeometryDraws(
      f.c,
      pass,
      null,
      f.c.materialSlotIndices,
      1,
      f.meshGroup,
      f.meshGroup,
      resolveBinding,
      'forward',
    );
  try {
    expect(() => record(binding)).not.toThrow();
    expect(prepare.mock.calls.map(([shader]) => shader)).toEqual([
      'test::pending-1',
      'test::pending-2',
    ]);
    expect(lastInstance).toHaveBeenCalledTimes(2);
    expect(takeUpload).not.toHaveBeenCalled();
    expect(vertices).not.toHaveBeenCalled();
    expect(indices).not.toHaveBeenCalled();
    expect(binding).not.toHaveBeenCalled();
    expect(f.receipts).toEqual([]);
    expect(f.c.frameState.pipelinePreparationPendingReason).toMatchObject({
      code: 'material-pipeline-preparation',
      entity: 1,
      pass: 'forward',
    });
    delete f.c.frameState.pipelinePreparationPending;
    delete f.c.frameState.pipelinePreparationPendingReason;
    prepare.mockReturnValue({ pipeline: f.pipeline, group2Contract: 'mesh' });
    const readyBinding = vi.fn(fixtureMaterialBinding(f.materialGroup));
    record(readyBinding);
    expect(readyBinding).toHaveBeenCalledTimes(2);
    expect(takeUpload).not.toHaveBeenCalled();
    expect(f.receipts).toEqual([
      { entity: 1, submesh: 0 },
      { entity: 2, submesh: 0 },
    ]);
    expect(f.c.frameState.pipelinePreparationPending).toBeUndefined();
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('consumes alternating physical material addresses in direct and shadow encoders', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const entry = f.add({ entity: 1, submeshes: 1 });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const addresses: { slot: number; value: number[] | undefined }[] = [];
  const inputs = new Set<Uint32Array>();
  const bind = pass.setBindGroup.bind(pass);
  vi.spyOn(pass, 'setBindGroup').mockImplementation(
    (
      slot: number,
      group: BindGroup,
      data?: Uint32Array | readonly number[],
      start?: number,
      count?: number,
    ) => {
      if (data instanceof Uint32Array) {
        inputs.add(data);
        addresses.push({
          slot,
          value: Array.from(data.subarray(start, (start ?? 0) + (count ?? data.length))),
        });
        bind(slot, group, data, start ?? 0, count ?? data.length);
      } else {
        addresses.push({ slot, value: data === undefined ? undefined : [...data] });
        bind(slot, group, data);
      }
    },
  );
  const projected = vi.spyOn(environment, 'viewForPipeline').mockReturnValue(f.meshGroup);
  try {
    const direct = new IndirectPassBindings(pass, f.viewGroup, undefined, undefined, 768);
    direct.bindPipeline(f.pipeline, device);
    const offsets = [undefined, 0, 256, 512, 0, undefined];
    for (const address of offsets) direct.bindMaterial(f.materialGroup, address);
    const observed = offsets.map((address) => (address === undefined ? undefined : [address]));
    expect(addresses).toEqual([
      { slot: 0, value: [768] },
      ...observed.map((value) => ({ slot: 1, value })),
    ]);
    expect(inputs.size).toBe(1);
    expect([...inputs][0]?.length).toBe(1);
    addresses.length = 0;
    inputs.clear();
    const shadow = new ShadowDirectCommands(pass, null);
    for (const address of offsets)
      shadow.draw(
        f.pipeline,
        entry.mesh,
        f.materialGroup,
        address,
        { group: f.meshGroup, offsets: [0] },
        f.viewGroup,
        { first: 0, count: 3, baseVertex: 0 },
        1,
        0,
      );
    expect(addresses.filter(({ slot }) => slot === 1).map(({ value }) => value)).toEqual(observed);
    expect(shadow.count).toBe(offsets.length);
    expect(inputs.size).toBe(1);
    expect([...inputs][0]?.length).toBe(1);
    addresses.length = 0;
    inputs.clear();
    const skin = [256, 512, 768];
    const submit = () =>
      shadow.draw(
        f.pipeline,
        entry.mesh,
        f.materialGroup,
        undefined,
        { group: f.meshGroup, offsets: skin },
        f.viewGroup,
        { first: 0, count: 3, baseVertex: 0 },
        1,
        0,
      );
    submit();
    submit();
    skin[2] = 1024;
    submit();
    skin.length = 2;
    submit();
    skin[1] = 1280;
    submit();
    expect(addresses.filter(({ slot }) => slot === 2).map(({ value }) => value)).toEqual([
      [256, 512, 768],
      [256, 512, 1024],
      [256, 512],
      [256, 1280],
    ]);
    expect(inputs.size).toBe(1);
    expect([...inputs][0]?.length).toBe(3);
  } finally {
    projected.mockRestore();
    pass.end();
    f.dispose();
  }
});
