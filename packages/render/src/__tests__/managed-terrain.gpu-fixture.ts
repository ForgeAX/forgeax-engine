import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { Terrain } from '@forgeax/engine-terrain';
import { standardSurfaceParameters } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { samplerContribution } from '../assets/asset-decoders';
import { Camera, DirectionalLight } from '../components';

export async function verifyRuntimeTerrain(encoding: 'weights' | 'ids', url: string) {
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  let format: GPUTextureFormat = 'rgba8unorm';
  const failures: unknown[] = [];
  const context = {
    configure(descriptor: GPUCanvasConfiguration) {
      device = descriptor.device;
      device.addEventListener('uncapturederror', (event) => failures.push(event.error));
      format = descriptor.format;
      target?.destroy();
      target = device.createTexture({
        size: [64, 64],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: descriptor.viewFormats ?? [],
      });
    },
    getCurrentTexture() {
      if (target === undefined) throw new Error('Missing configured target');
      return target;
    },
    unconfigure() {},
  };
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: (kind: string) => (kind === 'webgpu' ? context : null) },
    undefined,
    { shaderManifestUrl: url },
    {
      rhi,
      createShaderModule: (device, descriptor) => rhi.createShaderModule(device, descriptor),
      createShaderModuleImmediate: (device, descriptor) =>
        rhi.createShaderModuleImmediate(device, descriptor),
    },
  );
  renderer.onError((error) => failures.push(error));
  const initialized = await renderer.initialization;
  assert(initialized.ok, initialized.ok ? undefined : initialized.error.message);
  const assets = renderer.assetRegistry;
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const world = new World({ assets });
  const attached = renderer.attach(world);
  assert(attached.ok, attached.ok ? undefined : attached.error.message);
  const lease = attached.value;
  registerPropagateTransforms(world);
  world.components.register(Terrain).unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0.1, -1, 0.2],
        intensity: 0.05,
        mapSize: 128,
        cascadeCount: 1,
        shadowDistance: 8,
      },
    })
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 3, 0], quat: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] } },
      { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: 0 } },
    )
    .unwrap();
  const layerImage = assets
    .create({
      kind: 'texture',
      format: 'rgba8unorm',
      colorSpace: 'linear',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      mips: { kind: 'none' },
      data: new Uint8Array([255, 255, 255, 255]),
    })
    .unwrap();
  const layers = [
    [1, 0, 0],
    [0, 1, 0],
  ].map((color) =>
    assets
      .create({
        kind: 'material',
        parameters: standardSurfaceParameters([
          { name: 'baseColorTexture', type: 'texture' },
          { name: 'emissiveTexture', type: 'texture' },
        ]),
        colorSpace: 'linear',
        values: {
          baseColor: [...color, 1],
          emissive: color,
          emissiveIntensity: 1,
          baseColorTexture: layerImage,
          emissiveTexture: layerImage,
        },
        passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
      })
      .unwrap(),
  );
  const root = assets
    .create({
      kind: 'terrain',
      columns: 2,
      rows: 2,
      subsectionVertices: 2,
      spacing: 2,
      heights: new Float32Array(4),
      weights: new Float32Array([1, 0, 1, 0, 1, 0, 1, 0]),
      layers: layers.map((material) => ({ material, blend: 'weight' as const })),
      materialEncoding:
        encoding === 'ids' ? { kind: 'ids', maxWeightError: 0.01 } : { kind: 'weights' },
    })
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: { pos: [-1, 0, -1] } },
      { component: Terrain, data: { asset: root, forcedLod: 0 } },
    )
    .unwrap();
  const read = async () => {
    for (let frame = 0; frame < 20; frame++) {
      world.update().unwrap();
      const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
      assert(
        drawn.ok,
        drawn.ok ? undefined : `${drawn.error.message}: ${JSON.stringify(failures)}`,
      );
      if (device === undefined) throw new Error('Missing configured GPU device');
      await device.queue.onSubmittedWorkDone();
    }
    if (device === undefined || target === undefined)
      throw new Error('Missing configured GPU target');
    const nativeDevice = device,
      renderTarget = target;
    const buffer = nativeDevice.createBuffer({
      size: 64 * 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = nativeDevice.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: renderTarget }, { buffer, bytesPerRow: 256 }, [64, 64]);
    nativeDevice.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(buffer.getMappedRange());
    const samples = [24, 40].map((x) => {
      const offset = 32 * 256 + x * 4;
      return [
        pixels[offset + (format.startsWith('bgra') ? 2 : 0)],
        pixels[offset + 1],
        pixels[offset + (format.startsWith('bgra') ? 0 : 2)],
      ];
    });
    buffer.unmap();
    buffer.destroy();
    return samples;
  };
  try {
    const before = await read();
    assets.update(root, { weights: new Float32Array([0, 1, 0, 1, 0, 1, 0, 1]) }).unwrap();
    const after = await read();
    for (const sample of before) {
      expect(sample[0]).toBeGreaterThan(150);
      expect(sample[1]).toBeLessThan(30);
    }
    for (const sample of after) {
      expect(sample[1]).toBeGreaterThan(150);
      expect(sample[0]).toBeLessThan(30);
    }
    assets.update(root, { heights: new Float32Array(4).fill(0.25) }).unwrap();
    const elevated = await read();
    for (const sample of elevated) {
      expect(sample[1]).toBeGreaterThan(150);
      expect(sample[0]).toBeLessThan(30);
    }
    const greenLayer = layers[1];
    assert(greenLayer);
    assets
      .update(greenLayer, { values: { baseColor: [0, 0, 1, 1], emissive: [0, 0, 1] } })
      .unwrap();
    for (const sample of await read()) {
      expect(sample[2]).toBeGreaterThan(150);
      expect(sample[1]).toBeLessThan(30);
    }
    assets
      .writeRange(layerImage, {
        origin: { x: 0, y: 0 },
        size: { width: 1, height: 1 },
        data: new Uint8Array([0, 0, 0, 255]),
      })
      .unwrap();
    for (const sample of await read())
      for (const channel of sample) expect(channel).toBeLessThan(30);
    assets
      .update(layerImage, {
        shape: { viewDimension: '2d', extent: { width: 2, height: 1 } },
        data: new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]),
      })
      .unwrap();
    for (const sample of await read()) {
      expect(sample[2]).toBeGreaterThan(150);
      expect(sample[1]).toBeLessThan(30);
    }
    expect(world.get(entity, Terrain).unwrap().asset).toBe(root);
    expect(failures).toEqual([]);
  } finally {
    const disposed = renderer.dispose();
    assert(disposed.ok, disposed.ok ? undefined : disposed.error.message);
    target?.destroy();
  }
}
