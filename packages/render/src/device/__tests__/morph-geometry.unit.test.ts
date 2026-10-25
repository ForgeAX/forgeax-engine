import {
  createBoxGeometry,
  deriveVertexCount,
  deriveVertexLayoutProjection,
} from '@forgeax/engine-geometry';
import { err, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import type { MeshAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GpuBuffer } from '../../gpu-resource';
import type { MorphSnapshot } from '../../render-system-extract';
import { morphLocalAabb } from '../../render-system-extract-tail';
import { DeviceScope } from '../device-scope';
import type { MeshGpuHandles } from '../gpu-residency';
import { MorphGeometry, type MorphGeometryInput } from '../morph-geometry';

const devices: RhiDevice[] = [];
afterEach(() => {
  devices.length = 0;
});

async function setup(compute = true) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  devices.push(device);
  const caps = device.caps;
  const scoped = compute
    ? device
    : (Object.create(device, {
        caps: { get: () => ({ ...caps, compute: false }) },
      }) as RhiDevice);
  const box = createBoxGeometry(1, 1, 1).unwrap();
  const positions = box.attributes.position as Float32Array;
  const mesh: MeshAsset = {
    ...box,
    morphTargets: [
      { position: Float32Array.from(positions, (_, index) => (index % 3 === 0 ? 0.5 : 0)) },
      { position: Float32Array.from(positions, (_, index) => (index % 3 === 1 ? -1 : 0)) },
    ],
  };
  const layoutProjection = deriveVertexLayoutProjection(mesh.attributes);
  const vertexCount = deriveVertexCount(mesh.vertices, layoutProjection) as number;
  const buffer = device
    .createBuffer({ size: mesh.vertices.byteLength, usage: 0x20 | 0x08 })
    .unwrap();
  const base = {
    contentEpoch: 0,
    vertexBuffer: new GpuBuffer(device, buffer),
    indexBuffer: null,
    vboBytes: mesh.vertices.byteLength,
    iboBytes: 0,
    indexCount: 0,
    indexFormat: 'uint16',
    layoutProjection,
    uvSetCount: 1,
    vertexCount,
    indexed: false,
    topology: 'triangle-list',
    submeshes: [],
    lodRanges: [[{ first: 0, count: 36, baseVertex: 0 }]],
  } as unknown as MeshGpuHandles;
  const input: MorphGeometryInput = {
    device: scoped,
    scope: DeviceScope.create(0, 'morph-test'),
    factory: { createShaderModule: (desc) => rhi.createShaderModuleImmediate(device, desc) },
    reportError: (error) => {
      throw error;
    },
  };
  const morph = (...weights: number[]): MorphSnapshot => ({
    weights: new Float32Array(weights),
    targetCount: weights.length,
  });
  return { device, input, mesh, base, morph, vertexCount };
}

describe('MorphGeometry', () => {
  it('uploads targets once per Mesh, weights once per change, and retains stable handles', async () => {
    const { device, input, mesh, base, morph } = await setup();
    const store = new MorphGeometry();
    const writes = vi.spyOn(device.queue, 'writeBuffer');
    const first = morph(0.5, 0);
    const handles = store.resolve(input, 1, base, first, () => mesh);
    expect(handles).toBeDefined();
    expect(handles?.vertexBuffer).not.toBe(base.vertexBuffer);
    expect(handles?.lodRanges).toBeUndefined();
    expect(store.stats).toMatchObject({ sourceUploads: 1, outputsCreated: 1, weightUploads: 1 });
    const work = store.prepare(device, input.reportError);
    expect(work).toBeDefined();
    work?.complete(true);
    expect(store.stats.dispatches).toBe(1);

    // Unchanged rows cost one identity check: no write and no dispatch.
    const steady = writes.mock.calls.length;
    for (let frame = 0; frame < 4; frame++) {
      expect(store.resolve(input, 1, base, first, () => mesh)).toBe(handles);
      expect(store.prepare(device, input.reportError)).toBeUndefined();
    }
    // A re-extracted snapshot with equal weights still uploads nothing.
    expect(store.resolve(input, 1, base, morph(0.5, 0), () => mesh)).toBe(handles);
    expect(writes.mock.calls.length).toBe(steady);

    // A weight change writes only that entity's weight row and dispatches it once.
    expect(store.resolve(input, 1, base, morph(0.25, 1), () => mesh)).toBe(handles);
    expect(writes.mock.calls.length).toBe(steady + 1);
    expect(store.stats.weightUploads).toBe(2);
    store.prepare(device, input.reportError)?.complete(true);
    expect(store.stats.dispatches).toBe(2);

    // A second entity on the same Mesh shares its target source.
    const other = store.resolve(input, 2, base, morph(1, 1), () => mesh);
    expect(other).not.toBe(handles);
    expect(store.stats).toMatchObject({ sourceUploads: 1, outputsCreated: 2, weightUploads: 3 });
    expect(store.stats.cpuDeformations).toBe(0);
    store.dispose(input.reportError);
    writes.mockRestore();
  });

  it('keeps a deformation pending until its submission succeeds', async () => {
    const { device, input, mesh, base, morph } = await setup();
    const store = new MorphGeometry();
    store.resolve(input, 1, base, morph(1, 0), () => mesh);
    store.prepare(device, input.reportError)?.complete(false);
    expect(store.stats.dispatches).toBe(0);
    store.resolve(input, 1, base, morph(1, 0), () => mesh);
    const retry = store.prepare(device, input.reportError);
    expect(retry).toBeDefined();
    retry?.complete(true);
    expect(store.stats.dispatches).toBe(1);
    store.dispose(input.reportError);
  });

  it('deforms positions on the CPU when compute is unavailable', async () => {
    const { device, input, mesh, base, morph, vertexCount } = await setup(false);
    const store = new MorphGeometry();
    const writes = vi.spyOn(device.queue, 'writeBuffer');
    const handles = store.resolve(input, 1, base, morph(0.5, 0.25), () => mesh);
    expect(store.stats).toMatchObject({ cpuDeformations: 1, weightUploads: 0, sourceUploads: 0 });
    expect(store.prepare(device, input.reportError)).toBeUndefined();
    const call = writes.mock.calls.at(-1);
    expect(call?.[0]).toBe(handles?.vertexBuffer.handle);
    const written = call?.[2] as Float32Array;
    const stride = base.layoutProjection.arrayStride / 4;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const at = vertex * stride;
      expect(written[at]).toBeCloseTo((mesh.vertices[at] as number) + 0.25, 6);
      expect(written[at + 1]).toBeCloseTo((mesh.vertices[at + 1] as number) - 0.25, 6);
      expect(written[at + 2]).toBe(mesh.vertices[at + 2]);
      // Non-position attributes keep the Mesh stream.
      expect(written[at + 3]).toBe(mesh.vertices[at + 3]);
    }
    store.dispose(input.reportError);
    writes.mockRestore();
  });

  it('retires rows no draw resolved and recreates rows whose Mesh handles changed', async () => {
    const { device, input, mesh, base, morph } = await setup();
    const store = new MorphGeometry();
    const destroy = vi.spyOn(device, 'destroyBuffer');
    const weights = morph(1, 0);
    const first = store.resolve(input, 1, base, weights, () => mesh);
    store.resolve(input, 2, base, weights, () => mesh);
    // Entity 2 is never resolved again; entity 1 keeps being drawn.
    for (let submission = 0; submission < 10; submission++) {
      store.resolve(input, 1, base, weights, () => mesh);
      store.prepare(device, input.reportError)?.complete(true);
    }
    expect(store.size).toBe(1);
    // Output + weight row of the retired entity; the shared target source stays.
    expect(destroy).toHaveBeenCalledTimes(2);
    const replaced = { ...base } as MeshGpuHandles;
    const next = store.resolve(input, 1, replaced, weights, () => mesh);
    expect(next).not.toBe(first);
    expect(store.stats.sourceUploads).toBe(2);
    store.dispose(input.reportError);
    destroy.mockRestore();
  });

  it('deforms on the CPU while the compute module compiles, then moves to compute', async () => {
    const { device, input, mesh, base, morph } = await setup();
    const store = new MorphGeometry();
    let compiled = false;
    const pendingFactory: MorphGeometryInput = {
      ...input,
      factory: {
        createShaderModule: (desc) =>
          compiled
            ? rhi.createShaderModuleImmediate(device, desc)
            : err(
                new RhiError({
                  code: 'rhi-not-available',
                  expected: 'a compiled morph module',
                  hint: 'retry after compilation',
                }),
              ),
      },
    };
    store.resolve(pendingFactory, 1, base, morph(1, 0), () => mesh);
    expect(store.stats).toMatchObject({ cpuDeformations: 1, sourceUploads: 0 });
    compiled = true;
    store.resolve(pendingFactory, 1, base, morph(0, 1), () => mesh);
    expect(store.stats).toMatchObject({ cpuDeformations: 1, sourceUploads: 1, weightUploads: 1 });
    store.prepare(device, input.reportError)?.complete(true);
    expect(store.stats.dispatches).toBe(1);
    store.dispose(input.reportError);
  });

  it('declines meshes whose targets do not match the snapshot', async () => {
    const { input, mesh, base, morph } = await setup();
    const store = new MorphGeometry();
    expect(store.resolve(input, 1, base, morph(1), () => mesh)).toBeUndefined();
    expect(store.size).toBe(0);
  });
});

describe('morphLocalAabb', () => {
  it('encloses every weighted target delta, including negative weights', () => {
    const mesh = {
      morphTargets: [
        { position: new Float32Array([0.5, 0, 0, -0.25, 0, 0]) },
        { position: new Float32Array([0, 2, 0, 0, -1, 0]) },
      ],
    };
    const bounds = morphLocalAabb([-1, -1, -1, 1, 1, 1], mesh, {
      weights: new Float32Array([1, -0.5]),
      targetCount: 2,
    });
    expect(bounds[0]).toBeLessThanOrEqual(-1.25);
    expect(bounds[3]).toBeGreaterThanOrEqual(1.5);
    expect(bounds[1]).toBeLessThanOrEqual(-2);
    expect(bounds[4]).toBeGreaterThanOrEqual(1.5);
    expect(bounds[2]).toBe(-1);
    expect(bounds[5]).toBe(1);
    expect(bounds[0]).toBeCloseTo(-1.25, 6);
    expect(bounds[4]).toBeCloseTo(1.5, 6);
  });
});
