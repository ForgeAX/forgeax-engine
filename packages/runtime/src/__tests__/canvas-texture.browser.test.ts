import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import {
  Camera,
  CanvasTexture,
  createRenderPublisher,
  Materials,
  MeshFilter,
  MeshRenderer,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  encodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it, onTestFailed } from 'vitest';
import { commands, page } from 'vitest/browser';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { renderValue } from './standard-gbuffer-replay.fixture';

async function save(name: string, bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  await commands.writeFile(`artifacts/canvas-texture/${name}`, btoa(binary), 'base64');
}

// Exercise every source transport on the UV-sensitive quad. Publication also
// owns the ordinary mesh path; repeating that path for both canvas classes adds
// no new upload, resize, recovery or replay boundary.
it.each([
  'html-quad',
  'offscreen-quad',
  'published-quad',
  'published',
] as const)('Canvas %s material updates, resizes, recovers and replays on a fresh device', async (kind) => {
  let phase = 'case-entry';
  const observe = (next: string, event: 'milestone' | 'failure' = 'milestone') => {
    phase = next;
    // biome-ignore lint/suspicious/noConsole: Bounded CI phase evidence survives missing failure artifacts.
    console.log(
      `[canvas-texture-browser] phaseRecord=${JSON.stringify({
        schemaVersion: 1,
        source: import.meta.env.VITE_FORGEAX_EVIDENCE_SOURCE_SHA,
        kind,
        event,
        phase,
      })}`,
    );
  };
  onTestFailed(() => observe(phase, 'failure'));
  observe('case-entry');
  const quad = kind.endsWith('-quad');
  const published = kind.startsWith('published');
  const display = document.createElement('canvas');
  display.width = display.height = 128;
  display.style.width = display.style.height = '128px';
  document.body.append(display);
  const canvas = kind.startsWith('html')
    ? document.createElement('canvas')
    : new OffscreenCanvas(64, 64);
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D;
  const paint = (top: string, bottom: string) => {
    context.fillStyle = top;
    context.fillRect(0, 0, canvas.width, canvas.height / 2);
    context.fillStyle = bottom;
    context.fillRect(0, canvas.height / 2, canvas.width, canvas.height / 2);
    context.clearRect(canvas.width - 8, 0, 8, canvas.height);
    context.fillStyle = 'rgba(255, 255, 255, 0.5)';
    context.fillRect(canvas.width - 8, 0, 8, canvas.height);
  };
  paint('#ff0000', '#0000ff');
  const texture = new CanvasTexture(canvas, { flipY: !quad });
  const recorder = attachRecorder(webgpu).unwrap();
  const identity = { source: 'canvas-native-publication', epoch: 1 };
  const uploads: number[] = [],
    destroyed: number[] = [];
  const errors: unknown[] = [];
  let lose: (() => void) | undefined;
  let publisher: ReturnType<typeof createRenderPublisher> | undefined;
  observe('renderer-construction');
  const host = renderValue(
    await constructRuntimeRendererHost(
      display,
      {
        rhi: recorder.backend.rhi,
        ...(published ? { publicationSource: identity } : {}),
        rhiInstrumentation: {
          resolveSurfaceDevice: (device) => {
            const surfaceDevice = recorder.backend.unwrapDeviceForSurface(device).unwrap();
            webgpu
              ._internal_getRawDevice(surfaceDevice)
              ?.addEventListener('uncapturederror', (event) => {
                errors.push(event.error.message);
              });
            return ok(surfaceDevice);
          },
          deviceLost(device) {
            const generation = uploads.length;
            uploads.push(0);
            destroyed.push(0);
            const textures = new Set<object>();
            const create = device.createTexture.bind(device),
              destroy = device.destroyTexture.bind(device);
            device.createTexture = (descriptor) => {
              const result = create(descriptor);
              if (result.ok && descriptor.label === 'dynamic-texture') textures.add(result.value);
              return result;
            };
            device.destroyTexture = (value) => {
              if (textures.delete(value)) destroyed[generation] = (destroyed[generation] ?? 0) + 1;
              return destroy(value);
            };
            const copy = device.queue.copyExternalImageToTexture.bind(device.queue);
            device.queue.copyExternalImageToTexture = (...args) => {
              uploads[generation] = (uploads[generation] ?? 0) + 1;
              return copy(...args);
            };
            return new Promise((resolve) => {
              if (generation === 0)
                lose = () => {
                  recorder.deviceLost();
                  resolve({ reason: 'unknown', message: 'canvas recovery regression' });
                };
            });
          },
        },
      },
      { shaderManifestUrl: '/shaders/manifest.json' },
    ),
  );
  observe('renderer-ready');
  const { renderer } = host;
  renderer.subscribe((event) => {
    if (event.kind === 'error' && renderer.state() !== 'device-lost') errors.push(event.error);
  });
  const assets = host.assets;
  const world = new World({ assets });
  const mesh = assets
    .create(quad ? createPrimitiveMesh('quad').unwrap() : createPrimitiveMesh('cube').unwrap())
    .unwrap();
  observe('world-context');
  const owner = await createWorldContext(world, [scenePlugin()]);
  observe('world-context-ready');
  try {
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            aspect: 1,
            near: 0.1,
            far: 10,
            antialias: 0,
            bloom: 0,
            tonemap: 0,
          },
        },
      )
      .unwrap();
    const source = { source: texture.source };
    const material = assets
      .create(Materials.unlit([1, 1, 1, 1], { baseColorTexture: source }))
      .unwrap();
    for (const x of [0, 1.2])
      world
        .spawn(
          { component: Transform, data: { pos: [x, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    publisher = published ? createRenderPublisher(world, host.assets, identity) : undefined;
    const lease = publisher === undefined ? renderValue(renderer.attach(world)) : undefined;
    let frames = 0;
    const draw = async (count = 1) => {
      for (let i = 0; i < count; i++) {
        world.update(1 / 60).unwrap();
        await completeReadyFrame(async () => {
          const candidate = publisher?.prepare(frames / 60).unwrap();
          const packet = candidate === undefined ? undefined : structuredClone(candidate.packet);
          candidate?.accept();
          const input =
            packet !== undefined
              ? { publication: packet }
              : lease === undefined
                ? undefined
                : {
                    leases: [lease],
                    camera: { lease },
                    environment: { lease },
                    geometryLane: 'direct' as const,
                  };
          if (input === undefined) throw new Error('Missing draw source');
          const receipt = renderValue(renderer.draw(input));
          renderValue(await receipt.completed);
          if (packet !== undefined)
            publisher?.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
          return receipt;
        });
        frames++;
      }
    };
    const pixels = async (name: string) => {
      const shot = await page.elementLocator(display).screenshot({ base64: true });
      const base64 = typeof shot === 'string' ? shot : shot.base64;
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      await save(`${kind}-${name}.png`, bytes);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const surface = new OffscreenCanvas(128, 128),
        ctx = surface.getContext('2d');
      if (ctx === null) throw new Error('Canvas 2D context unavailable');
      ctx.drawImage(bitmap, 0, 0, 128, 128);
      bitmap.close();
      return ctx.getImageData(0, 0, 128, 128).data;
    };
    // Sample inside each color region. Vitest may scale its iframe screenshot;
    // resampling boundary pixels is not an exact texture-color readback.
    const sample = (data: Uint8ClampedArray, x: number, y: number) => [
      ...data.slice((y * 128 + x) * 4, (y * 128 + x) * 4 + 3),
    ];
    const color = (actual: number[], expected: number[]) =>
      actual.forEach((value, i) => {
        expect(Math.abs(value - (expected[i] ?? NaN))).toBeLessThanOrEqual(3);
      });
    observe('initial-frames');
    await draw(6);
    // The initial image/upload assertion needs a completed draw, not a tape.
    // Upload and recovery below retain their independently inspected captures.
    await draw();
    expect(uploads).toEqual([1]);
    observe('initial-png-readback');
    const first = await pixels('initial');
    color(sample(first, 64, 56), [255, 0, 0]);
    color(sample(first, 64, 72), [0, 0, 255]);
    observe('dirty-upload-and-readback');
    paint('#00ff00', '#808080');
    await draw(2);
    expect(await pixels('not-dirty')).toEqual(first);
    expect(uploads).toEqual([1]);
    texture.update();
    const pendingUpload = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await draw();
    (await recorder.frameBoundary()).unwrap();
    const uploadTape = (await pendingUpload).unwrap();
    await save(`${kind}-upload.rhitape`, uploadTape.bytes);
    expect(
      decodeTape(uploadTape.bytes)
        .unwrap()
        .events.filter((event) => event.kind === 'copyExternalImageToTexture'),
    ).toHaveLength(1);
    expect(uploads).toEqual([2]);
    const updated = await pixels('updated');
    color(sample(updated, 64, 56), [0, 255, 0]);
    color(sample(updated, 64, 72), [128, 128, 128]);
    observe('resize-and-readback');
    canvas.width = 96;
    canvas.height = 48;
    paint('#ffff00', '#00ffff');
    texture.update();
    await draw(3);
    expect(uploads).toEqual([3]);
    expect(destroyed).toEqual([1]);
    const resizeCapture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await draw();
    (await recorder.frameBoundary()).unwrap();
    await save(`${kind}-resized.rhitape`, (await resizeCapture).unwrap().bytes);
    const resized = await pixels('resized');
    await save(
      `${kind}-resize-samples.json`,
      new TextEncoder().encode(
        JSON.stringify({ top: sample(resized, 64, 56), bottom: sample(resized, 64, 72) }),
      ),
    );

    color(sample(resized, 64, 56), [255, 255, 0]);
    color(sample(resized, 64, 72), [0, 255, 255]);
    observe('recovery-and-readback');
    lose?.();
    await expect.poll(() => renderer.state()).toBe('device-lost');
    renderValue(await renderer.recover());
    await draw(3);
    expect(uploads[1]).toBe(1);
    expect(await pixels('recovered')).toEqual(resized);
    // Capture the consuming frame with seeded current texture bytes. External-image
    // upload events remain structurally inspectable, but are not replayable in v7.
    observe('recovery-capture');
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await draw();
    (await recorder.frameBoundary()).unwrap();
    const captured = (await pending).unwrap();
    await save(`${kind}-recovered.rhitape`, captured.bytes);
    const tape = decodeTape(captured.bytes).unwrap(),
      model = buildFrameModel(tape);
    const textureResources = model.resources.filter((row) => {
      const descriptor = row.descriptor as {
        desc?: { format?: string; size?: { width?: number; height?: number } };
      } | null;
      return (
        row.kind === 'texture' &&
        descriptor?.desc?.format === 'rgba8unorm-srgb' &&
        descriptor.desc.size?.width === 96 &&
        descriptor.desc.size.height === 48
      );
    });
    expect(textureResources).toHaveLength(1);
    const textureResource = textureResources[0];
    expect(textureResource).toBeDefined();
    if (!textureResource) throw new Error('Canvas GPU texture missing from capture');
    expect(JSON.stringify(textureResource.descriptor)).toContain('rgba8unorm-srgb');
    expect(
      model.unseededResources.some((row) => row.resourceId === textureResource.resourceId),
    ).toBe(false);
    const viewIds = new Set(
      model.resources
        .filter((row) => {
          const descriptor = row.descriptor;
          return (
            descriptor !== null &&
            typeof descriptor === 'object' &&
            'sourceHandleId' in descriptor &&
            descriptor.sourceHandleId === textureResource.resourceId
          );
        })
        .map((row) => row.resourceId),
    );
    const canvasDraws = model.works.filter(
      (row) =>
        row.kind === 'drawIndexed' &&
        row.bindings.some(
          (binding) => binding.resourceId !== null && viewIds.has(binding.resourceId),
        ),
    );
    const work = canvasDraws[0];
    if (!work) throw new Error('Canvas model draw missing from capture');
    observe('replay-device-and-open');
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const fresh = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    webgpu._internal_getRawDevice(fresh)?.addEventListener('uncapturederror', (event) => {
      errors.push(event.error.message);
    });
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      // Pipeline and binding facts already belong to the captured frame model.
      // Replay only the source texture and presented pixels asserted below.
      observe('replay-readback-and-artifacts');
      const sourcePixels = (
        await replay.readResourceAtWork(textureResource.resourceId, work.workIndex)
      ).unwrap();
      expect(sourcePixels.bytes.length).toBe(96 * 48 * 4);
      // Both UV conventions survive upload, resize, recovery and publication.
      color([...sourcePixels.bytes.slice(0, 3)], quad ? [255, 255, 0] : [0, 255, 255]);
      color(
        [...sourcePixels.bytes.slice(47 * 96 * 4, 47 * 96 * 4 + 3)],
        quad ? [0, 255, 255] : [255, 255, 0],
      );
      // Canvas and native publication must preserve straight alpha for UI edges.
      color([...sourcePixels.bytes.slice(90 * 4, 90 * 4 + 4)], [255, 255, 255, 128]);
      const last = model.works.at(-1);
      if (last === undefined) throw new Error('Missing presented draw');
      const presented = (await replay.inspectWork(last.workIndex, ['pixels'])).unwrap().attachment;
      if (presented === undefined) throw new Error('Missing replay surface pixels');
      expect(presented.width).toBe(128);
      expect(presented.height).toBe(128);
      const screen = new Uint8ClampedArray(presented.bytes);
      if (presented.format?.startsWith('bgra'))
        for (let i = 0; i < screen.length; i += 4) {
          const red = screen[i];
          screen[i] = screen[i + 2] ?? 0;
          screen[i + 2] = red ?? 0;
        }
      const replayCanvas = new OffscreenCanvas(128, 128);
      const replayContext = replayCanvas.getContext('2d');
      if (replayContext === null) throw new Error('Replay image context unavailable');
      replayContext.putImageData(new ImageData(screen, 128, 128), 0, 0);
      await save(
        `${kind}-replay.png`,
        new Uint8Array(await (await replayCanvas.convertToBlob()).arrayBuffer()),
      );
      color(sample(screen, 64, 56), sample(resized, 64, 56));
      color(sample(screen, 64, 72), sample(resized, 64, 72));

      await save(
        `${kind}-inspection.json`,
        new TextEncoder().encode(
          JSON.stringify(
            {
              digest: captured.digest,
              workIndex: work.workIndex,
              eventIndex: work.eventIndex,
              textureResource,
              unseededResources: model.unseededResources,
              inspection: work,
            },
            null,
            2,
          ),
        ),
      );
    } finally {
      observe('replay-dispose');
      (await replay.dispose()).unwrap();
      webgpu._internal_getRawDevice(fresh)?.destroy();
    }
    const omitted = new Set(canvasDraws.map((row) => row.eventIndex));
    const falsified = decodeTape(
      encodeTape({
        ...tape,
        events: tape.events.map((event, index) =>
          omitted.has(index) && event.kind === 'drawIndexed' ? { ...event, indexCount: 0 } : event,
        ),
      }).unwrap(),
    ).unwrap();
    await save(`${kind}-missing-models.rhitape`, encodeTape(falsified).unwrap());
    observe('falsifier-device-and-open');
    const controlAdapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const controlDevice = (
      await controlAdapter.requestDevice(
        replayDeviceRequest(falsified, controlAdapter.features, controlAdapter.limits),
      )
    ).unwrap();
    webgpu._internal_getRawDevice(controlDevice)?.addEventListener('uncapturederror', (event) => {
      errors.push(event.error.message);
    });
    const control = (
      await openReplay(falsified, {
        device: controlDevice,
        createShaderModule: webgpu.createShaderModule,
      })
    ).unwrap();
    try {
      const last = model.works.at(-1);
      if (last === undefined) throw new Error('Missing final work');
      observe('falsifier-readback');
      const pixels = (await control.inspectWork(last.workIndex, ['pixels'])).unwrap().attachment;
      if (pixels === undefined) throw new Error('Missing control pixels');
      const center = [...pixels.bytes.slice((56 * 128 + 64) * 4, (56 * 128 + 64) * 4 + 3)];
      if (pixels.format?.startsWith('bgra')) center.reverse();
      expect(
        center.every((value, channel) => Math.abs(value - ([255, 255, 0][channel] ?? NaN)) <= 3),
      ).toBe(false);
    } finally {
      observe('falsifier-dispose');
      (await control.dispose()).unwrap();
      webgpu._internal_getRawDevice(controlDevice)?.destroy();
    }
    observe('remaining-original-frames');
    await draw(
      Math.max(0, (import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 12 : 60) - frames),
    );
    expect(uploads[1]).toBe(1);
    texture.dispose();
    texture.dispose();
    if (!published) expect(destroyed[1]).toBe(1);
    await draw();
    expect(destroyed[1]).toBe(1);
    expect(uploads[1]).toBe(1);
    const survivingSource = new CanvasTexture(canvas);
    try {
      const survivingMaterial = assets
        .create(
          Materials.unlit([1, 1, 1, 1], {
            baseColorTexture: { source: survivingSource.source },
          }),
        )
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: [-1.2, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [survivingMaterial] } },
        )
        .unwrap();
      observe('surviving-texture-draw');
      await draw();
      expect(uploads[1]).toBe(2);
      observe('surviving-renderer-dispose');
      renderValue(await renderer.dispose());
      expect(destroyed[1]).toBe(2);
      survivingSource.dispose();
      expect(destroyed[1]).toBe(2);
    } finally {
      survivingSource.dispose();
    }
    expect(errors).toEqual([]);
  } finally {
    publisher?.dispose();
    texture.dispose();
    observe('renderer-dispose');
    renderValue(await renderer.dispose());
    observe('world-dispose');
    await owner.fiber.dispose();
    observe('recorder-dispose');
    (await recorder.dispose()).unwrap();
    display.remove();
  }
  observe('case-complete');
}, 180_000);

it('minifies a Canvas checker in linear light and falsifies a base-level-only view', async () => {
  const source = new OffscreenCanvas(1024, 1024);
  const paint = source.getContext('2d');
  if (paint === null) throw new Error('Canvas 2D context unavailable');
  const checker = paint.createImageData(1024, 1024);
  for (let y = 0; y < 1024; y++) {
    for (let x = 0; x < 1024; x++) {
      const offset = (y * 1024 + x) * 4;
      const value = (x + y) % 2 === 0 ? 0 : 255;
      checker.data.set([value, value, value, 255], offset);
    }
  }
  paint.putImageData(checker, 0, 0);
  const capture = async (baseOnly: boolean) => {
    const display = document.createElement('canvas');
    display.width = display.height = 128;
    display.style.width = display.style.height = '128px';
    document.body.append(display);
    const texture = new CanvasTexture(source);
    const errors: unknown[] = [];
    const host = renderValue(
      await constructRuntimeRendererHost(
        display,
        {
          rhi: webgpu.rhi,
          rhiInstrumentation: {
            deviceLost(device) {
              const textures = new Set<object>();
              const create = device.createTexture.bind(device);
              const view = device.createTextureView.bind(device);
              device.createTexture = (descriptor) => {
                const result = create(descriptor);
                if (result.ok && descriptor.label === 'dynamic-texture') {
                  expect(descriptor.mipLevelCount).toBe(11);
                  textures.add(result.value);
                }
                return result;
              };
              // Negative control keeps upload and mip generation, but prevents the
              // material from sampling them. Internal single-level views stay intact.
              device.createTextureView = (value, descriptor) =>
                view(
                  value,
                  baseOnly && textures.has(value) && descriptor?.baseMipLevel === undefined
                    ? { ...descriptor, mipLevelCount: 1 }
                    : descriptor,
                );
              const raw = webgpu._internal_getRawDevice(device);
              raw?.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
              return new Promise(() => {});
            },
          },
        },
        { shaderManifestUrl: '/shaders/manifest.json' },
      ),
    );
    const { renderer, assets } = host;
    const world = new World({ assets });
    const mesh = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();
    const owner = await createWorldContext(world, [scenePlugin()]);
    renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    try {
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 3] } },
          {
            component: Camera,
            data: {
              fov: Math.PI / 3,
              aspect: 1,
              near: 0.1,
              far: 10,
              antialias: 0,
              bloom: 0,
              tonemap: 0,
            },
          },
        )
        .unwrap();
      const material = assets
        .create(
          Materials.unlit([1, 1, 1, 1], {
            baseColorTexture: { source: texture.source },
          }),
        )
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: [0.013, 0.007, 0] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
      const lease = renderValue(renderer.attach(world));
      for (let i = 0; i < 3; i++) {
        world.update(1 / 60).unwrap();
        const receipt = renderValue(
          renderer.draw({
            leases: [lease],
            camera: { lease },
            environment: { lease },
            geometryLane: 'direct',
          }),
        );
        renderValue(await receipt.completed);
      }
      const shot = await page.elementLocator(display).screenshot({ base64: true });
      const bytes = Uint8Array.from(atob(typeof shot === 'string' ? shot : shot.base64), (c) =>
        c.charCodeAt(0),
      );
      await save(`minification-${baseOnly ? 'base-only' : 'mipmapped'}.png`, bytes);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const readback = new OffscreenCanvas(128, 128).getContext('2d');
      if (readback === null) throw new Error('Readback context unavailable');
      readback.drawImage(bitmap, 0, 0, 128, 128);
      bitmap.close();
      const data = readback.getImageData(56, 56, 16, 16).data;
      const values = Array.from({ length: 16 * 16 }, (_, i) => data[i * 4] ?? 0);
      expect(errors).toEqual([]);
      return Math.max(...values.map((value) => Math.abs(value - 188)));
    } finally {
      texture.dispose();
      renderValue(await renderer.dispose());
      await owner.fiber.dispose();
      display.remove();
    }
  };
  expect(await capture(false)).toBeLessThanOrEqual(3);
  expect(await capture(true)).toBeGreaterThan(20);
}, 120_000);
