import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createPlaneGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import {
  Camera,
  ClippingPlanes,
  clippingPlanesData,
  MeshFilter,
  MeshRenderer,
  PlanarReflection,
  perspective,
  ReadonlyDynamicInputPage,
  type Renderer,
} from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as captureWebgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { createStandaloneRuntimeAssetBinding, type MaterialAsset } from '@forgeax/engine-types';
import { createServer, loadConfigFromFile } from 'vite';
import { expect, it } from 'vitest';
import { surfaceEvidenceGuid } from '../../../../apps/preview/src/surface-standard-evidence-identity';
import { createDevImportTransport } from '../dev-import-transport';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyPlanarMultiCamera } from './planar-multi-camera.fixture';

const PLANAR_REFLECTION_WARMUP_FRAMES = 60;

it('captures offscreen geometry, clips the opposite half space and records the water consumer', async () => {
  process.env.FORGEAX_SURFACE_ONLY = '1';
  mkdirSync('artifacts/planar-reflection/dawn', { recursive: true });
  const loaded = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    resolve('apps/preview/vite.config.ts'),
  );
  if (loaded === null) throw new Error('Preview configuration missing');
  const server = await createServer({
    ...loaded.config,
    configFile: false,
    root: resolve('apps/preview'),
    logLevel: 'error',
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local[0];
  if (baseUrl === undefined) throw new Error('Preview URL unavailable');
  const binding = createStandaloneRuntimeAssetBinding('preview');
  const liveBinding = {
    ...binding,
    catalogUrl: new URL(binding.catalogUrl, baseUrl).href,
    importUrlBase: new URL(binding.importUrlBase, baseUrl).href,
    packageUrlBase: new URL(binding.packageUrlBase, baseUrl).href,
  };
  const recorder = attachRecorder(captureWebgpu).unwrap();
  let nativeDevice: GPUDevice | undefined;
  let surface: GPUTexture | undefined;
  const nativeErrors: string[] = [];
  const canvas = {
    width: 256,
    height: 256,
    getContext: () => ({
      configure: ({ device, format }: { device: GPUDevice; format: GPUTextureFormat }) => {
        nativeDevice = device;
        device.addEventListener('uncapturederror', (event) =>
          nativeErrors.push(event.error.message),
        );
        surface = device.createTexture({
          size: [256, 256],
          format,
          usage: 0x10 | 1,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => surface,
    }),
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  let renderer: Renderer | undefined;
  try {
    const hostResult = await constructRuntimeRendererHost(
      canvas,
      { rhi: recorder.backend.rhi },
      {
        shaderManifestUrl: new URL('shaders/manifest.json', baseUrl).href,
        importTransport: createDevImportTransport(liveBinding),
      },
    );
    if (!hostResult.ok) throw hostResult.error;
    const host = hostResult.value;
    renderer = host.renderer;
    const errors: unknown[] = [];
    renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    const assets = host.assets;
    assets.configureRuntimeBinding(liveBinding);
    const deadline = Date.now() + 120_000;
    while (!(await assets.refreshCatalog())) {
      if (Date.now() > deadline) throw new Error('Planar catalog did not become ready');
      await new Promise((done) => setTimeout(done, 50));
    }
    const load = async (name: string) =>
      (
        await assets.loadByGuid<MaterialAsset>(
          assets.parseGuid(surfaceEvidenceGuid(`material/${name}`)),
        )
      ).unwrap();
    const [red, green, water] = await Promise.all([
      load('planar-red'),
      load('planar-green'),
      load('water-optical-zero-extinction'),
    ]);
    const world = new World();

    const box = world.allocSharedRef('MeshAsset', createBoxGeometry(1, 1, 1).unwrap());
    const spawnBox = (material: MaterialAsset, pos: number[]) =>
      world
        .spawn(
          { component: Transform, data: { pos } },
          { component: MeshFilter, data: { assetHandle: box } },
          {
            component: MeshRenderer,
            data: { materials: [world.allocSharedRef('MaterialAsset', material)] },
          },
        )
        .unwrap();
    spawnBox(red, [0, 4, -2]);
    const clipped = spawnBox(green, [0, -1, -2]);
    const waterEntity = world
      .spawn(
        {
          component: Transform,
          data: { quat: quat.fromEuler(quat.create(), -Math.PI / 2, 0, 0, 'XYZ') },
        },
        {
          component: MeshFilter,
          data: {
            assetHandle: world.allocSharedRef('MeshAsset', createPlaneGeometry(30, 30).unwrap()),
          },
        },
        {
          component: MeshRenderer,
          data: { materials: [world.allocSharedRef('MaterialAsset', water)] },
        },
      )
      .unwrap();
    const displayCamera = world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [0, 2, 5],
            quat: quat.fromLookAt(quat.create(), [0, 2, 5], [0, 0, -1], [0, 1, 0]),
          },
        },
        {
          component: Camera,
          data: {
            ...perspective({ fov: (55 * Math.PI) / 180, aspect: 1, near: 0.1, far: 40 }),
            clearColor: [0, 0, 0, 1],
          },
        },
        { component: ClippingPlanes, data: clippingPlanesData({ planes: [] }) },
      )
      .unwrap();
    const descriptor = {
      shape: '2d' as const,
      width: 128,
      height: 128,
      format: 'rgba8unorm' as const,
      sampleCount: 1 as const,
      mipLevels: 1 as const,
      sampled: true,
      readback: true,
    };
    const target = renderer.createRenderTarget(descriptor);
    if (!target.ok) throw target.error;
    world
      .addComponent(displayCamera, {
        component: PlanarReflection,
        data: { target: world.allocSharedRef('RenderTarget', target.value) },
      })
      .unwrap();
    const lease = renderer.attach(world);
    if (!lease.ok) throw lease.error;
    const schema = water.surface?.dynamicInput;
    if (schema === undefined) throw new Error('Water dynamic input schema missing');
    const page = ReadonlyDynamicInputPage.create({
      sourceId: 'planar-test',
      pageId: 1,
      schema,
    }).unwrap();
    page.reconfigureDevice(renderer.inspect().frame.deviceGeneration).unwrap();
    page.writeRecord(0, { position: [1000, 1000, 1000], time: 0, eventId: 1 }).unwrap();
    const range = page
      .reserveRange({
        domain: 'water-optical',
        recordStart: 0,
        recordCount: 1,
        instanceIndex: 0,
        member: {
          worldIdentity: world.identity,
          entityKey: waterEntity,
          drawItemIndex: 0,
          instanceOrdinal: 0,
        },
      })
      .unwrap();
    renderer.setSurfaceDynamicInput({ page, ranges: [range], projectionRevision: 1, frameTime: 0 });
    const activeRenderer = renderer;
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const frame = activeRenderer.draw({
        leases: [lease.value],
        camera: { lease: lease.value },
        environment: { lease: lease.value },
        geometryLane: 'direct',
      });
      if (!frame.ok) {
        const failure = JSON.stringify(
          { draw: frame.error, errors, nativeErrors },
          (_key, value) =>
            value instanceof Error
              ? { ...value, message: value.message, stack: value.stack }
              : value,
          2,
        );
        mkdirSync('artifacts/planar-reflection/dawn', { recursive: true });
        writeFileSync('artifacts/planar-reflection/dawn/failure.json', failure);
        throw new Error(failure);
      }
      const completed = await frame.value.completed;
      if (!completed.ok) throw completed.error;
      return frame.value;
    };
    for (let i = 0; i < PLANAR_REFLECTION_WARMUP_FRAMES; i++) {
      await draw();
    }
    const displayRed = async () => {
      const armed = activeRenderer.requestObservation?.(['linear-hdr']);
      if (armed === undefined || !armed.ok) throw new Error('HDR observation unavailable');
      const receipt = await draw();
      const result = await activeRenderer.observe(receipt, { include: ['linear-hdr'] });
      if (!result.ok) throw result.error;
      const observation = result.value.observations?.find((value) => value.domain === 'linear-hdr');
      if (observation === undefined) throw new Error('HDR pixels missing');
      const view = new DataView(
        observation.bytes.buffer,
        observation.bytes.byteOffset,
        observation.bytes.byteLength,
      );
      let count = 0;
      // Positive half floats preserve ordering. 0x211f is approximately 0.01.
      for (let y = 0; y < observation.metadata.height; y++) {
        for (let x = 0; x < observation.metadata.width; x++) {
          const offset = y * observation.metadata.bytesPerRow + x * 8;
          const r = view.getUint16(offset, true);
          const g = view.getUint16(offset + 2, true);
          const b = view.getUint16(offset + 4, true);
          if (r > 0x211f && r < 0x7c00 && g < 0x1000 && b < 0x1000) count++;
        }
      }
      return { count, bytes: observation.bytes };
    };
    const reflectedDisplay = await displayRed();
    const reflectedRedPixels = reflectedDisplay.count;
    expect(reflectedRedPixels).toBeGreaterThan(10);
    expect(errors).toEqual([]);
    expect(nativeErrors).toEqual([]);
    const capturing = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await draw();
    (await recorder.frameBoundary()).unwrap();
    const captured = (await capturing).unwrap();
    const tape = decodeTape(captured.bytes).unwrap();
    const model = buildFrameModel(tape);
    const artifactDir = resolve('artifacts/planar-reflection/dawn');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(resolve(artifactDir, 'water.rhitape'), captured.bytes);
    writeFileSync(resolve(artifactDir, 'frame.json'), JSON.stringify(model, null, 2));
    expect(
      renderer
        .inspect()
        .perFramePassNames.some((name) => name.startsWith('planar-reflection-face')),
    ).toBe(true);
    expect(renderer.inspect().perFramePassNames).toContain('single-layer-medium-color');
    const readTarget = async () => {
      const ticket = activeRenderer.requestTargetReadback(target.value, { mipLevel: 0 });
      if (!ticket.ok) throw ticket.error;
      const frame = await draw();
      const observed = await activeRenderer.observe(frame, {
        include: ['target-readbacks'],
        targetReadbacks: [ticket.value],
      });
      if (!observed.ok) throw observed.error;
      const readback = observed.value.targetReadbacks?.[0];
      if (readback === undefined) throw new Error('Target pixels missing');
      return readback;
    };
    const countColors = (bytes: Uint8Array) => {
      let red = 0,
        green = 0;
      for (let i = 0; i < bytes.length; i += 4) {
        if ((bytes[i] ?? 0) > 128 && (bytes[i + 1] ?? 0) < 10) red++;
        if ((bytes[i + 1] ?? 0) > 128 && (bytes[i] ?? 0) < 10) green++;
      }
      return { red, green };
    };
    const baseline = await readTarget();
    const baselineColors = countColors(baseline.bytes);
    writeFileSync(resolve(artifactDir, 'capture.rgba'), baseline.bytes);
    expect(baselineColors.red).toBeGreaterThan(10);
    expect(baselineColors.green).toBe(0);
    const waterWork = model.works.findLast((work) =>
      work.pipeline.shaders.some(
        (shader) =>
          shader.stage === 'fragment' && shader.source?.includes('PlanarReflectionUniform'),
      ),
    );
    if (waterWork === undefined) throw new Error('Water reflection consumer missing from RHI tape');
    const reflectionBinding = waterWork.bindings.find(
      (entry) => entry.groupIndex === 1 && entry.binding === 15,
    );
    const textureForView = (id: string | null | undefined) => {
      const descriptor = model.resources.find((resource) => resource.resourceId === id)?.descriptor;
      return descriptor !== null &&
        typeof descriptor === 'object' &&
        'kind' in descriptor &&
        descriptor.kind === 'createTextureView' &&
        'sourceHandleId' in descriptor &&
        typeof descriptor.sourceHandleId === 'string'
        ? descriptor.sourceHandleId
        : undefined;
    };
    const reflectionTexture = textureForView(reflectionBinding?.resourceId);
    if (reflectionTexture === undefined) throw new Error('Water reflection texture missing');
    const capturePass = model.passes.find((pass) =>
      pass.colorAttachmentViewHandleIds.some((id) => textureForView(id) === reflectionTexture),
    );
    const captureWork = capturePass?.workIndices.at(-1);
    if (captureWork === undefined) throw new Error('Planar capture contains no GPU draw');
    expect(waterWork.workIndex).toBeGreaterThan(captureWork);
    const adapter = await captureWebgpu.rhi.requestAdapter();
    if (!adapter.ok) throw adapter.error;
    const device = await adapter.value.requestDevice({
      requiredLimits: {
        maxSampledTexturesPerShaderStage:
          nativeDevice?.limits.maxSampledTexturesPerShaderStage ?? 16,
      },
      requiredFeatures: [...adapter.value.features].filter((feature) =>
        nativeDevice?.features.has(feature),
      ),
    });
    if (!device.ok) throw device.error;
    const replayDevice = captureWebgpu._internal_getRawDevice(device.value);
    replayDevice?.addEventListener('uncapturederror', (event) =>
      nativeErrors.push(event.error.message),
    );
    const replay = (
      await openReplay(tape, {
        device: device.value,
        createShaderModule: captureWebgpu.createShaderModule,
      })
    ).unwrap();
    try {
      const inspected = (
        await replay.inspectWork(captureWork, ['pipeline', 'bindings', 'pixels'])
      ).unwrap();
      const pixels = inspected.attachment;
      if (pixels === undefined) throw new Error('Replay attachment pixels unavailable');
      expect(countColors(pixels.bytes)).toEqual(baselineColors);
      expect(pixels.bytes).toEqual(baseline.bytes);
      writeFileSync(resolve(artifactDir, 'replay.rgba'), pixels.bytes);
      const waterPixels = (await replay.inspectWork(waterWork.workIndex, ['pixels'])).unwrap()
        .attachment;
      if (waterPixels === undefined) throw new Error('Replayed water pixels missing');
      expect(waterPixels.bytes).toEqual(reflectedDisplay.bytes);
      writeFileSync(resolve(artifactDir, 'water-replay.rgba16f'), waterPixels.bytes);
    } finally {
      (await replay.dispose()).unwrap();
      replayDevice?.destroy();
    }
    // Public display clipping must reach the reflected capture independently
    // of its oblique water plane, then restore when the view group is empty.
    world
      .set(
        displayCamera,
        ClippingPlanes,
        clippingPlanesData({
          planes: [[1, 0, 0, -1]],
          clipShadows: true,
        }),
      )
      .unwrap();
    const sectioned = countColors((await readTarget()).bytes);
    expect(sectioned.red).toBe(0);
    world.set(displayCamera, ClippingPlanes, clippingPlanesData({ planes: [] })).unwrap();
    const restored = countColors((await readTarget()).bytes);
    expect(restored.red).toBeGreaterThan(10);
    // Falsifier: moving the rejected green object above the plane must make it visible.
    world.set(clipped, Transform, { pos: [1, 1, -2] }).unwrap();
    const above = countColors((await readTarget()).bytes);
    expect(above.green).toBeGreaterThan(10);
    world.set(displayCamera, PlanarReflection, { updateIntervalFrames: 4 }).unwrap();
    const cadence: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      await draw();
      cadence.push(
        activeRenderer
          .inspect()
          .perFramePassNames.some((name) => name.startsWith('planar-reflection-face')),
      );
    }
    expect(cadence.filter(Boolean)).toHaveLength(2);
    const resized = activeRenderer.resizeRenderTarget(target.value, {
      ...descriptor,
      width: 64,
      height: 32,
    });
    if (!resized.ok) throw resized.error;
    await draw(); // Publish the resized generation before arming its readback.
    const small = await readTarget();
    expect(small.bytesPerRow).toBe(256);
    expect(small.bytes.byteLength).toBe(256 * 32);
    world
      .set(displayCamera, Transform, {
        quat: quat.fromLookAt(quat.create(), [0, 2, 5], [0, 10, 10], [0, 1, 0]),
      })
      .unwrap();
    await draw();
    expect(
      activeRenderer
        .inspect()
        .perFramePassNames.some((name) => name.startsWith('planar-reflection-face')),
    ).toBe(false);
    world
      .set(displayCamera, Transform, {
        quat: quat.fromLookAt(quat.create(), [0, 2, 5], [0, 0, -1], [0, 1, 0]),
      })
      .unwrap();
    await draw();
    expect(
      activeRenderer
        .inspect()
        .perFramePassNames.some((name) => name.startsWith('planar-reflection-face')),
    ).toBe(true);
    world.removeComponent(displayCamera, PlanarReflection).unwrap();
    await draw();
    expect(
      activeRenderer
        .inspect()
        .perFramePassNames.some((name) => name.startsWith('planar-reflection-face')),
    ).toBe(false);
    const disabledRedPixels = (await displayRed()).count;
    expect(disabledRedPixels).toBe(0);
    await verifyPlanarMultiCamera({
      world,
      renderer: activeRenderer,
      recorder,
      camera: displayCamera,
      target: target.value,
      marker: clipped,
      draw,
      save: (name, bytes) => writeFileSync(resolve(artifactDir, name), bytes),
    });
    expect(nativeErrors).toEqual([]);
    expect(errors).toEqual([]);
    writeFileSync(
      resolve(artifactDir, 'evidence.json'),
      JSON.stringify(
        {
          digest: captured.digest,
          captureWork,
          waterWork: waterWork.workIndex,
          baselineColors,
          sectioned,
          restored,
          reflectedRedPixels,
          disabledRedPixels,
          above,
          cadence,
          unseededResources: model.unseededResources,
        },
        null,
        2,
      ),
    );
  } finally {
    await renderer?.dispose();
    (await recorder.dispose()).unwrap();
    surface?.destroy();
    nativeDevice?.destroy();
    await server.close();
  }
}, 180_000);
