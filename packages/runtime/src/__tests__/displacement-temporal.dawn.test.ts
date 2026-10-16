import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  halfToFloat,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { expect, it } from 'vitest';
import { createBarrelRendererFixture } from './barrel-distortion-gpu-fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';
import { error, json, save } from './taa-maturity.fixture';

it.each([
  false,
  true,
])('rejects untracked mutable height motion and replays its temporal pixels (skin=%s)', {
  timeout: 240_000,
  retry: 0,
}, async (skin) => {
  const recorder = attachRecorder(webgpu).unwrap();
  const fixture = await createBarrelRendererFixture({
    width: 64,
    height: 64,
    rhi: recorder.backend.rhi,
  });
  const { renderer } = fixture;
  const world = new World();
  const lease = renderValue(renderer.attach(world));
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -2,
          right: 2,
          top: 2,
          bottom: -2,
          near: 0.1,
          far: 10,
          antialias: 3,
          bloom: 0,
          tonemap: 1,
        },
      },
    )
    .unwrap();
  world
    .spawn({ component: DirectionalLight, data: { direction: [0, 0, -1], intensity: 3 } })
    .unwrap();
  const native = renderValue(renderer.nativeDevice());
  const height = native.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 0x7 });
  const upload = (value: number) => {
    const pixels = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([value, value, value, 255], i);
    native.queue.writeTexture({ texture: height }, pixels, { bytesPerRow: 32 }, [8, 8]);
  };
  upload(80);
  const imported = renderValue(
    await renderer.importTexture({ kind: 'gpu-texture', texture: height }),
  );
  const source = world.allocSharedRef('ExternalTextureSource', imported.source);
  let geometry = createPlaneGeometry(2, 2, 8, 8).unwrap();
  const rotation = [0, Math.sin(0.4), 0, Math.cos(0.4)];
  if (skin) {
    const count = (geometry.attributes.position as Float32Array).length / 3;
    const attributes = {
      ...geometry.attributes,
      skinIndex: new Uint16Array(count * 4),
      skinWeight: Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
    };
    geometry = {
      ...geometry,
      attributes,
      vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
    };
  }
  const object = world
    .spawn(
      { component: Transform, data: { quat: rotation } },
      { component: MeshFilter, data: { assetHandle: world.allocSharedRef('MeshAsset', geometry) } },
      { component: MeshRenderer, data: { materials: [] } },
    )
    .unwrap();
  if (skin) {
    const joint = world.spawn({ component: Transform, data: { quat: rotation } }).unwrap();
    const skeleton = world.allocSharedRef('SkeletonAsset', {
      kind: 'skeleton',
      jointCount: 1,
      inverseBindMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      bounds: new Float32Array([-1, -1, -1, 1, 1, 1]),
    });
    world
      .addComponent(object, {
        component: Skin,
        data: { skeleton, joints: new Uint32Array([joint]) },
      })
      .unwrap();
  }
  const setMaterial = (scale: number, bias: number) => {
    let material = Materials.standard({
      baseColor: [0.8, 0.2, 0.1, 1],
      roughness: 1,
      displacementTexture: source,
      displacementScale: scale,
      displacementBias: bias,
    });
    if (skin) {
      if (material.parent !== undefined || material.passes === undefined)
        throw new Error('missing root Standard passes');
      const [first, ...rest] = material.passes;
      const pass = (p: typeof first) => ({
        ...p,
        program: {
          ...p.program,
          module:
            p.program.module === 'forgeax_material::standard'
              ? 'forgeax::pbr-skin'
              : p.program.module,
        },
      });
      material = { ...material, passes: [pass(first), ...rest.map(pass)] };
    }
    world
      .set(object, MeshRenderer, { materials: [world.allocSharedRef('MaterialAsset', material)] })
      .unwrap();
  };
  setMaterial(0.5, 0);
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = renderValue(
      renderer.draw({
        geometryLane: 'direct',
        leases: [lease],
        camera: { lease },
        environment: { lease },
      }),
    );
    renderValue(await receipt.completed);
    return receipt;
  };
  const facts = [];
  try {
    for (const change of ['mutable-height', 'scale', 'bias']) {
      for (let frame = 0; frame < 60; frame++) await draw();
      if (change === 'mutable-height') upload(96);
      if (change === 'scale') setMaterial(0.6, 0);
      if (change === 'bias') setMaterial(0.6, 0.02);
      renderer.requestObservation && renderValue(renderer.requestObservation(['final-display']));
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const receipt = await draw();
      (await recorder.frameBoundary()).unwrap();
      const capture = (await pending).unwrap();
      const prefix = `displacement-${skin ? 'skin' : 'rigid'}-${change}`;
      save(`${prefix}.rhitape`, capture.bytes);
      const tape = decodeTape(capture.bytes).unwrap();
      const model = buildFrameModel(tape);
      const temporal = model.works.find((w) =>
        w.pipeline.shaders.some((s) => s.stage === 'fragment' && s.entryPoint === 'fs_temporal'),
      );
      expect(temporal, 'capture must contain the actual temporal producer').toBeDefined();
      if (!temporal) throw new Error('no temporal work');
      const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const device = (
        await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
      ).unwrap();
      const replay = (
        await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      try {
        const result = (
          await replay.inspectWork(temporal.workIndex, ['pipeline', 'bindings', 'pixels'])
        ).unwrap();
        const image = result.attachment;
        if (!image) throw new Error('missing temporal replay readback');
        save(`${prefix}-temporal.rgba16f`, image.bytes);
        const values = new DataView(
          image.bytes.buffer,
          image.bytes.byteOffset,
          image.bytes.byteLength,
        );
        const center = Array.from({ length: 4 }, (_, lane) =>
          halfToFloat(values.getUint16((32 * 64 + 32) * 8 + lane * 2, true)),
        );
        const live = renderValue(
          await renderer.observe(receipt, { include: ['final-display'] }),
        ).observations?.find((o) => o.domain === 'final-display');
        if (!live) throw new Error('missing final output');
        save(`${prefix}-final.rgba`, live.bytes);
        const output = model.works
          .filter((w) => (w.attachments?.colorViewHandleIds.length ?? 0) > 0)
          .at(-1);
        if (!output) throw new Error('missing final draw');
        const final = (await replay.inspectWork(output.workIndex, ['pixels'])).unwrap().attachment;
        if (!final) throw new Error('missing final replay pixels');
        expect(final.bytes.length).toBe(live.bytes.length);
        const replayError = error(live.bytes, final.bytes);
        expect(
          replayError.maximum,
          'motion invalidity and final display share one completed frame',
        ).toBeLessThanOrEqual(0.05);
        facts.push({
          change,
          skin,
          workIndex: temporal.workIndex,
          center,
          replayError,
          finalMetadata: live.metadata,
          analyticHeightMotionUv:
            change === 'mutable-height' ? (Math.sin(0.8) * (16 / 255) * 0.5) / 4 : null,
          motionContract:
            'mutable height without retained prior shape must explicitly reject history and motion',
          digest: capture.digest,
          unseeded: model.unseededResources,
        });
        json(`displacement-${skin ? 'skin' : 'rigid'}.json`, facts);
        expect(center[2], 'center has actual geometry').toBeGreaterThan(0);
        expect(
          center[3],
          'no exact prior displacement: mark motion invalid, reject color history',
        ).toBeGreaterThanOrEqual(2);
      } finally {
        (await replay.dispose()).unwrap();
        webgpu._internal_getRawDevice(device)?.destroy();
      }
    }
    world.set(camera, Camera, { antialias: 0 }).unwrap();
  } finally {
    renderValue(imported.release());
    await renderer.dispose();
    fixture.renderTarget.destroy();
    height.destroy();
    (await recorder.dispose()).unwrap();
  }
});
