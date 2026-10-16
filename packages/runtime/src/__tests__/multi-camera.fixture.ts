import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_TAA,
  Camera,
  CameraView,
  CubeCamera,
  createRenderPublisher,
  DynamicResolution,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  type Renderer,
  RenderPublicationTargetOwner,
  renderPublicationTransfers,
  ScreenSpaceReflection,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  encodeTape,
  openReplay,
  type RecorderAttachment,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { renderValue } from './standard-gbuffer-replay.fixture';
export async function verifyMultiCamera(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: (name: string, bytes: Uint8Array) => void | Promise<void>,
  size: {
    width: number;
    height: number;
  },
  failNextSubmit: () => void,
  publication?: {
    readonly assets: AssetRegistry;
    readonly identity: { readonly source: string; readonly epoch: number };
  },
  warmupFrames = 60,
) {
  const world = new World();
  const requestObservation = required(renderer.requestObservation).bind(renderer);
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(2, 2, 2).unwrap());
  const sharedTexture = world.allocSharedRef('TextureAsset', {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
    format: 'rgba8unorm',
    data: new Uint8Array(16).fill(255),
    colorSpace: 'linear',
    mips: { kind: 'none' },
  } satisfies import('@forgeax/engine-types').TextureAsset);
  const models = [];
  for (const [x, color] of [
    [-5, [1, 0.02, 0.01, 1]],
    [5, [0.01, 1, 0.02, 1]],
  ] as const) {
    models.push(
      world
        .spawn(
          { component: Transform, data: { pos: [x, 0, -5] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          {
            component: MeshRenderer,
            data: {
              materials: [
                world.allocSharedRef(
                  'MaterialAsset',
                  Materials.unlit([...color], { baseColorTexture: sharedTexture }),
                ),
              ],
            },
          },
        )
        .unwrap(),
    );
  }
  const cameras = [-5, 5].map((x, index) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 0] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            aspect: 99,
            near: 0.1,
            far: 30,
            antialias: ANTIALIAS_TAA,
            tonemap: 1,
            clearColor: [0.02, 0.025, 0.04, 1],
          },
        },
        { component: CameraView, data: { viewport: [index * 0.5, 0, 0.5, 1], order: index } },
        {
          component: DynamicResolution,
          data: {
            minScale: index === 0 ? 0.75 : 1,
            maxScale: index === 0 ? 0.75 : 1,
          },
        },
      )
      .unwrap(),
  );
  const targetOwner = publication === undefined ? undefined : new RenderPublicationTargetOwner();
  const targets = targetOwner?.authoring ?? renderer;
  const publisher =
    publication === undefined
      ? undefined
      : createRenderPublisher(
          world,
          publication.assets,
          publication.identity,
          renderer.inspect().capabilities,
          [],
          targetOwner,
        );
  const lease = publisher === undefined ? renderValue(renderer.attach(world)) : undefined;
  let time = 0;
  let invalidateSharedTexture = false;
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    time += 1 / 60;
    const candidate = publisher?.prepare(time).unwrap();
    let packet =
      candidate === undefined
        ? undefined
        : structuredClone(candidate.packet, {
            transfer: renderPublicationTransfers(candidate.packet),
          });
    candidate?.accept();
    if (packet !== undefined && invalidateSharedTexture) {
      // A legal resource invalidation must happen once before all camera records.
      packet = { ...packet, invalidatedAssets: [...packet.invalidatedAssets, sharedTexture] };
      invalidateSharedTexture = false;
    }
    try {
      const result = renderer.draw(
        packet === undefined
          ? {
              leases: [required(lease)],
              camera: { lease: required(lease) },
              environment: { lease: required(lease) },
            }
          : { publication: packet },
      );
      if (!result.ok) throw new Error(JSON.stringify({ failure: result.error, errors }));
      renderValue(await result.value.completed);
      return result.value;
    } finally {
      if (packet !== undefined)
        required(publisher).recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    }
  };
  try {
    for (let i = 0; i < warmupFrames; i++) await draw();
    if (publisher !== undefined) {
      invalidateSharedTexture = true;
      renderValue(requestObservation(['final-display']));
      const receipt = await draw();
      const refreshed = required(
        required(
          renderValue(
            await renderer.observe(receipt, {
              include: ['final-display'],
            }),
          ).observations,
        )[0],
      );
      const center = (size.height / 2) * refreshed.metadata.bytesPerRow + (size.width / 4) * 4;
      expect(refreshed.bytes[center + 3]).toBe(255);
    }
    expect(errors).toEqual([]);
    // Shared captures advance while every display retains its image and TAA history.
    const cube = renderValue(
      targets.createRenderTarget({
        shape: 'cube',
        width: 16,
        height: 16,
        format: 'rgba8unorm',
        mipLevels: 1,
        sampleCount: 1,
        sampled: true,
        readback: false,
      }),
    );
    const auxiliaryTarget = renderValue(
      targets.createRenderTarget({
        shape: '2d',
        width: 16,
        height: 16,
        format: 'rgba8unorm',
        mipLevels: 1,
        sampleCount: 1,
        sampled: true,
        readback: false,
      }),
    );
    const litModel = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -5] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        {
          component: MeshRenderer,
          data: {
            materials: [
              world.allocSharedRef(
                'MaterialAsset',
                Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.7 }),
              ),
            ],
          },
        },
      )
      .unwrap();
    const captureLight = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -3] } },
        { component: PointLight, data: { color: [1, 1, 1], intensity: 40, range: 2 } },
      )
      .unwrap();
    const captureBrightness: number[] = [];
    const cubeEntity = world
      .spawn(
        { component: Transform, data: {} },
        {
          component: CubeCamera,
          data: { target: world.allocSharedRef('RenderTarget', cube), requestVersion: 1 },
        },
      )
      .unwrap();
    const monitorEntity = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        {
          component: Camera,
          data: {
            target: world.allocSharedRef('RenderTarget', auxiliaryTarget),
            fov: Math.PI / 3,
            aspect: 1,
            near: 0.1,
            far: 30,
          },
        },
      )
      .unwrap();
    for (const camera of cameras) world.set(camera, CameraView, { updateInterval: 64 }).unwrap();
    const heldCaptureViews = required(renderer.inspect().views).map((view) => ({
      entity: view.entityKey,
      frames: view.renderedFrames,
      history: view.temporal.frameIndex,
    }));
    for (let face = 0; face < 7; face += 1) {
      if (face === 6) world.set(captureLight, PointLight, { intensity: 0 }).unwrap();
      const pendingCapture = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      await draw();
      (await recorder.frameBoundary()).unwrap();
      const captured = (await pendingCapture).unwrap();
      const tape = decodeTape(captured.bytes).unwrap();
      const targetPasses = tape.events.filter(
        (event) =>
          event.kind === 'beginRenderPass' &&
          event.depthStencilViewHandleId !== undefined &&
          event.colorAttachmentViewHandleIds.length > 0,
      );
      expect(targetPasses).toHaveLength(face < 6 ? 2 : 1);
      expect(tape.events.filter((event) => event.kind === 'submit')).toHaveLength(1);
      expect(
        required(renderer.inspect().views).map((view) => ({
          entity: view.entityKey,
          frames: view.renderedFrames,
          history: view.temporal.frameIndex,
        })),
      ).toEqual(heldCaptureViews);
      if (face === 0 || face === 6) {
        const targetPass = required(targetPasses.at(-1));
        const start = tape.events.indexOf(targetPass);
        const end = tape.events.findIndex(
          (event, index) => index > start && event.kind === 'endRenderPass',
        );
        const work = required(
          buildFrameModel(tape)
            .works.filter((work) => work.eventIndex > start && work.eventIndex < end)
            .at(-1),
        );
        const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
        const device = (
          await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
        ).unwrap();
        const replay = (
          await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
        ).unwrap();
        try {
          const inspection = (await replay.inspectWork(work.workIndex, ['pixels'])).unwrap();
          const pixels = required(inspection.attachment).bytes;
          const center = (8 * 16 + 8) * 4;
          captureBrightness.push(
            (pixels[center] ?? 0) + (pixels[center + 1] ?? 0) + (pixels[center + 2] ?? 0),
          );
          await save(face === 0 ? 'held-capture-lit.rgba' : 'held-capture-dark.rgba', pixels);
        } finally {
          (await replay.dispose()).unwrap();
        }
      }
      if (face === 0) await save('held-views-shared-captures.rhitape', captured.bytes);
    }
    expect(required(captureBrightness[0]) - required(captureBrightness[1])).toBeGreaterThan(60);
    world.despawn(litModel).unwrap();
    world.despawn(captureLight).unwrap();
    world.despawn(cubeEntity).unwrap();
    world.despawn(monitorEntity).unwrap();
    renderValue(targets.destroyRenderTarget(cube));
    renderValue(targets.destroyRenderTarget(auxiliaryTarget));
    for (const camera of cameras) world.set(camera, CameraView, { updateInterval: 1 }).unwrap();
    await draw();
    expect(errors).toEqual([]);
    const accepted = required(renderer.inspect().views);
    world.set(required(cameras[0]), CameraView, { viewport: [0, 0, 1, 1] }).unwrap();
    failNextSubmit();
    await expect(draw()).rejects.toThrow();
    expect(required(renderer.inspect().views).map((v) => [v.width, v.renderedFrames])).toEqual(
      accepted.map((v) => [v.width, v.renderedFrames]),
    );
    expect(required(renderer.inspect().views)[1]?.temporal.frameIndex).toBe(
      accepted[1]?.temporal.frameIndex,
    );
    expect(errors).toHaveLength(1);
    errors.length = 0;
    world.set(required(cameras[0]), CameraView, { viewport: [0, 0, 0.5, 1] }).unwrap();
    await draw();
    const views = required(renderer.inspect().views);
    expect(views).toHaveLength(2);
    expect(views.map((v) => [v.width, v.height])).toEqual([
      [size.width / 2, size.height],
      [size.width / 2, size.height],
    ]);
    expect(views.every((v) => v.frustum.culled > 0)).toBe(true);
    expect(views.map((view) => view.dynamicResolution?.status)).toEqual(['fixed', 'fixed']);
    expect(views.map((view) => view.dynamicResolution?.extent?.scale)).toEqual([0.75, 1]);
    const originalProfile = renderer.inspect().profile;
    const originalMaterials = models.map((entity) => [
      ...world.get(entity, MeshRenderer).unwrap().materials,
    ]);
    const reflectiveMaterial = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [0.7, 0.7, 0.7, 1], roughness: 0.2 }),
    );
    for (const entity of models)
      world.set(entity, MeshRenderer, { materials: [reflectiveMaterial] }).unwrap();
    for (const camera of cameras)
      world
        .addComponent(camera, { component: ScreenSpaceReflection, data: { maxDistance: 12 } })
        .unwrap();
    renderValue(renderer.setProfile({ ...originalProfile, renderPath: 'deferred', ssao: true }));
    for (let frame = 0; frame < 3; frame += 1) await draw();
    expect(
      required(renderer.inspect().views).every((view) => view.passes.includes('ssao-calc')),
    ).toBe(true);
    expect(
      required(renderer.inspect().views).every((view) => view.passes.includes('ssr-trace')),
      JSON.stringify(required(renderer.inspect().views).map((view) => view.ssr)),
    ).toBe(true);
    expect(required(renderer.inspect().views).every((view) => view.ssr.status === 'admitted')).toBe(
      true,
    );
    for (const [index, entity] of models.entries())
      world.set(entity, MeshRenderer, { materials: required(originalMaterials[index]) }).unwrap();
    for (const camera of cameras) world.removeComponent(camera, ScreenSpaceReflection).unwrap();
    renderValue(renderer.setProfile(originalProfile));
    await draw();
    expect(
      required(renderer.inspect().views).every((view) => !view.passes.includes('ssao-calc')),
    ).toBe(true);
    renderValue(requestObservation(['final-display']));
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const receipt = await draw();
    (await recorder.frameBoundary()).unwrap();
    const capture = (await pending).unwrap();
    await save('split.rhitape', capture.bytes);
    const observation = required(
      required(
        renderValue(await renderer.observe(receipt, { include: ['final-display'] })).observations,
      ).find((o) => o.domain === 'final-display'),
    );
    const live = new Uint8Array(size.width * size.height * 4);
    for (let y = 0; y < size.height; y++)
      live.set(
        observation.bytes.subarray(
          y * observation.metadata.bytesPerRow,
          y * observation.metadata.bytesPerRow + size.width * 4,
        ),
        y * size.width * 4,
      );
    await save('split.rgba', live);
    const tape = decodeTape(capture.bytes).unwrap();
    const model = buildFrameModel(tape);
    const composites = model.works.filter((work) =>
      work.pipeline.shaders.some((shader) => shader.source?.includes('var picture: texture_2d')),
    );
    expect(composites).toHaveLength(2);
    const depthAttachments = new Set(
      model.works
        .map((work) => work.attachments?.depthStencilViewHandleId)
        .filter((id) => id != null),
    );
    expect(depthAttachments.size).toBeGreaterThanOrEqual(2);
    const submitCount = tape.events.filter((event) => event.kind === 'submit').length;
    expect(submitCount).toBe(1);
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const replay = (
      await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const result = (
        await replay.inspectWork(required(composites.at(-1)).workIndex, [
          'pipeline',
          'bindings',
          'pixels',
        ])
      ).unwrap();
      expect(result.attachment).toBeDefined();
      const pixels = required(result.attachment).bytes;
      await save('split-replay.rgba', pixels);
      expect(pixels.length).toBe(live.length);
      let delta = 0;
      for (let i = 0; i < pixels.length; i++)
        delta = Math.max(delta, Math.abs(required(pixels[i]) - required(live[i])));
      expect(delta).toBeLessThanOrEqual(1);
      const format = required(result.attachment).format;
      const pixel = (x: number, y: number) => {
        const offset = (y * size.width + x) * 4;
        const rgba = [...pixels.subarray(offset, offset + 4)];
        return required(format).startsWith('bgra')
          ? [required(rgba[2]), required(rgba[1]), required(rgba[0]), required(rgba[3])]
          : rgba;
      };
      const left = pixel(size.width / 4, size.height / 2),
        right = pixel((size.width * 3) / 4, size.height / 2);
      expect(left[0]).toBeGreaterThan(100);
      expect(required(left[0]) - required(left[1])).toBeGreaterThan(70);
      expect(right[1]).toBeGreaterThan(100);
      expect(required(right[1]) - required(right[0])).toBeGreaterThan(70);
      await save(
        'split.json',
        new TextEncoder().encode(
          JSON.stringify(
            {
              digest: capture.digest,
              submitCount,
              works: composites.map((work) => ({
                workIndex: work.workIndex,
                event: work.eventIndex,
              })),
              format,
              width: size.width,
              height: size.height,
              left,
              right,
              delta,
              views,
            },
            null,
            2,
          ),
        ),
      );
    } finally {
      (await replay.dispose()).unwrap();
    }
    const last = required(composites.at(-1));
    const falsified = encodeTape({
      ...tape,
      events: tape.events.map((event, index) =>
        index === last.eventIndex && event.kind === 'draw' ? { ...event, vertexCount: 0 } : event,
      ),
    }).unwrap();
    await save('missing-composite.falsifier.rhitape', falsified);
    const falsifierAdapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const falsifierDevice = (
      await falsifierAdapter.requestDevice(
        replayDeviceRequest(tape, falsifierAdapter.features, falsifierAdapter.limits),
      )
    ).unwrap();
    const falsifier = (
      await openReplay(decodeTape(falsified).unwrap(), {
        device: falsifierDevice,
        createShaderModule: webgpu.createShaderModule,
      })
    ).unwrap();
    try {
      const result = (await falsifier.inspectWork(last.workIndex, ['pixels'])).unwrap();
      const pixels = required(result.attachment).bytes;
      await save('missing-composite.rgba', pixels);
      const offset = ((size.height / 2) * size.width + (size.width * 3) / 4) * 4;
      expect([...pixels.subarray(offset, offset + 4)]).toEqual([0, 0, 0, 255]);
      expect(Math.abs(required(pixels[offset + 1]) - required(live[offset + 1]))).toBeGreaterThan(
        100,
      );
    } finally {
      (await falsifier.dispose()).unwrap();
    }
    world
      .set(required(cameras[0]), Camera, { bloom: 1, bloomThreshold: 0.1, bloomIntensity: 0.6 })
      .unwrap();
    await draw();
    expect(required(renderer.inspect().views)[0]?.bloom.enabled).toBe(true);
    expect(required(renderer.inspect().views)[1]?.bloom.enabled).toBe(false);
    world.set(required(cameras[0]), Camera, { bloom: 0 }).unwrap();
    await draw();
    const minimap = world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 10, -5], quat: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
        },
        {
          component: Camera,
          data: {
            projection: 1,
            left: -8,
            right: 8,
            top: 4,
            bottom: -4,
            near: 0.1,
            far: 30,
            clearColor: [0.1, 0.1, 0.1, 1],
          },
        },
        {
          component: CameraView,
          data: {
            viewport: [0.75, 0, 0.25, 0.25],
            order: 10,
            resolutionScale: 0.5,
            updateInterval: 4,
          },
        },
      )
      .unwrap();
    const observeMap = async () => {
      renderValue(requestObservation(['final-display']));
      const receipt = await draw();
      return required(
        required(
          renderValue(
            await renderer.observe(receipt, {
              include: ['final-display'],
            }),
          ).observations,
        )[0],
      );
    };
    const redCenter = (picture: Awaited<ReturnType<typeof observeMap>>) => {
      let sum = 0,
        count = 0;
      const red = picture.metadata.format.startsWith('bgra') ? 2 : 0;
      for (let y = 0; y < size.height / 4; y++)
        for (let x = (size.width * 3) / 4; x < size.width; x++) {
          const i = y * picture.metadata.bytesPerRow + x * 4;
          if (required(picture.bytes[i + red]) - required(picture.bytes[i + 1]) > 70) {
            sum += x;
            count++;
          }
        }
      expect(count).toBeGreaterThan(0);
      return sum / count;
    };
    const initialMap = await observeMap();
    const before = required(
      required(renderer.inspect().views).find((v) => v.entityKey === Number(minimap)),
    );
    // This transform delta is consumed on a held frame, before the next camera update.
    world.set(required(models[0]), Transform, { pos: [0, 0, -5] }).unwrap();
    const heldMap = await observeMap();
    expect(redCenter(heldMap)).toBe(redCenter(initialMap));
    await draw();
    const held = required(
      required(renderer.inspect().views).find((v) => v.entityKey === Number(minimap)),
    );
    expect(held.renderedFrames).toBe(before.renderedFrames);
    expect([held.width, held.height]).toEqual([size.width / 8, size.height / 8]);
    await draw();
    const caughtUpMap = await observeMap();
    expect(redCenter(caughtUpMap) - redCenter(initialMap)).toBeGreaterThan(5);
    expect(
      renderer.bounds(publication?.identity ?? world, Number(required(models[0]))),
    ).toMatchObject({ min: [-1, -1, -6], max: [1, 1, -4] });
    await save('minimap-catchup.rgba', caughtUpMap.bytes);
    expect(
      required(required(renderer.inspect().views).find((v) => v.entityKey === Number(minimap)))
        .renderedFrames,
    ).toBe(before.renderedFrames + 1);
    world.set(required(models[0]), Transform, { pos: [-5, 0, -5] }).unwrap();
    const beforeCut = required(renderer.inspect().views);
    world.set(required(cameras[0]), Camera, { historyVersion: 1 }).unwrap();
    await draw();
    const afterCut = required(renderer.inspect().views);
    expect(required(afterCut[0]).temporal.status).toBe('reset');
    expect(required(afterCut[1]).temporal.status).toBe('stable');
    expect(required(afterCut[1]).temporal.frameIndex).toBe(
      required(beforeCut[1]).temporal.frameIndex + 1,
    );
    renderValue(requestObservation(['final-display']));
    const miniReceipt = await draw();
    const mini = required(
      required(
        renderValue(await renderer.observe(miniReceipt, { include: ['final-display'] }))
          .observations,
      )[0],
    );
    await save('minimap.rgba', mini.bytes);
    // Output order changes without exchanging camera histories.
    world.set(required(cameras[0]), CameraView, { viewport: [0, 0, 1, 1], order: 20 }).unwrap();
    await draw();
    expect(
      required(required(renderer.inspect().views).find((v) => v.entityKey === Number(cameras[0])))
        .width,
    ).toBe(size.width);
    world.set(required(cameras[0]), CameraView, { enabled: false }).unwrap();
    await draw();
    expect(required(renderer.inspect().views).some((v) => v.entityKey === Number(cameras[0]))).toBe(
      false,
    );
    world.set(required(cameras[0]), CameraView, { enabled: true }).unwrap();
    await draw();
    expect(
      required(required(renderer.inspect().views).find((v) => v.entityKey === Number(cameras[0])))
        .renderedFrames,
    ).toBe(1);
    for (const camera of [...cameras, minimap])
      world.set(camera, CameraView, { enabled: false }).unwrap();
    renderValue(requestObservation(['final-display']));
    const empty = await draw();
    const emptyPixels = required(
      required(
        renderValue(await renderer.observe(empty, { include: ['final-display'] })).observations,
      )[0],
    ).bytes;
    expect([...emptyPixels.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect(renderer.inspect().views).toEqual([]);
    // A third camera writes a texture consumed by an ordinary mesh material.
    const target = renderValue(
      targets.createRenderTarget({
        shape: '2d',
        width: 32,
        height: 32,
        format: 'rgba8unorm',
        mipLevels: 1,
        sampleCount: 1,
        sampled: true,
        readback: true,
      }),
    );
    const source = renderValue(
      targets.createRenderTargetTextureSource(target, {
        aspect: 'color',
        dimension: '2d',
        mipLevel: 0,
      }),
    );
    const sourceRef = world.allocSharedRef('RenderTargetTextureSource', source);
    const monitorMaterial = world.allocSharedRef(
      'MaterialAsset',
      Materials.unlit([1, 1, 1, 1], { baseColorTexture: sourceRef }),
    );
    world
      .spawn(
        { component: Transform, data: { pos: [5, 0, -3] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [monitorMaterial] } },
      )
      .unwrap();
    const monitorCamera = world
      .spawn(
        { component: Transform, data: { pos: [-5, 0, 0] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            near: 0.1,
            far: 30,
            target: world.allocSharedRef('RenderTarget', target),
          },
        },
        { component: CameraView, data: { order: -10, updateInterval: 2 } },
      )
      .unwrap();
    world.set(required(cameras[1]), CameraView, { enabled: true }).unwrap();
    for (let i = 0; i < 6; i++) await draw();
    const targetView = required(
      required(renderer.inspect().views).find((v) => v.entityKey === Number(monitorCamera)),
    );
    expect([targetView.output, targetView.width, targetView.height]).toEqual(['texture', 32, 32]);
    renderValue(requestObservation(['final-display']));
    const monitorPending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const monitorReceipt = await draw();
    (await recorder.frameBoundary()).unwrap();
    const monitorCapture = (await monitorPending).unwrap();
    await save('monitor.rhitape', monitorCapture.bytes);
    const monitor = required(
      required(
        renderValue(await renderer.observe(monitorReceipt, { include: ['final-display'] }))
          .observations,
      )[0],
    );
    await save('monitor.rgba', monitor.bytes);
    const centerOffset =
      (size.height / 2) * monitor.metadata.bytesPerRow + ((size.width * 3) / 4) * 4;
    const center = [...monitor.bytes.subarray(centerOffset, centerOffset + 4)];
    const red = monitor.metadata.format.startsWith('bgra')
      ? required(center[2])
      : required(center[0]);
    expect(red).toBeGreaterThan(100);
    expect(red - required(center[1])).toBeGreaterThan(60);
    expect(required(center[1])).toBeLessThan(50);
    const monitorTape = decodeTape(monitorCapture.bytes).unwrap();
    const monitorModel = buildFrameModel(monitorTape);
    const monitorWork = required(
      monitorModel.works.findLast((work) =>
        work.pipeline.shaders.some(
          (shader) =>
            shader.entryPoint === 'fragment' && shader.source?.includes('var picture: texture_2d'),
        ),
      ),
    );
    const monitorAdapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const monitorDevice = (
      await monitorAdapter.requestDevice(
        replayDeviceRequest(monitorTape, monitorAdapter.features, monitorAdapter.limits),
      )
    ).unwrap();
    const monitorReplay = (
      await openReplay(monitorTape, {
        device: monitorDevice,
        createShaderModule: webgpu.createShaderModule,
      })
    ).unwrap();
    try {
      const replayPixels = required(
        (await monitorReplay.inspectWork(monitorWork.workIndex, ['pixels', 'bindings'])).unwrap()
          .attachment,
      ).bytes;
      await save('monitor-replay.rgba', replayPixels);
      let delta = 0;
      for (let y = 0; y < size.height; y++)
        for (let x = 0; x < size.width * 4; x++) {
          delta = Math.max(
            delta,
            Math.abs(
              required(replayPixels[y * size.width * 4 + x]) -
                required(monitor.bytes[y * monitor.metadata.bytesPerRow + x]),
            ),
          );
        }
      expect(delta).toBeLessThanOrEqual(1);
      await save(
        'monitor.json',
        new TextEncoder().encode(
          JSON.stringify(
            {
              digest: monitorCapture.digest,
              workIndex: monitorWork.workIndex,
              eventIndex: monitorWork.eventIndex,
              center,
              delta,
              format: monitor.metadata.format,
              width: size.width,
              height: size.height,
              unseededResources: monitorModel.unseededResources,
            },
            null,
            2,
          ),
        ),
      );
    } finally {
      (await monitorReplay.dispose()).unwrap();
    }
    // Returning to the ordinary camera and re-entering composition both seed
    // from the current accepted source scene, without another publication format.
    for (const camera of [...cameras, minimap, monitorCamera])
      world.removeComponent(camera, CameraView).unwrap();
    for (let i = 0; i < 6; i++) await draw();
    expect(renderer.inspect().views).toEqual([]);
    world.addComponent(required(cameras[0]), { component: CameraView, data: {} }).unwrap();
    for (let i = 0; i < 6; i++) await draw();
    expect(renderer.inspect().views).toHaveLength(1);
    expect(required(renderer.inspect().views)[0]?.frustum.total).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    off();
    lease?.dispose();
    publisher?.dispose();
    targetOwner?.dispose();
  }
}

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error('Expected multi-camera evidence');
  return value;
}
