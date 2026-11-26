import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  decodeMeshBinary,
  deriveVertexBufferLayoutFromProjection,
  deriveVertexLayoutProjection,
  packInterleavedVertexAttributes,
  packMeshBin,
} from '@forgeax/engine-geometry';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { toGpuVertexBufferLayouts } from '../assembly/webgpu-vertex-layouts';
import { GpuResidencyCache, type MeshGpuHandles } from '../device/gpu-residency';
import { bindMeshVertexStreams } from '../device/mesh-vertex-streams';
import { prepareAssetPatch } from '../publication/asset-patch';
import { worldRenderResources } from '../publication/resource-scope';
import { nativeDeviceFixture } from './native-device-fixture';

const shader = `
struct Output {
  @builtin(position) clip: vec4<f32>,
  @location(0) color: vec4<f32>,
};
@vertex fn vertex(
  @location(0) p: vec3<f32>,
  @location(1) n: vec3<f32>,
  @location(6) uv1: vec2<f32>,
  @location(13) color: vec4<f32>,
) -> Output {
  return Output(vec4<f32>(p.xy * 0.7, 0.5, 1.0), vec4<f32>(uv1.x, abs(n.z), color.b, 1));
}
@fragment fn fragment(in: Output) -> @location(0) vec4<f32> { return in.color; }
`;

it.each([
  'uint16',
  'uint32',
] as const)('produces identical native pixels with interleaved and split static streams and %s indices', async (indexFormat) => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const source = createBoxGeometry(2, 2, 2).unwrap();
  const color = new Float32Array(((source.attributes.position as Float32Array).length / 3) * 4);
  color.fill(0.5);
  const attributes = { ...source.attributes, color };
  const mesh = {
    ...source,
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, color.length / 4).unwrap().vertices,
    indices:
      indexFormat === 'uint16'
        ? new Uint16Array(source.indices ?? [])
        : new Uint32Array(source.indices ?? []),
  };
  const cooked = decodeMeshBinary(
    packMeshBin(mesh, 'box', [], 'static-streams').unwrap(),
    [],
    'native',
  );
  if (cooked?.attributeStorage !== 'static-streams') throw new Error('Missing Cook vertex streams');
  const assets = new AssetRegistry();
  const scope = worldRenderResources(new World({ assets }));
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const texture = device
    .createTexture({
      size: { width: 16, height: 16, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x11,
    })
    .unwrap();
  const readback = device.createBuffer({ size: 256 * 16, usage: 0x09 }).unwrap();
  try {
    const module = createShaderModuleImmediate(device, { code: shader }).unwrap();
    const layout = device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap();
    const prepare = (split: boolean, upload: MeshAsset = mesh) => {
      const handle = assets.create(structuredClone(mesh)).unwrap();
      return store
        .prepareMeshResidency(handle, upload, 1, scope, undefined, undefined, undefined, split)
        .unwrap();
    };
    const render = async (entry: MeshGpuHandles, count = entry.indexCount, firstIndex = 0) => {
      const buffers = toGpuVertexBufferLayouts(
        deriveVertexBufferLayoutFromProjection(entry.layoutProjection, { shaderUvSetCount: 2 }),
      );
      expect(buffers).toHaveLength(entry.vertexStreams === undefined ? 1 : 4);
      expect(entry.vertexStreams?.reduce((bytes, range) => bytes + range.size, 0)).toBe(
        entry.vertexStreams === undefined ? undefined : entry.vboBytes,
      );
      expect(entry.indexFormat).toBe(indexFormat);
      const pipeline = device
        .createRenderPipeline({
          layout,
          vertex: { module, entryPoint: 'vertex', buffers },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba8unorm' }] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
        })
        .unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: device.createTextureView(texture, {}).unwrap(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(pipeline);
      expect(bindMeshVertexStreams(pass, entry.vertexBuffer.handle, entry.vertexStreams)).toBe(
        buffers.length,
      );
      const index = entry.indexBuffer;
      if (index === null) throw new Error('Box indices were not uploaded');
      pass.setIndexBuffer(index.handle, indexFormat);
      pass.drawIndexed(count, 1, firstIndex);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture },
        { buffer: readback, bytesPerRow: 256 },
        { width: 16, height: 16, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await readback.mapAsync(1)).unwrap();
      const pixels = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
      return pixels;
    };
    const interleavedResident = prepare(false);
    const splitResident = prepare(true);
    expect(splitResident.entry.vertexStreams).toHaveLength(4);
    const write = vi.spyOn(device.queue, 'writeBuffer');
    const cookedHandle = assets.create(cooked).unwrap();
    const admitted = scope.resolveAsset<MeshAsset>(cookedHandle).unwrap();
    expect(admitted.attributeStorage).toBe('static-streams');
    const cookedResident = store.prepareMeshResidency(cookedHandle, admitted, 1, scope).unwrap();
    expect(
      write.mock.calls.some(([, offset, data]) => offset === 0 && data === admitted.vertices),
    ).toBe(true);
    write.mockRestore();
    const portableResident = prepare(false, cooked);
    const interleaved = await render(interleavedResident.entry);
    expect(equalBytes(interleaved, await render(cookedResident.entry))).toBe(true);
    expect(equalBytes(interleaved, await render(portableResident.entry))).toBe(true);
    cookedResident.lease.release();
    portableResident.lease.release();
    const split = await render(splitResident.entry);
    expect(split[8 * 256 + 8 * 4 + 1]).toBe(255);
    expect(split[8 * 256 + 8 * 4 + 2]).toBe(128);
    expect(equalBytes(interleaved, split)).toBe(true);
    interleavedResident.lease.release();
    splitResident.lease.release();

    // A canonical position patch may arrive after preloading physical streams.
    for (const splitGpu of [false, true]) {
      const local = new GpuResidencyCache();
      local.configureGpuDevice(device, undefined, device.caps);
      try {
        const handle = assets.create(mesh).unwrap();
        const published = structuredClone(cooked);
        const resident = local
          .prepareMeshResidency(
            handle,
            published,
            1,
            scope,
            undefined,
            undefined,
            undefined,
            splitGpu,
          )
          .unwrap();
        expect(resident.commit()).toBe(true);
        resident.lease.release();
        const stride = deriveVertexLayoutProjection(mesh.attributes).arrayStride;
        const count = mesh.vertices.byteLength / stride;
        const positions = new Float32Array(count * 3).fill(4);
        const patch = prepareAssetPatch(
          published,
          {
            handle,
            base: 1,
            revision: 2,
            fields: {},
            removed: [],
            ranges: [
              {
                path: ['vertices'],
                byteOffset: 0,
                byteLength: (count - 1) * stride + 12,
                rowBytes: 12,
                byteStride: stride,
                bytes: new Uint8Array(positions.buffer),
              },
            ],
          },
          false,
        );
        patch.commit();
        const writes = vi.spyOn(device.queue, 'writeBuffer');
        try {
          local.adoptMeshChange(patch.change, patch.value as MeshAsset, scope).unwrap();
          expect(writes.mock.calls).toHaveLength(1);
          if (splitGpu) expect(writes.mock.calls[0]?.[2].byteLength).toBe(positions.byteLength);
        } finally {
          writes.mockRestore();
        }
        const pixels = await render(resident.entry);
        expect(pixels[8 * 256 + 8 * 4 + 1]).toBe(0);
      } finally {
        local.destroyAll();
      }
    }

    const lowerHandle = assets.create(mesh).unwrap();
    const rootAttributes = {
      ...mesh.attributes,
      position: (mesh.attributes.position as Float32Array).map((value) => value * 0.5),
    };
    const root = {
      ...mesh,
      attributes: rootAttributes,
      vertices: packInterleavedVertexAttributes(rootAttributes, color.length / 4).unwrap().vertices,
      lods: [{ mesh: lowerHandle, screenCoverage: 0.5 }],
    };
    const rootHandle = assets.create(root).unwrap();
    const rootOnly = store.prepareMeshResidency(rootHandle, root, 2, scope).unwrap();
    expect(rootOnly.commit()).toBe(true);
    const lod = store.ensureResident(rootHandle, root, scope, [cooked]).unwrap();
    expect(lod).not.toBe(rootOnly.entry);
    expect(store.ensureResident(rootHandle, root, scope, [undefined]).unwrap()).toBe(lod);
    const sameRevision = store.prepareMeshResidency(rootHandle, root, 2, scope).unwrap();
    expect(sameRevision.entry).toBe(lod);
    sameRevision.lease.release();
    rootOnly.lease.release();
    expect(lod.vertexStreams).toHaveLength(4);
    expect(lod.vboBytes).toBe(mesh.vertices.byteLength * 2);
    const lowerRange = lod.lodRanges?.[1]?.[0];
    if (lowerRange === undefined) throw new Error('Missing lower LOD geometry');
    expect(lowerRange.first).toBe(mesh.indices.length);
    expect(equalBytes(await render(lod), interleaved)).toBe(false);
    expect(equalBytes(await render(lod, lowerRange.count, lowerRange.first), interleaved)).toBe(
      true,
    );
    const allRowsHandle = assets.create(root).unwrap();
    const rowsRoot = store.prepareMeshResidency(allRowsHandle, root, 1, scope).unwrap();
    expect(rowsRoot.commit()).toBe(true);
    try {
      const allRows = store.ensureResident(allRowsHandle, root, scope, [mesh]).unwrap();
      expect(allRows.vertexStreams).toHaveLength(4);
      expect(allRows.lodRanges).toEqual(lod.lodRanges);
      expect(
        equalBytes(await render(allRows, lowerRange.count, lowerRange.first), interleaved),
      ).toBe(true);
    } finally {
      rowsRoot.lease.release();
    }
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    device.destroyBuffer(readback).unwrap();
    device.destroyTexture(texture).unwrap();
    store.destroyAll();
    assets.dispose();
    native.destroy();
  }
});
