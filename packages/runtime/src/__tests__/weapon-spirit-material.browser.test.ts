import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
} from '@forgeax/engine-render';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { constructRuntimeRendererHost } from '../renderer-host';
import { drawPublished } from './draw-published';
import { testAssets } from './helpers/runtime-assets';

interface ShaderAttempt {
  label: string | undefined;
  characters: number;
  createdAtMs: number;
  infoRequests: number;
  infoStartedAtMs?: number;
  infoSettledAtMs?: number;
  messages?: readonly string[];
}

interface PipelineAttempt {
  label: string | undefined;
  vertexEntry: string | undefined;
  fragmentEntry: string | undefined;
  kind: 'sync' | 'async';
  startedAtMs: number;
  settledAtMs?: number;
  state: 'pending' | 'settled' | 'failed';
}

async function saveDiagnostic(name: string, value: unknown) {
  await commands.writeFile(
    `artifacts/ci-focus/weapon-spirit/${name}.json`,
    JSON.stringify(value, null, 2),
  );
}

async function saveTape(name: string, bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  await commands.writeFile(
    `artifacts/ci-focus/weapon-spirit/${name}.rhitape`,
    btoa(binary),
    'base64',
  );
}

async function saveFailureImage(canvas: HTMLCanvasElement, name: string, value: unknown) {
  await saveDiagnostic(name, value);
  const screenshot = await page.elementLocator(canvas).screenshot({ base64: true });
  await commands.writeFile(
    `artifacts/ci-focus/weapon-spirit/${name}.png`,
    typeof screenshot === 'string' ? screenshot : screenshot.base64,
    'base64',
  );
}

function assertToonAndShadowPixels(shadowed: ImageData, unshadowed: ImageData) {
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
}

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
  const errors: string[] = [];
  const pipelineEntries: string[] = [];
  const pipelineLabels: string[] = [];
  const shaderSources = new WeakMap<GPUShaderModule, string>();
  const shadowPipelineSources: string[] = [];
  const devices: GPUDevice[] = [];
  const attempts: PipelineAttempt[] = [];
  const shaderAttempts: ShaderAttempt[] = [];
  const adapters: unknown[] = [];
  const recorder = attachRecorder(webgpu).unwrap();
  const beginPipeline = (descriptor: GPURenderPipelineDescriptor, kind: 'sync' | 'async') => {
    const attempt: PipelineAttempt = {
      label: descriptor.label,
      vertexEntry: descriptor.vertex.entryPoint,
      fragmentEntry: descriptor.fragment?.entryPoint,
      kind,
      startedAtMs: performance.now(),
      state: 'pending',
    };
    attempts.push(attempt);
    return attempt;
  };
  navigator.gpu.requestAdapter = async (options) => {
    const adapter = await originalRequestAdapter(options);
    if (adapter === null) return adapter;
    adapters.push({
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
      description: adapter.info.description,
    });
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const device = await requestDevice(descriptor);
      devices.push(device);
      device.addEventListener('uncapturederror', (event) =>
        validationErrors.push(event.error.message),
      );
      const createShaderModule = device.createShaderModule.bind(device);
      device.createShaderModule = (descriptor) => {
        const attempt: ShaderAttempt = {
          label: descriptor.label,
          characters: descriptor.code.length,
          createdAtMs: performance.now(),
          infoRequests: 0,
        };
        shaderAttempts.push(attempt);
        const module = createShaderModule(descriptor);
        const getCompilationInfo = module.getCompilationInfo.bind(module);
        module.getCompilationInfo = async () => {
          attempt.infoRequests++;
          attempt.infoStartedAtMs = performance.now();
          try {
            const info = await getCompilationInfo();
            attempt.messages = info.messages.map(
              (message) => `${message.type}: ${message.message}`,
            );
            return info;
          } finally {
            attempt.infoSettledAtMs = performance.now();
          }
        };
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
        const attempt = beginPipeline(descriptor, 'sync');
        try {
          return createPipeline(descriptor);
        } catch (error) {
          attempt.state = 'failed';
          throw error;
        } finally {
          attempt.settledAtMs = performance.now();
          if (attempt.state === 'pending') attempt.state = 'settled';
        }
      };
      const createPipelineAsync = device.createRenderPipelineAsync.bind(device);
      device.createRenderPipelineAsync = async (descriptor) => {
        observeShadow(descriptor);
        pipelineLabels.push(descriptor.label ?? '<unlabelled>');
        pipelineEntries.push(descriptor.vertex.entryPoint ?? '<implicit>');
        const attempt = beginPipeline(descriptor, 'async');
        try {
          return await createPipelineAsync(descriptor);
        } catch (error) {
          attempt.state = 'failed';
          throw error;
        } finally {
          attempt.settledAtMs = performance.now();
          if (attempt.state === 'pending') attempt.state = 'settled';
        }
      };
      return device;
    };
    return adapter;
  };
  let renderer: Renderer | undefined;
  let unsubscribe: (() => void) | undefined;
  let firstReadyFailed = false;
  try {
    const host = await constructRuntimeRendererHost(
      canvas,
      {
        rhi: recorder.backend.rhi,
        rhiInstrumentation: {
          resolveSurfaceDevice: recorder.backend.unwrapDeviceForSurface,
        },
      },
      { shaderManifestUrl: '/shaders/manifest.json' },
    );
    if (!host.ok) throw host.error;
    renderer = host.value.renderer;
    unsubscribe = renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error.message);
    });
    const assets = host.value.assets;
    assets.configurePackIndex(
      engineShadow
        ? '/__weapon-spirit-engine-shadow/pack-index.json'
        : '/__weapon-spirit/pack-index.json',
    );
    const child = await assets.load(
      assets.parseGuid('4846fa5b-8f80-57c0-9cdc-e345102fdb6c'),
      'material',
    );
    if (!child.ok) throw child.error;
    const childContent = runtimeAssets(assets).borrow<MaterialAsset>(child.value).unwrap();
    const projection = assets.getMaterialProjectionForPayload(childContent);
    const shadowProgram = projection?.passes.find((pass) => pass.name === 'ShadowCaster')
      ?.programs[0];
    if (shadowProgram === undefined) throw new Error('published shadow program missing');
    const shadowArtifact = assets.getMaterialArtifact(shadowProgram.specializationKey);
    if (shadowArtifact === undefined) throw new Error('installed shadow artifact missing');
    const expectedShadowSource = new TextDecoder().decode(shadowArtifact.bytes);
    expect(projection?.specializationKey).toBeTruthy();
    expect(childContent.values).toMatchObject({
      emissionStrength: 0,
      pigmentStrength: 0,
      surfaceMetallic: 0,
      sideShade: 0.84,
    });
    const world = new World({ assets });
    const toon = child.value;
    const standard = testAssets(world)
      .create(Materials.standard({ baseColor: [0.6, 0.6, 0.6, 1] }))
      .unwrap();
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
          mapSize: testQuality.shadowMapSize,
          cascadeCount: testQuality.cascadeCount,
          shadowDistance: 50,
        },
      })
      .unwrap();
    world
      .spawn(
        { component: Transform, data: transform([0, 5, 5], [10, 0.1, 10]) },
        {
          component: MeshFilter,
          data: {
            assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
          },
        },
        { component: MeshRenderer, data: { materials: [standard] } },
      )
      .unwrap();
    for (const [index, material] of [toon, standard, toon].entries()) {
      world
        .spawn(
          { component: Transform, data: transform([(index - 1) * 2, 6, 5]) },
          {
            component: MeshFilter,
            data: {
              assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
            },
          },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    }
    const drawFrames = async (count: number) => {
      for (let frame = 0; frame < count; frame += 1) {
        const receipt = await drawPublished(host.value.renderer, world);
        if (!receipt.ok) throw receipt.error;
        const completed = await receipt.value.completed;
        if (!completed.ok) throw completed.error;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      await Promise.all(devices.map((device) => device.queue.onSubmittedWorkDone()));
    };
    const preserveFirstReadyFailure = async (originalFailure: unknown): Promise<never> => {
      firstReadyFailed = true;
      const stage = engineShadow ? 'engine-shadow' : 'authored-shadow';
      try {
        await saveFailureImage(canvas, `${stage}-failure`, {
          source: import.meta.env.VITE_FORGEAX_EVIDENCE_SOURCE_SHA,
          failure: String(originalFailure),
          inspection: renderer.inspect(),
          adapters,
          attempts,
          shaderAttempts,
          validationErrors,
          errors,
        });
        // Capture only after the unchanged first-ready owner has failed. This
        // extra submission cannot qualify or warm that original owner.
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const lease = renderer.attach(world).unwrap();
        const receipt = renderer
          .draw({ leases: [lease], camera: { lease }, environment: { lease } })
          .unwrap();
        const completed = await receipt.completed;
        (await recorder.frameBoundary()).unwrap();
        const captured = (await pending).unwrap();
        await saveTape(`${stage}-after-failure`, captured.bytes);
        await saveDiagnostic(`${stage}-after-failure`, {
          frameId: receipt.frameId,
          presentation: receipt.presentation,
          reason: receipt.presentationPendingReason,
          completed,
          inspection: renderer.inspect(),
          attempts,
          shaderAttempts,
        });
      } catch (captureFailure) {
        try {
          await saveDiagnostic(`${stage}-capture-error`, { error: String(captureFailure) });
        } catch {
          // Preserve the original first-ready error if evidence storage also fails.
        }
      }
      throw originalFailure;
    };
    await drawFrames(60).catch(preserveFirstReadyFailure);
    const shadowed = await readPresentedPixels(canvas);
    world.set(light, DirectionalLight, { castShadow: false }).unwrap();
    expect(world.get(light, DirectionalLight).unwrap().castShadow).toBe(false);
    await drawFrames(10);
    expect(renderer.inspect().perFramePassNames).not.toContain('shadowCascade0');
    const unshadowed = await readPresentedPixels(canvas);
    assertToonAndShadowPixels(shadowed, unshadowed);
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
    await saveDiagnostic(`success-${engineShadow}`, {
      source: import.meta.env.VITE_FORGEAX_EVIDENCE_SOURCE_SHA,
      adapters,
      attempts,
      shaderAttempts,
      inspection: renderer.inspect(),
    });
  } catch (error) {
    if (!firstReadyFailed) {
      try {
        await saveFailureImage(
          canvas,
          `${engineShadow ? 'engine-shadow' : 'authored-shadow'}-failure`,
          {
            source: import.meta.env.VITE_FORGEAX_EVIDENCE_SOURCE_SHA,
            failure: String(error),
            inspection: renderer?.inspect(),
            adapters,
            attempts,
            shaderAttempts,
            validationErrors,
            errors,
            pipelineEntries,
            pipelineLabels,
          },
        );
      } catch (captureError) {
        console.warn('Unable to retain weapon-spirit failure evidence:', captureError);
      }
    }
    throw error;
  } finally {
    navigator.gpu.requestAdapter = originalRequestAdapter;
    unsubscribe?.();
    renderer?.dispose();
    (await recorder.dispose()).unwrap();
    for (const device of devices) device.destroy();
    canvas.remove();
  }
}, 60_000);
