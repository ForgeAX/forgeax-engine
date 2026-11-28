import { mkdirSync, writeFileSync } from 'node:fs';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createSphereGeometry } from '@forgeax/engine-geometry';
import { encodePng } from '@forgeax/engine-image/png';
import {
  ANTIALIAS_NONE,
  ANTIALIAS_SMAA,
  Camera,
  CameraView,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  orthographic,
  Skylight,
} from '@forgeax/engine-render';
import { TransparentSort } from '@forgeax/engine-render/authoring';
import { renderGraphCompileCount, renderOrderedViewBindCount } from '@forgeax/engine-render-graph';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  summarizePasses,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { type AssetHandle, ok, RenderQueue } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost, type RendererHostAssembly } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const WIDTH = 128;
const HEIGHT = 64;
const FRAMES = 60;
const SAMPLE_FRAMES = new Set([0, 1, 30, 59]);
const EVIDENCE = 'artifacts/dense-view-draw-parity';

const BLEND = {
  depthWriteEnabled: false,
  blend: {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  },
} as const;

function makeScene(assets: RendererHostAssembly['assets']) {
  const world = new World({ assets });
  const box = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const sphere = createSphereGeometry(0.4, 12, 8).unwrap();
  const casterIndexCount = sphere.indices?.length;
  assert(casterIndexCount !== undefined && casterIndexCount > 36);
  const casterMesh = assets.create(sphere).unwrap();
  const ground = assets
    .create(Materials.standard({ baseColor: [0.6, 0.6, 0.6, 1], roughness: 1 }))
    .unwrap();
  const opaque = [
    assets.create(Materials.unlit([0.22, 0.45, 0.1, 1])).unwrap(),
    assets
      .create(
        Materials.standard({
          baseColor: [0.12, 0.16, 0.2, 1],
          emissive: [0.25, 0.18, 0.08],
          emissiveIntensity: 1,
        }),
      )
      .unwrap(),
  ] as const;
  const transparent = [
    [1, 0, 0, 0.86],
    [0, 0, 1, 0.86],
  ] as const;
  const tints = transparent.map((color) =>
    assets
      .create(Materials.unlit(color, { queue: RenderQueue.Transparent, renderState: BLEND }))
      .unwrap(),
  );
  const mesh = (
    geometry: AssetHandle<'mesh'>,
    material: AssetHandle<'material'>,
    pos: readonly [number, number, number],
    scale: readonly [number, number, number],
  ) =>
    world
      .spawn(
        { component: Transform, data: { pos, scale } },
        { component: MeshFilter, data: { assetHandle: geometry } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  const moving: { entity: EntityHandle; x: number; y: number }[] = [];
  const panels: EntityHandle[][] = [];
  for (const [view, center] of [-4, 4].entries()) {
    world
      .spawn(
        { component: Transform, data: { pos: [center, 1.2, 7.5] } },
        {
          component: Camera,
          data: {
            ...orthographic({ left: -3, right: 3, top: 3, bottom: -3, near: 0.1, far: 60 }),
            antialias: 0,
            bloom: 0,
            tonemap: 0,
            clearColor: [0.02, 0.02, 0.02, 1],
          },
        },
        { component: CameraView, data: { viewport: [view / 2, 0, 0.5, 1], order: view } },
      )
      .unwrap();
    panels.push(
      tints.map((tint, index) => mesh(box, tint, [center, 1.2, 1 - index], [1.5, 1.5, 0.05])),
    );
    for (let index = 0; index < 32; index++) {
      const x = center + ((index % 8) - 3.5) * 0.63;
      const y = 2.32 + Math.floor(index / 8) * 0.36;
      moving.push({ entity: mesh(box, opaque[0], [x, y, 0], [0.3, 0.3, 0.3]), x, y });
    }
  }
  mesh(box, ground, [0, -0.8, 0], [16, 0.2, 12]);
  // In the gap between the two frusta. Its directional shadow enters the left view.
  const caster = mesh(casterMesh, ground, [0, 2.2, 0], [1, 4, 1]);
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-1, -1, 0.5],
        intensity: 4,
        castShadow: true,
        cascadeCount: 1,
        mapSize: 256,
        shadowDistance: 25,
      },
    })
    .unwrap();
  world.spawn({ component: Skylight, data: { intensity: 0.1, color: [1, 1, 1] } }).unwrap();
  TransparentSort.configure(world, { mode: TransparentSort.distance, yzAlpha: 1 });
  return { world, moving, panels, opaque, caster, casterIndexCount };
}

function applyEdits(scene: ReturnType<typeof makeScene>, frame: number) {
  const { world, moving, panels, opaque, caster } = scene;
  // Reset every row at the start of each replay, then update the alternate half every frame.
  const phase = frame % 2;
  for (let index = frame === 0 ? 0 : phase; index < moving.length; index += frame === 0 ? 1 : 2) {
    const row = moving[index];
    assert(row);
    const step = frame === 0 ? 0 : Math.floor(frame / 2) + 1;
    world.set(row.entity, Transform, { pos: [row.x + (step % 3) * 0.08, row.y, 0] }).unwrap();
    world.set(row.entity, MeshRenderer, { materials: [opaque[step % 2 === 0 ? 0 : 1]] }).unwrap();
  }
  panels.forEach((pair, view) => {
    for (const [index, panel] of pair.entries())
      world
        .set(panel, Transform, { pos: [-4 + view * 8, 1.2, 1 - ((index + view + phase) % 2)] })
        .unwrap();
  });
  world.set(caster, Transform, { pos: [0, 2.2, (frame % 7) * 0.12] }).unwrap();
  world.update(1 / 60).unwrap();
  propagateTransforms(world).unwrap();
}

async function readCanvas(device: GPUDevice, texture: GPUTexture) {
  const { width, height } = texture;
  const bytesPerRow = width * 4;
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width, height });
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(buffer.getMappedRange().slice(0));
    const bgra = texture.format.startsWith('bgra');
    if (bgra) {
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const red = pixels[offset + 2] as number;
        pixels[offset + 2] = pixels[offset] as number;
        pixels[offset] = red;
      }
    }
    return pixels;
  } finally {
    buffer.destroy();
  }
}

it('binds Deferred display and texture views directly during output changes', {
  timeout: 180_000,
  retry: 0,
}, async () => {
  const { buildEngineShaderTemplateManifest } = await import('@forgeax/engine-vite-plugin-shader');
  const manifest = shaderManifestUrl(await buildEngineShaderTemplateManifest());
  const surface = offscreenCanvas(WIDTH, HEIGHT);
  const host = renderValue(
    await constructRuntimeRendererHost(surface.canvas, {}, { shaderManifestUrl: manifest }),
  );
  renderValue(await host.initialization);
  const { assets, renderer } = host;
  renderValue(renderer.setProfile({ ...renderer.inspect().profile, renderPath: 'deferred' }));
  const world = new World({ assets });
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const cameras = [-4, 4].map((x, index) => {
    const color = index === 0 ? ([1, 0, 0, 1] as const) : ([0, 1, 0, 1] as const);
    const material = assets.create(Materials.unlit(color)).unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    return world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 3] } },
        {
          component: Camera,
          data: {
            ...orthographic({ left: -2, right: 2, top: 2, bottom: -2, near: 0.1, far: 10 }),
            bloom: 0,
            tonemap: 0,
          },
        },
        { component: CameraView, data: { viewport: [index / 2, 0, 0.5, 1], order: index } },
      )
      .unwrap();
  });
  const [left, right] = cameras;
  assert(left !== undefined && right !== undefined);
  const target = renderValue(
    renderer.createRenderTarget({
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
  const offscreen = world.allocSharedRef('RenderTarget', target);
  const lease = renderValue(renderer.attach(world));
  const before = renderGraphCompileCount();
  const direct = renderOrderedViewBindCount();
  try {
    for (const [height, smaa, toTexture] of [
      [HEIGHT, false, false],
      [HEIGHT, true, true],
      [80, false, true],
      [80, true, false],
    ] as const) {
      surface.canvas.height = height;
      world.set(left, Camera, { antialias: smaa ? ANTIALIAS_SMAA : ANTIALIAS_NONE }).unwrap();
      world
        .set(right, Camera, { antialias: ANTIALIAS_NONE, target: toTexture ? offscreen : 0 })
        .unwrap();
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      await drawReadyFrame(renderer, { source: lease, geometryLane: 'direct' });
      const views = renderer.inspect({ fields: ['views'] }).views;
      const first = views?.find((view) => view.entityKey === Number(left));
      const second = views?.find((view) => view.entityKey === Number(right));
      assert(first !== undefined && second !== undefined);
      expect(first.passes).toContain('deferred-display-draws');
      expect(first.passes.includes('smaa-edges')).toBe(smaa);
      expect(second.passes).toContain('deferred-display-draws');
      expect(second.output).toBe(toTexture ? 'texture' : 'screen');
      const context = surface.canvas.getContext();
      const configuration = context.getConfiguration();
      const texture = context.getCurrentTexture();
      assert(configuration && texture);
      const pixels = await readCanvas(configuration.device, texture);
      const leftCenter = (Math.floor(height / 2) * WIDTH + WIDTH / 4) * 4;
      expect((pixels[leftCenter] ?? 0) - (pixels[leftCenter + 1] ?? 0)).toBeGreaterThan(80);
      if (toTexture) {
        const ticket = renderValue(renderer.requestTargetReadback(target, { mipLevel: 0 }));
        const submitted = await drawReadyFrame(renderer, { source: lease, geometryLane: 'direct' });
        const result = renderValue(
          await renderer.observe(submitted, {
            include: ['target-readbacks'],
            targetReadbacks: [ticket],
          }),
        );
        const picture = result.targetReadbacks?.[0];
        assert(picture !== undefined);
        const center = 16 * picture.bytesPerRow + 16 * 4;
        expect((picture.bytes[center + 1] ?? 0) - (picture.bytes[center] ?? 0)).toBeGreaterThan(80);
      } else {
        const rightCenter = leftCenter + (WIDTH / 2) * 4;
        expect((pixels[rightCenter + 1] ?? 0) - (pixels[rightCenter] ?? 0)).toBeGreaterThan(80);
      }
    }
    expect(renderOrderedViewBindCount()).toBeGreaterThan(direct);
    expect(renderGraphCompileCount() - before).toBe(renderOrderedViewBindCount() - direct);
  } finally {
    lease.dispose();
    renderValue(renderer.destroyRenderTarget(target));
    renderValue(await renderer.dispose());
    surface.destroy();
    URL.revokeObjectURL(manifest);
  }
});

function compareFrames(automatic: Uint8Array, direct: Uint8Array, frame: number) {
  const center = (view: number) => (32 * WIDTH + 32 + view * 64) * 4;
  for (const [view, expected] of [
    [0, frame % 2],
    [1, (frame + 1) % 2],
  ] as const) {
    const offset = center(view);
    const dominant = expected * 2;
    const other = 2 - dominant;
    for (const image of [automatic, direct])
      expect((image[offset + dominant] ?? 0) - (image[offset + other] ?? 0)).toBeGreaterThan(50);
  }
  let differences = 0;
  for (let offset = 0; offset < automatic.length; offset++)
    if (Math.abs((automatic[offset] ?? 0) - (direct[offset] ?? 0)) > 4) differences++;
  expect(differences).toBe(0);
}

it('preserves two physical views under continuous edits with GPU indirect drawing disabled', {
  timeout: 180_000,
  retry: 0,
}, async () => {
  mkdirSync(EVIDENCE, { recursive: true });
  const { buildEngineShaderTemplateManifest } = await import('@forgeax/engine-vite-plugin-shader');
  const manifest = shaderManifestUrl(await buildEngineShaderTemplateManifest());
  const surface = offscreenCanvas(WIDTH, HEIGHT);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = await constructRuntimeRendererHost(
    surface.canvas,
    {
      rhi: recorder.backend.rhi,
      rhiInstrumentation: {
        resolveSurfaceDevice: (device) =>
          ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
      },
    },
    { shaderManifestUrl: manifest },
  );
  if (!host.ok) throw host.error;
  const { renderer, assets } = host.value;
  const scene = makeScene(assets);
  const attachment = renderer.attach(scene.world);
  if (!attachment.ok) throw attachment.error;
  const lease = attachment.value;
  const samples = new Map<number, Uint8Array>();
  const errors: unknown[] = [];
  const stop = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  try {
    for (const geometryLane of ['automatic', 'direct'] as const) {
      const completions = [];
      for (let frame = 0; frame < FRAMES; frame++) {
        applyEdits(scene, frame);
        const capture = frame === FRAMES - 1 ? recorder.captureFrame() : undefined;
        if (capture !== undefined) (await recorder.frameBoundary()).unwrap();
        const start = performance.now();
        let attempts = 0;
        const receipt = await drawReadyFrame(renderer, { source: lease, geometryLane }, undefined, {
          afterSubmit: () => {
            attempts++;
          },
        });
        completions.push({
          frame,
          receipt: receipt.frameId,
          elapsedMs: performance.now() - start,
          attempts,
        });
        if (capture !== undefined) {
          (await recorder.frameBoundary()).unwrap();
          const bytes = (await capture).unwrap().bytes;
          writeFileSync(`${EVIDENCE}/${geometryLane}.rhitape`, bytes);
          const tape = decodeTape(bytes).unwrap();
          const model = buildFrameModel(tape);
          const passes = summarizePasses(model);
          writeFileSync(`${EVIDENCE}/${geometryLane}-passes.json`, JSON.stringify(passes, null, 2));
          const mains = passes.filter(({ label }) => label?.split(' + ').includes('main'));
          expect(mains).toHaveLength(2);
          const indirect = model.works.filter(({ kind }) => kind === 'drawIndexedIndirect');
          expect(indirect.length > 0).toBe(geometryLane === 'automatic');
          if (geometryLane === 'direct') {
            const casters = model.works.filter(({ eventIndex }) => {
              const event = tape.events[eventIndex];
              return event?.kind === 'drawIndexed' && event.indexCount === scene.casterIndexCount;
            });
            expect(casters.length).toBeGreaterThan(0);
            for (const caster of casters)
              expect(passes[caster.passIndex]?.label).toMatch(/shadow/i);
          }
        }
        if (!SAMPLE_FRAMES.has(frame)) continue;
        const context = surface.canvas.getContext();
        const texture = context.getCurrentTexture();
        const configuration = context.getConfiguration();
        assert(texture && configuration);
        const pixels = await readCanvas(configuration.device, texture);
        writeFileSync(`${EVIDENCE}/${geometryLane}-${frame}.png`, encodePng(WIDTH, HEIGHT, pixels));
        if (geometryLane === 'automatic') samples.set(frame, pixels);
        else {
          const automatic = samples.get(frame);
          assert(automatic);
          compareFrames(automatic, pixels, frame);
        }
      }
      writeFileSync(
        `${EVIDENCE}/${geometryLane}-completions.json`,
        JSON.stringify(completions, null, 2),
      );
    }
    expect(errors).toEqual([]);
  } finally {
    stop();
    lease.dispose();
    try {
      const disposed = await renderer.dispose();
      expect(disposed.ok).toBe(true);
      (await recorder.dispose()).unwrap();
    } finally {
      surface.destroy();
      URL.revokeObjectURL(manifest);
    }
  }
});
