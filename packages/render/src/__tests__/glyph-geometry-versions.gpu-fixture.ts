import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';
import { DEFAULT_MSDF_TEXT_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { assert, expect } from 'vitest';
import { samplerContribution } from '../assets/asset-decoders';
import { GpuResidencyCache } from '../device/gpu-residency';
import { GlyphSources } from '../glyph-source';
import { worldRenderResources } from '../publication/resource-scope';
import { nativeDeviceFixture } from './native-device-fixture';

/** Actual old/new Font layouts coexist in one submission, including cache eviction before submit. */
export async function verifyGlyphGeometryVersions() {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  assets.shaderRegistry.installMaterialArtifact('forgeax::msdf-text', {
    source: 'fn main() {}',
    paramSchema: DEFAULT_MSDF_TEXT_PARAM_SCHEMA,
  });
  const world = new World({ assets });
  const atlas = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      mips: { kind: 'none' },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      data: new Uint8Array([255, 255, 255, 255]),
    })
    .unwrap();
  const sampler = assets.create({ kind: 'sampler' }).unwrap();
  const metric = (width: number) => ({
    advance: width,
    bearingX: 0,
    bearingY: 0,
    size: { w: width, h: 2 },
    region: { x: 0, y: 0, w: 1, h: 1 },
  });
  const font = assets
    .create({
      kind: 'font',
      atlas,
      sampler,
      glyphs: { 65: metric(1) },
      common: {
        lineHeight: 2,
        base: 0,
        distanceRange: 1,
        pxRange: 1,
        atlasWidth: 1,
        atlasHeight: 1,
      },
    })
    .unwrap();
  const sources = new GlyphSources();
  const source = { font, text: 'A', size: 1, color: [1, 0, 0, 1] as const };
  const old = sources.resolve(worldRenderResources(world), source, assets).mesh;
  const oldGpu = store.ensureGeneratedMesh(old).unwrap();
  const observer = runtimeAssets(assets).observe().unwrap();
  observer.read().unwrap().accept();
  assets.update(font, { glyphs: { 65: metric(2) } }).unwrap();
  const change = observer.read().unwrap();
  sources.adopt(worldRenderResources(world), change.changes);
  change.accept();
  const next = sources.resolve(worldRenderResources(world), source, assets).mesh;
  const nextGpu = store.ensureGeneratedMesh(next).unwrap();
  expect(nextGpu.vertexBuffer).not.toBe(oldGpu.vertexBuffer);
  const shader = (
    await createShaderModule(device, {
      code: `
    @vertex fn vs(@location(0) p:vec3<f32>) -> @builtin(position) vec4<f32> {
      return vec4<f32>(p.xy - vec2<f32>(1.),0.,1.);
    }
    @fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.,0.,0.,1.); }
  `,
    })
  ).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap(),
      vertex: {
        module: shader,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 48, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        ],
      },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    })
    .unwrap();
  const target = device
    .createTexture({ size: { width: 16, height: 4 }, format: 'rgba8unorm', usage: 16 | 1 })
    .unwrap();
  const view = device.createTextureView(target, {}).unwrap();
  const readback = device.createBuffer({ size: 256 * 4, usage: 1 | 8 }).unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(pipeline);
    for (const [index, mesh] of [oldGpu, nextGpu].entries()) {
      assert(mesh.indexBuffer);
      pass.setViewport(index * 8, 0, 8, 4, 0, 1);
      pass.setVertexBuffer(0, mesh.vertexBuffer.handle);
      pass.setIndexBuffer(mesh.indexBuffer.handle, 'uint16');
      pass.drawIndexed(6);
    }
    pass.end();
    for (let index = 0; index < 257; index++) store.ensureGeneratedMesh({ ...next }).unwrap();
    expect(oldGpu.vertexBuffer.isDestroyed).toBe(false);
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: 4 },
      { width: 16, height: 4, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const completed = device.queue.onSubmittedWorkDone();
    store.trackMeshSubmission(completed);
    await completed;
    expect(oldGpu.vertexBuffer.isDestroyed).toBe(true);
    expect(nextGpu.vertexBuffer.isDestroyed).toBe(false);
    const mapping = (await readback.mapAsync(1)).unwrap();
    const pixels = new Uint8Array(mapping.getMappedRange().unwrap().slice(0));
    mapping.unmap();
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 16; x++)
        expect(Array.from(pixels.subarray(y * 256 + x * 4, y * 256 + x * 4 + 4))).toEqual(
          x >= 4 && x < 8 ? [0, 0, 0, 255] : [255, 0, 0, 255],
        );
    const restored = store.ensureGeneratedMesh(old).unwrap();
    expect(restored.vertexBuffer.isDestroyed).toBe(false);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    observer.dispose();
    assets.dispose();
    store.destroyAll();
    device.destroyBuffer(readback).unwrap();
    device.destroyTexture(target).unwrap();
    native.destroy();
  }
}
