import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { drawPublished } from './draw-published';

it.each([
  'opaque',
  'mixed',
  'transparent',
])('draws every selected material Pass with blending=%s', async (mode) => {
  if (!navigator.gpu) throw new Error('WebGPU is required');
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 256;
  document.body.append(canvas);
  const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  const validation: string[] = [];
  const entries: string[] = [];
  const depthWrites: boolean[] = [];
  const devices: GPUDevice[] = [];
  navigator.gpu.requestAdapter = async (options) => {
    const adapter = await requestAdapter(options);
    if (adapter === null) return adapter;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const device = await requestDevice(descriptor);
      devices.push(device);
      device.addEventListener('uncapturederror', (event) => validation.push(event.error.message));
      const record = (descriptor: GPURenderPipelineDescriptor) => {
        entries.push(`${descriptor.vertex.entryPoint}/${descriptor.fragment?.entryPoint}`);
        if (
          descriptor.vertex.entryPoint === 'vs_right' &&
          descriptor.fragment?.entryPoint === 'fs_blue'
        ) {
          depthWrites.push(descriptor.depthStencil?.depthWriteEnabled ?? true);
        }
      };
      const create = device.createRenderPipeline.bind(device);
      device.createRenderPipeline = (descriptor) => {
        record(descriptor);
        return create(descriptor);
      };
      const createAsync = device.createRenderPipelineAsync.bind(device);
      device.createRenderPipelineAsync = async (descriptor) => {
        record(descriptor);
        return createAsync(descriptor);
      };
      return device;
    };
    return adapter;
  };
  const host = await constructRuntimeRendererHost(
    canvas,
    {},
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!host.ok) {
    navigator.gpu.requestAdapter = requestAdapter;
    canvas.remove();
    throw host.error;
  }
  const errors: string[] = [];
  const unsubscribe = host.value.renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error.message);
  });
  try {
    const assets = host.value.assets;
    assets.configurePackIndex(
      mode === 'transparent'
        ? '/__material-programs-transparent/pack-index.json'
        : mode === 'mixed'
          ? '/__material-programs-mixed/pack-index.json'
          : '/__material-programs/pack-index.json',
    );
    const material = (
      await assets.loadByGuid<MaterialAsset>(
        assets.parseGuid('8f50ae65-6e0a-40b4-8949-b47006edab90'),
      )
    ).unwrap();
    const projection = assets.getMaterialProjectionForPayload(material);
    if (projection === undefined) throw new Error('material projection is missing');
    const programs = projection.passes.flatMap((pass) => pass.programs);
    const capabilities = [...new Set(programs.map((program) => program.context.capability))];
    expect(capabilities.sort()).toEqual([
      'storage-buffer',
      'storage-buffer-atmosphere',
      'storage-buffer-minimum',
      'storage-buffer-projector',
      'uniform-fallback',
    ]);
    // Left and Center/Right retain distinct programs for each published
    // backend/capability pair, including both uniform fallback backends.
    for (const capability of capabilities) {
      const selected = programs.filter((program) => program.context.capability === capability);
      const backends = [...new Set(selected.map((program) => program.context.backend))];
      expect(backends.sort()).toEqual(
        capability === 'uniform-fallback' ? ['webgl2', 'webgpu'] : ['webgpu'],
      );
      for (const backend of backends)
        expect(
          new Set(
            selected
              .filter((program) => program.context.backend === backend)
              .map((program) => program.specializationKey),
          ).size,
        ).toBe(2);
    }
    const world = new World();
    const handle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', material);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3], scale: [1, 1, 1], quat: [0, 0, 0, 1] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 1.5,
            near: 0.1,
            far: 100,
            clearColor: [0.02, 0.02, 0.02, 1],
          },
        },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], scale: [1, 1, 1], quat: [0, 0, 0, 1] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [handle] } },
      )
      .unwrap();
    for (let frame = 0; frame < 40; frame++) {
      const receipt = await drawPublished(host.value.renderer, world);
      if (!receipt.ok) throw receipt.error;
      const completed = await receipt.value.completed;
      if (!completed.ok) throw completed.error;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    await Promise.all(devices.map((device) => device.queue.onSubmittedWorkDone()));
    const shot = await page.elementLocator(canvas).screenshot({ base64: true });
    const bytes = Uint8Array.from(atob(typeof shot === 'string' ? shot : shot.base64), (char) =>
      char.charCodeAt(0),
    );
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = surface.getContext('2d');
    if (ctx === null) throw new Error('pixel readback unavailable');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = ctx.getImageData(0, 0, surface.width, surface.height);
    for (const [fraction, channel] of [
      [0.2, 0],
      [0.5, 1],
      [0.8, 2],
    ] as const) {
      const offset =
        (Math.floor(surface.height * 0.5) * surface.width + Math.floor(surface.width * fraction)) *
        4;
      const color = [...pixels.data.slice(offset, offset + 3)];
      expect(color[channel], `Pass color at ${fraction}: ${color}`).toBeGreaterThan(200);
      expect(color.filter((_, index) => index !== channel).every((value) => value < 40)).toBe(true);
    }
    expect(entries).toContain('vs_right/fs_blue');
    if (mode !== 'opaque') expect(depthWrites).toContain(false);
    expect(validation).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    host.value.renderer.dispose();
    for (const device of devices) device.destroy();
    navigator.gpu.requestAdapter = requestAdapter;
    canvas.remove();
  }
}, 60_000);
