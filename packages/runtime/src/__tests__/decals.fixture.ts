import { World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createDecalGeometry,
  createPlaneGeometry,
} from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  ProjectedDecal,
  type Renderer,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  encodeTape,
  halfToFloat,
  openReplay,
  type RecorderAttachment,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { ChildOf, propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { TextureAsset } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { verifyMeshDecalReplay } from './decals-mesh-replay.fixture';

type Save = (name: string, bytes: Uint8Array) => void | Promise<void>;
const json = (data: unknown) => new TextEncoder().encode(JSON.stringify(data, null, 2));
function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw r.error;
  return r.value;
}
function patch(pixels: number[], x: number, y: number, radius = 2): [number, number, number] {
  const sum = [0, 0, 0];
  let n = 0;
  for (let py = y - radius; py <= y + radius; py++)
    for (let px = x - radius; px <= x + radius; px++) {
      for (let c = 0; c < 3; c++)
        sum[c] = (sum[c] as number) + (pixels[(py * 128 + px) * 4 + c] as number);
      n++;
    }
  return sum.map((v) => v / n) as [number, number, number];
}
function delta(a: number[], b: number[]) {
  return Math.max(...a.map((v, i) => Math.abs(v - (b[i] as number))));
}
function texture(data: number[]): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(data),
  };
}

export async function verifyDecals(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: Save,
  settleFrames = 60,
) {
  const world = new World();
  const errors: unknown[] = [];
  const report: unknown[] = [];
  const originalProfile = renderer.inspect().profile;
  value(
    renderer.setProfile({
      ...originalProfile,
      renderPath: 'deferred',
      ssao: false,
    }),
  );
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const plane = createPlaneGeometry(3.6, 3.6).unwrap();
  const receiverMaterial = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.3, 0.3, 0.3, 1], roughness: 0.65 }),
  );
  const receiver = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: world.allocSharedRef('MeshAsset', plane) } },
      { component: MeshRenderer, data: { materials: [receiverMaterial] } },
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          aspect: 1,
          fov: Math.PI / 3,
          near: 0.1,
          far: 20,
          antialias: 0,
          tonemap: 0,
          bloom: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [0, 0, -1], intensity: 2, castShadow: false },
    })
    .unwrap();
  const red = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.8, 0.01, 0.01, 1], roughness: 0.8 }),
  );
  const green = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.01, 0.8, 0.01, 1], roughness: 0.8 }),
  );
  const decal = world
    .spawn(
      { component: Transform, data: { scale: [1.6, 1.6, 0.2] } },
      { component: ProjectedDecal, data: { material: red, opacity: 0, roughnessOpacity: 0 } },
    )
    .unwrap();
  const lease = value(renderer.attach(world));
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = value(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    );
    value(await receipt.completed);
    return receipt;
  };
  const observe = async (name: string) => {
    if (!renderer.requestObservation) throw new Error('observation unavailable');
    value(renderer.requestObservation(['linear-hdr']));
    const receipt = await draw();
    const observations = value(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations;
    const hdr = observations?.find((o) => o.domain === 'linear-hdr');
    if (!hdr) throw new Error('missing linear HDR observation');
    const pixels: number[] = [];
    const view = new DataView(hdr.bytes.buffer, hdr.bytes.byteOffset, hdr.bytes.byteLength);
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 512; x++)
        pixels.push(halfToFloat(view.getUint16(y * hdr.metadata.bytesPerRow + x * 2, true)));
    // Display preview of the actual HDR readback; assertions use unclamped linear samples.
    const rgba = Uint8Array.from(pixels, (value, index) => {
      if (index % 4 === 3) return 255;
      const linear = Math.max(0, Math.min(1, value));
      return Math.round(
        (linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055) * 255,
      );
    });
    await save(`${name}.rgba`, rgba);
    report.push({
      name,
      center: patch(pixels, 64, 64),
      passes: renderer.inspect().perFramePassNames,
    });
    return pixels;
  };
  try {
    for (let i = 0; i < 3; i++) await draw();
    const off = await observe('off');
    expect(renderer.inspect().perFramePassNames.filter((p) => p.startsWith('decal-'))).toEqual([]);
    world.set(decal, ProjectedDecal, { opacity: 1 }).unwrap();
    for (let i = 0; i < settleFrames; i++) await draw();
    const initialCapture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const on = await observe('gpu-red');
    (await recorder.frameBoundary()).unwrap();
    await save('gpu-red.rhitape', (await initialCapture).unwrap().bytes);
    expect(patch(on, 64, 64)[0]).toBeGreaterThan(patch(on, 64, 64)[1] * 2);
    expect(delta(patch(on, 24, 64), patch(off, 24, 64))).toBeLessThan(0.002);
    expect(renderer.inspect().perFramePassNames).toContain('decal-project');
    world.set(decal, Transform, { pos: [0, 0, -1] }).unwrap();
    expect(delta(patch(await observe('outside-depth'), 64, 64), patch(off, 64, 64))).toBeLessThan(
      0.002,
    );
    world.set(decal, Transform, { pos: [0, 0, 0], quat: [0, 1, 0, 0] }).unwrap();
    expect(delta(patch(await observe('back-facing'), 64, 64), patch(off, 64, 64))).toBeLessThan(
      0.002,
    );
    world.set(decal, Transform, { quat: [0, 0, 0, 1] }).unwrap();
    const occluder = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0.5] } },
        {
          component: MeshFilter,
          data: {
            assetHandle: world.allocSharedRef(
              'MeshAsset',
              createBoxGeometry(0.5, 0.5, 0.1).unwrap(),
            ),
          },
        },
        { component: MeshRenderer, data: { materials: [receiverMaterial] } },
      )
      .unwrap();
    const occluded = await observe('occluded');
    expect(delta(patch(occluded, 64, 64), patch(off, 64, 64))).toBeLessThan(0.015);
    world.despawn(occluder).unwrap();
    const second = world
      .spawn(
        { component: Transform, data: { scale: [1.6, 1.6, 0.2] } },
        { component: ProjectedDecal, data: { material: green, order: 1, roughnessOpacity: 0 } },
      )
      .unwrap();
    const overlap = await observe('overlap-green');
    expect(patch(overlap, 64, 64)[1]).toBeGreaterThan(patch(overlap, 64, 64)[0] * 2);
    world.set(decal, ProjectedDecal, { order: 2 }).unwrap();
    expect(delta(patch(await observe('overlap-red'), 64, 64), patch(on, 64, 64))).toBeLessThan(
      0.005,
    );
    world.despawn(second).unwrap();
    const pattern = world.allocSharedRef(
      'TextureAsset',
      texture([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0]),
    );
    const textured = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [1, 1, 1, 1], baseColorTexture: pattern }),
    );
    world.set(decal, ProjectedDecal, { material: textured }).unwrap();
    const mapped = await observe('gpu-texture');
    expect(patch(mapped, 50, 50)[0]).toBeGreaterThan(patch(mapped, 50, 50)[2] * 2);
    expect(patch(mapped, 77, 50)[1]).toBeGreaterThan(patch(mapped, 77, 50)[0] * 2);
    expect(patch(mapped, 50, 77)[2]).toBeGreaterThan(patch(mapped, 50, 77)[0] * 2);
    const normal = world.allocSharedRef(
      'TextureAsset',
      texture(Array(4).fill([230, 128, 255, 255]).flat()),
    );
    const surface = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [1, 1, 1, 1], normalTexture: normal, roughness: 0.08 }),
    );
    world
      .set(decal, ProjectedDecal, {
        material: surface,
        colorOpacity: 0,
        normalOpacity: 1,
        roughnessOpacity: 0,
      })
      .unwrap();
    const normalOnly = await observe('normal-only');
    expect(delta(patch(normalOnly, 64, 64), patch(off, 64, 64))).toBeGreaterThan(0.025);
    world.set(decal, ProjectedDecal, { normalOpacity: 0, roughnessOpacity: 1 }).unwrap();
    expect(
      delta(patch(await observe('roughness-only'), 64, 64), patch(off, 64, 64)),
    ).toBeGreaterThan(0.025);
    world
      .set(decal, ProjectedDecal, { material: red, colorOpacity: 1, roughnessOpacity: 0 })
      .unwrap();
    const capturePending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const live = await observe('captured');
    (await recorder.frameBoundary()).unwrap();
    const capture = (await capturePending).unwrap();
    await save('decals.rhitape', capture.bytes);
    const tape = decodeTape(capture.bytes).unwrap();
    const model = buildFrameModel(tape);
    await save('frame-model.json', json(model));
    const projectWork = model.works.find((w) =>
      w.pipeline.shaders.some((s) => s.source?.includes('struct DecalParams')),
    );
    const applyWork = model.works.find((w) =>
      w.pipeline.shaders.some((s) => s.source?.includes('struct DecalSurfaceOutput')),
    );
    const lighting = model.works.find((w) =>
      w.pipeline.shaders.some((s) => s.entryPoint?.startsWith('fs_standard_deferred')),
    );
    if (!projectWork || !applyWork) throw new Error('missing decal work in real frame');
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const replay = (
      await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      for (const work of [projectWork, applyWork]) {
        const inspected = (
          await replay.inspectWork(work.workIndex, ['pipeline', 'bindings', 'pixels'])
        ).unwrap();
        expect(inspected.attachment).toBeDefined();
        await save(`work-${work.workIndex}.json`, json(inspected));
      }
      // Last HDR writer before tone/output conversion owns the live linear observation.
      const hdrWork =
        lighting ??
        model.works.find((w) => w.pipeline.shaders.some((s) => s.source?.includes('fs_deferred')));
      if (!hdrWork) throw new Error('missing deferred lighting work');
      const result = (await replay.inspectWork(hdrWork.workIndex, ['pixels'])).unwrap();
      if (!result.attachment || result.attachment.format !== 'rgba16float')
        throw new Error('missing HDR replay pixels');
      const a = result.attachment;
      const pixels: number[] = [];
      const view = new DataView(a.bytes.buffer, a.bytes.byteOffset, a.bytes.byteLength);
      for (let y = 0; y < 128; y++)
        for (let x = 0; x < 512; x++)
          pixels.push(halfToFloat(view.getUint16(y * 128 * 8 + x * 2, true)));
      const maximum = pixels.reduce((m, v, i) => Math.max(m, Math.abs(v - (live[i] as number))), 0);
      expect(maximum).toBeLessThanOrEqual(0.002);
      report.push({
        digest: capture.digest,
        project: projectWork.workIndex,
        apply: applyWork.workIndex,
        lighting: hdrWork.workIndex,
        maxLiveReplayError: maximum,
        unseededResources: model.unseededResources,
      });
      const changed = encodeTape({
        ...tape,
        events: tape.events.map((event, index) =>
          index === projectWork.eventIndex && event.kind === 'draw'
            ? { ...event, vertexCount: 0 }
            : event,
        ),
      }).unwrap();
      const falsifier = (
        await openReplay(decodeTape(changed).unwrap(), {
          device,
          createShaderModule: webgpu.createShaderModule,
        })
      ).unwrap();
      try {
        const inspect = (await falsifier.inspectWork(hdrWork.workIndex, ['pixels'])).unwrap();
        if (!inspect.attachment) throw new Error('missing falsifier pixels');
        expect(Array.from(inspect.attachment.bytes)).not.toEqual(Array.from(a.bytes));
      } finally {
        (await falsifier.dispose()).unwrap();
      }
    } finally {
      (await replay.dispose()).unwrap();
    }
    const activeProfile = renderer.inspect().profile;
    value(renderer.setProfile({ ...activeProfile, renderPath: 'forward' }));
    const unavailable = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) expect(unavailable.error.code).toBe('projected-decal-invalid');
    value(renderer.setProfile(activeProfile));
    world.set(camera, Camera, { antialias: 2 }).unwrap();
    const multisampled = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    expect(multisampled.ok).toBe(false);
    if (!multisampled.ok) expect(multisampled.error.code).toBe('projected-decal-invalid');
    world.set(camera, Camera, { antialias: 0 }).unwrap();
    expect(delta(patch(await observe('gpu-recovered'), 64, 64), patch(on, 64, 64))).toBeLessThan(
      0.005,
    );
    world.set(decal, ProjectedDecal, { opacity: 0 }).unwrap();
    const removed = await observe('gpu-removed');
    expect(delta(removed, off)).toBeLessThan(0.002);
    expect(renderer.inspect().perFramePassNames.filter((p) => p.startsWith('decal-'))).toEqual([]);
    const mesh = createDecalGeometry(plane, {
      transform: mat4.fromScaling(mat4.create(), [1.6, 1.6, 0.2]),
    }).unwrap();
    if (!mesh) throw new Error('missing mesh decal');
    const meshPaint = Materials.unlit([1, 1, 1, 1], {
      baseColorTexture: pattern,
      queue: 3000,
      renderState: {
        depthWriteEnabled: false,
        depthCompare: 'less',
        depthBias: -2,
        depthBiasSlopeScale: -2,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      },
    });
    const meshMaterial = world.allocSharedRef('MaterialAsset', meshPaint);
    const meshEntity = world
      .spawn(
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent: receiver } },
        { component: MeshFilter, data: { assetHandle: world.allocSharedRef('MeshAsset', mesh) } },
        { component: MeshRenderer, data: { materials: [meshMaterial] } },
      )
      .unwrap();
    for (let i = 0; i < settleFrames; i++) await draw();
    const meshCapture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const meshPixels = await observe('mesh-texture');
    (await recorder.frameBoundary()).unwrap();
    const meshTape = (await meshCapture).unwrap();
    await save('mesh.rhitape', meshTape.bytes);
    await verifyMeshDecalReplay(meshTape.bytes, meshPixels, save);
    expect(patch(meshPixels, 50, 50)[0]).toBeGreaterThan(patch(meshPixels, 50, 50)[2] * 2);
    expect(patch(meshPixels, 50, 77)[2]).toBeGreaterThan(patch(meshPixels, 50, 77)[0] * 2);
    const firstMeshPass = meshPaint.passes?.[0];
    if (!firstMeshPass) throw new Error('missing mesh material pass');
    const wrongBias = world.allocSharedRef('MaterialAsset', {
      ...meshPaint,
      passes: [
        {
          ...firstMeshPass,
          renderState: { ...firstMeshPass.renderState, depthBias: 64, depthBiasSlopeScale: 2 },
        },
      ],
    });
    world.set(meshEntity, MeshRenderer, { materials: [wrongBias] }).unwrap();
    const wrongBiasCapture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const noBias = await observe('mesh-wrong-bias');
    (await recorder.frameBoundary()).unwrap();
    await save('mesh-wrong-bias.rhitape', (await wrongBiasCapture).unwrap().bytes);
    const reds = (pixels: number[]) => pixels.filter((v, i) => i % 4 === 0 && v > 0.7).length;
    expect(reds(noBias)).toBeLessThan(reds(meshPixels) / 2);
    world.set(meshEntity, MeshRenderer, { materials: [meshMaterial] }).unwrap();
    for (const x of [-0.5, 0.5]) {
      world.set(camera, Transform, { pos: [x, 0.2, 4] }).unwrap();
      const image = await observe(`mesh-camera-${x}`);
      expect(image.filter((v, i) => i % 4 === 0 && v > 0.7).length).toBeGreaterThan(50);
    }
    world.set(camera, Transform, { pos: [0, 0, 4] }).unwrap();
    world.set(receiver, Transform, { pos: [0.4, 0.2, 0], scale: [0.8, 1.2, 1] }).unwrap();
    expect(reds(await observe('mesh-rigid-move'))).toBeGreaterThan(50);
    world.despawn(meshEntity).unwrap();
    world.despawn(receiver).unwrap();
    await draw();
    expect(errors, JSON.stringify(errors)).toEqual([]);
    await save('report.json', json(report));
  } catch (error) {
    await save(
      'failure.json',
      json({ error: String(error), errors, report, inspect: renderer.inspect() }),
    );
    throw error;
  } finally {
    unsubscribe();
    lease.dispose();
    value(renderer.setProfile(originalProfile));
  }
}
