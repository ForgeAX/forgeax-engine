import { World } from '@forgeax/engine-ecs';
import {
  deriveVertexLayoutProjection,
  unpackInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import type { MeshAsset } from '@forgeax/engine-types';
import { assert, describe, expect, it } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { worldRenderResources } from '../publication/resource-scope';
import type { RecordProfileRunner } from '../record/render-context';
import { testAssets } from './helpers/runtime-assets';

describe('GpuResidencyCache mesh stride', () => {
  it('keeps the canonical 18F plus UV1 stride from the complete projection', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const store = new GpuResidencyCache();
    store.configureGpuDevice(device, undefined, device.caps);
    const mesh: MeshAsset = {
      kind: 'mesh',
      // The producer owns a canonical 20-float interleaved buffer:
      // 18F skinned data plus one additional UV set. Importers must publish
      // the complete map even when source accessors are sparse.
      vertices: new Float32Array(4 * 20),
      attributes: {
        position: new Float32Array(4 * 3),
        normal: new Float32Array(4 * 3),
        uv: new Float32Array(4 * 2),
        tangent: new Float32Array(4 * 4),
        skinIndex: new Uint16Array(4 * 4),
        skinWeight: new Float32Array(4 * 4),
        uv1: new Float32Array(4 * 2),
      },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: 4,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
      materialSlots: [{ slotName: 'default' }],
    };
    const world = new World();
    const assets = testAssets(world);
    const scope = worldRenderResources(world);
    const handle = assets.create(mesh).unwrap();

    const resident = store.ensureResident(handle, mesh, scope);

    expect(resident.ok).toBe(true);
    const entry = store.getMeshGpuHandles(handle, scope);
    expect(entry?.layoutProjection).toEqual(deriveVertexLayoutProjection(mesh.attributes));
    expect(entry?.layoutProjection.arrayStride).toBe(80);
    expect(entry?.vertexCount).toBe(4);
  });

  it('packs lower-detail geometry into shared buffers with distinct ranges', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const store = new GpuResidencyCache();
    store.configureGpuDevice(device, undefined, device.caps);
    const indexWrites: Uint8Array[] = [];
    const queue = device.queue;
    const writeBuffer = queue.writeBuffer.bind(queue);
    queue.writeBuffer = (buffer, bufferOffset, data, dataOffset, size) => {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (bytes.byteLength === 12) indexWrites.push(new Uint8Array(bytes));
      return writeBuffer(buffer, bufferOffset, data, dataOffset, size);
    };
    const attributes = {
      position: new Float32Array(9),
      normal: new Float32Array(9),
      uv: new Float32Array(6),
      tangent: new Float32Array(12),
    };
    const submesh = {
      indexOffset: 0,
      indexCount: 3,
      vertexCount: 3,
      topology: 'triangle-list' as const,
      materialSlot: 0,
    };
    const root: MeshAsset = {
      kind: 'mesh',
      vertices: new Float32Array(36),
      indices: new Uint16Array([0, 1, 2]),
      attributes,
      submeshes: [submesh],
      materialSlots: [{ slotName: 'default' }],
    };
    const lower: MeshAsset = {
      ...root,
      vertices: new Float32Array(36).fill(2),
      indices: new Uint16Array([0, 2, 1]),
    };
    const world = new World();
    const assets = testAssets(world);
    const scope = worldRenderResources(world);
    const handle = assets.create(root).unwrap();
    // The root can be pulled before the lower pack finishes loading. A later
    // call with the complete chain must upgrade the same cache key.
    const rootOnly = store.ensureResident(handle, root, scope);
    expect(rootOnly.ok).toBe(true);
    if (!rootOnly.ok) return;
    expect(rootOnly.value.lodRanges).toBeUndefined();

    const phases: string[] = [];
    const profile: RecordProfileRunner = (phase, action) => {
      phases.push(phase);
      return action();
    };
    const resident = store.ensureResident(handle, root, scope, [lower], profile);
    expect(phases).toEqual([
      'record/validation/residency/project',
      'record/validation/residency/pack',
      'record/validation/residency/vertex-key',
      'record/validation/residency/vertex-equality',
      'record/validation/residency/index-pack',
      'record/validation/residency/index-key',
      'record/validation/residency/index-equality',
      'record/validation/residency/vertex-buffer',
      'record/validation/residency/index-buffer',
      'record/validation/residency/vertex-write',
      'record/validation/residency/index-write',
      'record/validation/residency/ownership-copy',
    ]);
    expect(resident.ok).toBe(true);
    if (!resident.ok) return;
    expect(resident.value.vboBytes).toBe(root.vertices.byteLength + lower.vertices.byteLength);
    expect(resident.value.iboBytes).toBe(12);
    expect(resident.value.lodRanges).toEqual([
      [{ first: 0, count: 3, baseVertex: 0 }],
      [{ first: 3, count: 3, baseVertex: 0 }],
    ]);
    const packedIndices = indexWrites.at(-1);
    expect(packedIndices).toBeDefined();
    if (packedIndices === undefined) return;
    // Lower-level indices are rebased onto the packed vertex buffer, so every
    // range draws with baseVertex 0 (WebGL2 has no base-vertex draw).
    expect(new Uint16Array(packedIndices.buffer)).toEqual(new Uint16Array([0, 1, 2, 3, 5, 4]));

    // A stable chain remains an O(1) hit and does not replace the entry again.
    phases.length = 0;
    const stable = store.ensureResident(handle, root, scope, [lower], profile);
    expect(phases).toEqual([]);
    expect(stable.ok).toBe(true);
    if (stable.ok) expect(stable.value).toBe(resident.value);
  });

  it('refuses a payload whose bytes do not match the projected stride', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const store = new GpuResidencyCache();
    store.configureGpuDevice(device, undefined, device.caps);
    const mesh: MeshAsset = {
      kind: 'mesh',
      vertices: new Float32Array(49),
      attributes: {
        position: new Float32Array(9),
        normal: new Float32Array(9),
        uv: new Float32Array(6),
        tangent: new Float32Array(12),
      },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: 3,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
      materialSlots: [{ slotName: 'default' }],
    };
    const world = new World();
    const assets = testAssets(world);
    const scope = worldRenderResources(world);
    const handle = assets.create({ ...mesh, vertices: new Float32Array(36) }).unwrap();

    const resident = store.ensureResident(handle, mesh, scope);

    expect(resident.ok).toBe(false);
    if (!resident.ok) expect(resident.error.code).toBe('asset-not-registered');
    expect(store.getMeshGpuHandles(handle, scope)).toBeUndefined();
  });

  it('shares byte-identical vertices and rejects a colliding hash candidate', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const store = new GpuResidencyCache();
    store.configureGpuDevice(device, undefined, device.caps);
    const makeMesh = (words: Uint32Array, indices: Uint16Array): MeshAsset => {
      const vertices = new Float32Array(words.length);
      new Uint32Array(vertices.buffer).set(words);
      const attributes = unpackInterleavedVertexAttributes(
        vertices,
        deriveVertexLayoutProjection({
          position: new Float32Array(9),
          normal: new Float32Array(9),
          uv: new Float32Array(6),
          tangent: new Float32Array(12),
        }),
      );
      assert(attributes);
      return {
        kind: 'mesh',
        vertices,
        indices,
        attributes,
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 3,
            topology: 'triangle-list',
            materialSlot: 0,
          },
        ],
        materialSlots: [{ slotName: 'default' }],
      };
    };
    const firstWords = new Uint32Array(36);
    firstWords.set([3595022520, 3468143941]);
    const collidingWords = new Uint32Array(36);
    collidingWords.set([807225351, 2833037028]);
    const hashWords = (words: Uint32Array): number => {
      let hash = 2166136261;
      for (const word of words) hash = Math.imul(hash ^ word, 16777619);
      return hash >>> 0;
    };
    expect(hashWords(firstWords)).toBe(hashWords(collidingWords));
    const firstMesh = makeMesh(firstWords, new Uint16Array([0, 1, 2]));
    const sameMesh = makeMesh(new Uint32Array(firstWords), new Uint16Array([2, 1, 0]));
    const collidingMesh = makeMesh(collidingWords, new Uint16Array([0, 1, 2]));
    const world = new World();
    const assets = testAssets(world);
    const scope = worldRenderResources(world);
    const firstHandle = assets.create(firstMesh).unwrap();
    const sameHandle = assets.create(sameMesh).unwrap();
    const collidingHandle = assets.create(collidingMesh).unwrap();

    expect(store.ensureResident(firstHandle, firstMesh, scope).ok).toBe(true);
    expect(store.ensureResident(sameHandle, sameMesh, scope).ok).toBe(true);
    expect(store.ensureResident(collidingHandle, collidingMesh, scope).ok).toBe(true);

    const firstBuffer = store.getMeshGpuHandles(firstHandle, scope)?.vertexBuffer;
    expect(store.getMeshGpuHandles(sameHandle, scope)?.vertexBuffer).toBe(firstBuffer);
    expect(store.getMeshGpuHandles(collidingHandle, scope)?.vertexBuffer).not.toBe(firstBuffer);
  });
});
