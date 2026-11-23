import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  decodeMeshBinary,
  deriveVertexBufferLayoutFromProjection,
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
    const cookedResident = prepare(true, cooked);
    expect(
      write.mock.calls.some(([, offset, data]) => offset === 0 && data === cooked.vertices),
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
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    device.destroyBuffer(readback).unwrap();
    device.destroyTexture(texture).unwrap();
    store.destroyAll();
    assets.dispose();
    native.destroy();
  }
});
