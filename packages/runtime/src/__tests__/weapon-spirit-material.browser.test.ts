import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { drawPublished } from './draw-published';

async function readPresentedPixels(canvas: HTMLCanvasElement) {
  const shot = await page.elementLocator(canvas).screenshot({ base64: true });
  const base64 = typeof shot === 'string' ? shot : shot.base64;
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = surface.getContext('2d');
  if (context === null) throw new Error('2D readback is required for pixel assertions');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, surface.width, surface.height);
}

it.each([
  false,
  true,
])('renders the ai-weapon-spirit child Toon through real WebGPU (Engine shadow: %s)', async (engineShadow) => {
  if (!navigator.gpu) throw new Error('WebGPU is required for the material regression');
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 256;
  document.body.append(canvas);
  const originalRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  const validationErrors: string[] = [];
  const pipelineEntries: string[] = [];
  const pipelineLabels: string[] = [];
  const shaderSources = new WeakMap<GPUShaderModule, string>();
  const shadowPipelineSources: string[] = [];
  const devices: GPUDevice[] = [];
  navigator.gpu.requestAdapter = async (options) => {
    const adapter = await originalRequestAdapter(options);
    if (adapter === null) return adapter;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const device = await requestDevice(descriptor);
      devices.push(device);
      device.addEventListener('uncapturederror', (event) =>
        validationErrors.push(event.error.message),
      );
      const createShaderModule = device.createShaderModule.bind(device);
      device.createShaderModule = (descriptor) => {
        const module = createShaderModule(descriptor);
        shaderSources.set(module, descriptor.code);
        return module;
      };
      const observeShadow = (descriptor: GPURenderPipelineDescriptor) => {
        if (
          descriptor.depthStencil?.format === 'depth32float' &&
          Array.from(descriptor.fragment?.targets ?? []).length === 0
        ) {
          const source = shaderSources.get(descriptor.vertex.module);
          if (source !== undefined) shadowPipelineSources.push(source);
        }
      };
      const createPipeline = device.createRenderPipeline.bind(device);
      device.createRenderPipeline = (descriptor) => {
        observeShadow(descriptor);
        pipelineLabels.push(descriptor.label ?? '<unlabelled>');
        pipelineEntries.push(descriptor.vertex.entryPoint ?? '<implicit>');
        return createPipeline(descriptor);
      };
      const createPipelineAsync = device.createRenderPipelineAsync.bind(device);
      device.createRenderPipelineAsync = async (descriptor) => {
        observeShadow(descriptor);
        pipelineLabels.push(descriptor.label ?? '<unlabelled>');
        pipelineEntries.push(descriptor.vertex.entryPoint ?? '<implicit>');
        return createPipelineAsync(descriptor);
      };
      return device;
    };
    return adapter;
  };
  let renderer: Renderer | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const host = await constructRuntimeRendererHost(
      canvas,
      {},
      { shaderManifestUrl: '/shaders/manifest.json' },
    );
    if (!host.ok) throw host.error;
    renderer = host.value.renderer;
    const errors: string[] = [];
    unsubscribe = renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error.message);
    });
    const assets = host.value.assets;
    assets.configurePackIndex(
      engineShadow
        ? '/__weapon-spirit-engine-shadow/pack-index.json'
        : '/__weapon-spirit/pack-index.json',
    );
    const child = await assets.loadByGuid<MaterialAsset>(
      assets.parseGuid('4846fa5b-8f80-57c0-9cdc-e345102fdb6c'),
    );
    if (!child.ok) throw child.error;
    const readiness = assets.getMaterialReadiness('4846fa5b-8f80-57c0-9cdc-e345102fdb6b');
    expect(
      readiness,
      `root material must publish one complete Ready generation: ${JSON.stringify(readiness)}`,
    ).toMatchObject({ status: 'Ready' });
    const projection = assets.getMaterialProjectionForPayload(child.value);
    const shadowProgram = projection?.passes.find((pass) => pass.name === 'ShadowCaster')
      ?.programs[0];
    if (shadowProgram === undefined) throw new Error('published shadow program missing');
    const shadowArtifact = assets.getMaterialArtifact(shadowProgram.specializationKey);
    if (shadowArtifact === undefined) throw new Error('installed shadow artifact missing');
    const expectedShadowSource = new TextDecoder().decode(shadowArtifact.bytes);
    expect(projection?.specializationKey).toBeTruthy();
    expect(child.value.values).toMatchObject({
      emissionStrength: 0,
      pigmentStrength: 0,
      surfaceMetallic: 0,
      sideShade: 0.84,
    });
    const world = new World();
    const toon = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', child.value);
    const standard = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      Materials.standard({ baseColor: [0.6, 0.6, 0.6, 1] }),
    );
    const transform = (
      pos: readonly [number, number, number],
      scale: readonly [number, number, number] = [1, 1, 1],
    ) => ({ pos, scale, quat: [0, 0, 0, 1] as const });
    world
      .spawn(
        { component: Transform, data: transform([0, 8, 18]) },
        {
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 1.5,
            near: 0.1,
            far: 100,
            clearColor: [0.02, 0.02, 0.03, 1],
          },
        },
      )
      .unwrap();
    const light = world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [0.25, -1, -0.45],
          color: [1, 1, 1],
          intensity: 1,
          castShadow: true,
          mapSize: 512,
          shadowDistance: 50,
        },
      })
      .unwrap();
    world
      .spawn(
        { component: Transform, data: transform([0, 5, 5], [10, 0.1, 10]) },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [standard] } },
      )
      .unwrap();
    for (const [index, material] of [toon, standard, toon].entries()) {
      world
        .spawn(
          { component: Transform, data: transform([(index - 1) * 2, 6, 5]) },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    }
    const drawFrames = async (count: number) => {
      for (let frame = 0; frame < count; frame += 1) {
        const receipt = drawPublished(host.value.renderer, world);
        if (!receipt.ok) throw receipt.error;
        const completed = await receipt.value.completed;
        if (!completed.ok) throw completed.error;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      await Promise.all(devices.map((device) => device.queue.onSubmittedWorkDone()));
    };
    await drawFrames(60);
    const shadowed = await readPresentedPixels(canvas);
    world.set(light, DirectionalLight, { castShadow: false }).unwrap();
    expect(world.get(light, DirectionalLight).unwrap().castShadow).toBe(false);
    await drawFrames(10);
    expect(renderer.inspect().perFramePassNames).not.toContain('shadowCascade0');
    const unshadowed = await readPresentedPixels(canvas);
    expect([unshadowed.width, unshadowed.height]).toEqual([shadowed.width, shadowed.height]);
    for (const [startX, endX] of [
      [0.29, 0.45],
      [0.55, 0.71],
    ] as const) {
      let toonPixels = 0;
      let shadowPixels = 0;
      for (let y = 0; y < shadowed.height; y += 1) {
        for (let x = Math.floor(shadowed.width * startX); x < shadowed.width * endX; x += 1) {
          const offset = (y * shadowed.width + x) * 4;
          const red = shadowed.data[offset] ?? 0;
          const green = shadowed.data[offset + 1] ?? 0;
          const blue = shadowed.data[offset + 2] ?? 0;
          if (green > red + 10 && blue > red + 5) toonPixels += 1;
          // Fixed camera receiver regions under the two Toon cubes exclude
          // the Standard cube's shadow, so its success cannot mask either caster.
          if (
            y > shadowed.height * 0.75 &&
            y < shadowed.height * 0.85 &&
            (unshadowed.data[offset] ?? 0) > red + 20
          )
            shadowPixels += 1;
        }
      }
      expect(toonPixels, `visible Toon pixels in region ${startX}`).toBeGreaterThan(30);
      expect(shadowPixels, `shadow contribution in region ${startX}`).toBeGreaterThan(10);
    }
    await Promise.all(devices.map((device) => device.queue.onSubmittedWorkDone()));
    expect(validationErrors, 'raw WebGPU validation messages').toEqual([]);
    expect(errors, 'renderer errors').toEqual([]);
    expect(
      pipelineEntries,
      `the authored shadow vertex entry must reach a real PSO: ${JSON.stringify(pipelineLabels)}`,
    ).toContain(engineShadow ? 'vs_main' : 'vs_shadow');
    expect(
      shadowPipelineSources,
      'the published shadow program must reach a depth-only PSO',
    ).toContain(expectedShadowSource);
  } finally {
    navigator.gpu.requestAdapter = originalRequestAdapter;
    unsubscribe?.();
    renderer?.dispose();
    for (const device of devices) device.destroy();
    canvas.remove();
  }
}, 60_000);
