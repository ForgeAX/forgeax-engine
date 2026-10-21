import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  CameraView,
  CubeCamera,
  createRenderPublisher,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  PlanarReflection,
  PointLight,
  type Renderer,
  RenderPublicationTargetOwner,
  type RenderTarget,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  type EncodedTape,
  openReplay,
  type RecorderAttachment,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { compactTape } from './compact-tape.fixture';
import { luminanceRgba16f } from './contact-shadow.fixture';
import { testAssets } from './helpers/runtime-assets';
import { CHANNEL_EPSILON, CHANNEL_SIZE } from './lighting-channels.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing view channel evidence');
  return value;
};

/** Target readbacks prove independent views share one accepted receiver mask. */
export async function verifyChannelViews(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: (name: string, bytes: Uint8Array) => void | Promise<void>,
  publication?: { assets: AssetRegistry; identity: { source: string; epoch: number } },
) {
  const targetOwner = publication === undefined ? undefined : new RenderPublicationTargetOwner();
  const targets = targetOwner?.authoring ?? renderer;
  const world = new World(publication === undefined ? {} : { assets: publication.assets });
  const makeTarget = (shape: '2d' | 'cube') =>
    renderValue(
      targets.createRenderTarget({
        shape,
        width: CHANNEL_SIZE,
        height: CHANNEL_SIZE,
        format: 'rgba16float',
        sampleCount: 1,
        mipLevels: 1,
        sampled: true,
        readback: true,
      }),
    );
  const auxiliary = makeTarget('2d'),
    cube = makeTarget('cube'),
    reflection = makeTarget('2d');
  const mesh = testAssets(world)
    .create(createBoxGeometry(2, 2, 0.05).unwrap())
    .unwrap();
  const material = testAssets(world)
    .create(
      Materials.standard({
        baseColor: [0.5, 0.5, 0.5, 1],
        roughness: 0.7,
        emissive: [0.02, 0.02, 0.02],
        emissiveIntensity: 1,
      }),
    )
    .unwrap();
  const receiver = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -4] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material], lightingChannels: 0x80000000 } },
    )
    .unwrap();
  const sun = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0, 0, -1],
        intensity: 3,
        castShadow: false,
        lightingChannels: 0x80000000,
      },
    })
    .unwrap();
  const cameraData = {
    fov: Math.PI / 3,
    aspect: 1,
    near: 0.1,
    far: 20,
    tonemap: 0,
    bloom: 0,
    antialias: 0,
    clearColor: [0, 0, 0, 1],
  };
  const displays = [0, 1].map((index) =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: Camera, data: cameraData },
        { component: CameraView, data: { viewport: [index / 2, 0, 0.5, 1], order: index } },
      )
      .unwrap(),
  );
  const auxiliaryCamera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: { ...cameraData, target: world.allocSharedRef('RenderTarget', auxiliary) },
      },
    )
    .unwrap();
  const cubeCamera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: CubeCamera,
        data: {
          target: world.allocSharedRef('RenderTarget', cube),
          updateIntent: 1,
          requestVersion: 1,
          faceBudget: 6,
        },
      },
    )
    .unwrap();
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
  let lastTape: EncodedTape | undefined;
  let cubeVersion = 1;
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const draw = async (capture = false) => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    time += 1 / 60;
    return completeReadyFrame(async () => {
      const candidate = publisher?.prepare(time).unwrap();
      const packet =
        candidate === undefined
          ? undefined
          : structuredClone(candidate.packet, {
              transfer: renderPublicationTransfers(candidate.packet),
            });
      candidate?.accept();
      const pending = capture ? recorder.captureFrame() : undefined;
      if (pending) (await recorder.frameBoundary()).unwrap();
      try {
        const receipt = renderValue(
          renderer.draw(
            packet === undefined
              ? {
                  leases: [required(lease)],
                  camera: { lease: required(lease) },
                  environment: { lease: required(lease) },
                }
              : { publication: packet },
          ),
        );
        renderValue(await receipt.completed);
        if (pending) {
          (await recorder.frameBoundary()).unwrap();
          const tape = compactTape((await pending).unwrap());
          lastTape = tape;
          expect(
            decodeTape(tape.bytes)
              .unwrap()
              .events.filter((event) => event.kind === 'submit'),
          ).toHaveLength(1);
          await save(`view-${receipt.frameId}.rhitape`, tape.bytes);
        }
        return receipt;
      } finally {
        if (packet)
          required(publisher).recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
      }
    });
  };
  const read = async (
    outputs: readonly { target: RenderTarget; layer: number; name: string }[],
  ) => {
    // The Renderer admits one cube face per submission, irrespective of the
    // camera's upper budget. Start a new explicit cycle and capture its sixth
    // face; an earlier read legitimately observes the previous active cube.
    if (world.hasComponent(cubeCamera, CubeCamera)) {
      world.set(cubeCamera, CubeCamera, { requestVersion: ++cubeVersion }).unwrap();
      for (let face = 0; face < 5; face++) await draw();
    }
    if (publication !== undefined) {
      await draw(true);
      const tape = decodeTape(required(lastTape).bytes).unwrap();
      const model = buildFrameModel(tape);
      const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const device = (
        await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
      ).unwrap();
      const raw = required(webgpu._internal_getRawDevice(device));
      const replay = (
        await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      try {
        const writers = outputs.map((output) => {
          // Source tokens deliberately cannot address receiver-owned targets.
          // Inspect the real target writer and its physical attachment instead.
          const layers = output.target === cube ? 6 : 1;
          const candidates = model.works.flatMap((work) =>
            (work.attachments?.colorViewHandleIds ?? []).flatMap((viewId) => {
              const view = model.resources.find((resource) => resource.resourceId === viewId);
              const sourceId = (view?.descriptor as { sourceHandleId?: unknown } | undefined)
                ?.sourceHandleId;
              const texture = model.resources.find((resource) => resource.resourceId === sourceId);
              const desc = (texture?.descriptor as { desc?: unknown } | undefined)?.desc as
                | {
                    label?: string;
                    format?: string;
                    size?: { depthOrArrayLayers?: number };
                  }
                | undefined;
              const viewDesc = (view?.descriptor as { desc?: unknown } | undefined)?.desc as
                | { baseArrayLayer?: number }
                | undefined;
              return desc?.label?.startsWith('render-target.') &&
                desc.format === 'rgba16float' &&
                desc.size?.depthOrArrayLayers === layers &&
                (viewDesc?.baseArrayLayer ?? 0) === output.layer &&
                typeof sourceId === 'string'
                ? [{ resourceId: sourceId, workIndex: work.workIndex }]
                : [];
            }),
          );
          return required(candidates.at(-1));
        });
        // Read the exact writer positions and layers together. The replay owner
        // retains standalone execution when a forward split is unsafe.
        const values = (
          await replay.readAtWorks(
            outputs.map((output, index) => ({
              ...required(writers[index]),
              subresource: { mipLevel: 0, arrayLayer: output.layer },
            })),
          )
        ).unwrap();
        const images: Float32Array[] = [];
        for (const [index, output] of outputs.entries()) {
          const writer = required(writers[index]);
          const value = required(values[index]).unwrap();
          expect(value.bytes.byteLength).toBe(CHANNEL_SIZE * CHANNEL_SIZE * 8);
          await save(`${output.name}-${time}.rgba16float`, value.bytes);
          await save(
            `${output.name}-${time}-writer.json`,
            new TextEncoder().encode(
              JSON.stringify({
                ...writer,
                provenance: value.provenance,
                digest: required(lastTape).digest,
              }),
            ),
          );
          images.push(luminanceRgba16f(value.bytes, CHANNEL_SIZE, CHANNEL_SIZE));
        }
        return images;
      } finally {
        (await replay.dispose()).unwrap();
        raw.destroy();
      }
    }
    const tickets = outputs.map((output) =>
      renderValue(
        renderer.requestTargetReadback(output.target, { mipLevel: 0, layer: output.layer }),
      ),
    );
    const result = required(
      renderValue(
        await renderer.observe(await draw(true), {
          include: ['target-readbacks'],
          targetReadbacks: tickets,
        }),
      ).targetReadbacks,
    );
    return Promise.all(
      outputs.map(async (output, index) => {
        const value = required(result[index]);
        expect(value.byteLength).toBe(CHANNEL_SIZE * CHANNEL_SIZE * 8);
        await save(`${output.name}-${time}.rgba16float`, value.bytes);
        return luminanceRgba16f(value.bytes, CHANNEL_SIZE, CHANNEL_SIZE);
      }),
    );
  };
  const center = (image: Float32Array) => image[32 * CHANNEL_SIZE + 32] ?? NaN;
  const same = (a: Float32Array, b: Float32Array) => {
    for (let y = 29; y < 35; y++)
      for (let x = 29; x < 35; x++)
        expect(
          Math.abs((a[y * CHANNEL_SIZE + x] ?? NaN) - (b[y * CHANNEL_SIZE + x] ?? NaN)),
        ).toBeLessThanOrEqual(CHANNEL_EPSILON);
  };
  try {
    for (const path of ['forward', 'deferred'] as const) {
      renderValue(renderer.setProfile({ ...renderer.inspect().profile, renderPath: path }));
      world.set(receiver, MeshRenderer, { lightingChannels: 0x80000000 }).unwrap();
      for (let frame = 0; frame < 8; frame++) await draw();
      const outputs = [
        { target: auxiliary, layer: 0, name: `${path}-auxiliary` },
        { target: cube, layer: 5, name: `${path}-cube-minus-z` },
      ];
      const lit = await read(outputs);
      for (const image of lit) expect(center(image)).toBeGreaterThan(0.03);
      const displayFrames = () =>
        required(renderer.inspect().views)
          .filter((view) => view.output === 'screen')
          .map((view) => view.renderedFrames);
      const held = displayFrames();
      for (const display of displays)
        world.set(display, CameraView, { updateInterval: 64 }).unwrap();
      world.set(receiver, MeshRenderer, { lightingChannels: 0x7fffffff }).unwrap();
      for (let frame = 0; frame < 3; frame++) await draw();
      const dark = await read(outputs);
      expect(displayFrames()).toEqual(held);
      world.set(sun, DirectionalLight, { lightingChannels: 0, intensity: 0 }).unwrap();
      await draw();
      const offImages = await read(outputs);
      for (let i = 0; i < dark.length; i++) {
        same(required(dark[i]), required(offImages[i]));
        expect(center(required(lit[i])) - center(required(dark[i]))).toBeGreaterThan(0.01);
      }
      world.set(sun, DirectionalLight, { lightingChannels: 0x80000000, intensity: 3 }).unwrap();
      for (const [index, display] of displays.entries())
        world
          .set(display, CameraView, {
            updateInterval: 1,
            order: -index,
            resolutionScale: index === 0 ? 0.5 : 1,
          })
          .unwrap();
      await draw(true);
    }
    world.despawn(auxiliaryCamera).unwrap();
    world.despawn(cubeCamera).unwrap();
    // Same receiver facts now feed an ordinary planar capture through its retained half space.
    world.set(receiver, Transform, { pos: [0, 0, -1] }).unwrap();
    world.set(receiver, MeshRenderer, { lightingChannels: 0x80000000 }).unwrap();
    world.set(sun, DirectionalLight, { lightingChannels: 0, intensity: 0 }).unwrap();
    const fill = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -3] } },
        { component: PointLight, data: { intensity: 12, range: 10, lightingChannels: 0x80000000 } },
      )
      .unwrap();
    world
      .addComponent(required(displays[0]), {
        component: PlanarReflection,
        data: {
          target: world.allocSharedRef('RenderTarget', reflection),
          normal: [0, 0, 1],
          distance: 2,
        },
      })
      .unwrap();
    for (let frame = 0; frame < 8; frame++) await draw();
    const outputs = [{ target: reflection, layer: 0, name: 'planar' }];
    const lit = required((await read(outputs))[0]);
    expect(center(lit)).toBeGreaterThan(0.03);
    world.set(receiver, MeshRenderer, { lightingChannels: 0x7fffffff }).unwrap();
    await draw();
    const nonmatch = required((await read(outputs))[0]);
    world.set(fill, PointLight, { lightingChannels: 0, intensity: 0 }).unwrap();
    await draw();
    same(nonmatch, required((await read(outputs))[0]));
    expect(center(lit) - center(nonmatch)).toBeGreaterThan(0.01);
    expect(errors).toEqual([]);
  } finally {
    off();
    lease?.dispose();
    publisher?.dispose();
    for (const target of [auxiliary, cube, reflection])
      renderValue(targets.destroyRenderTarget(target));
    targetOwner?.dispose();
  }
}
