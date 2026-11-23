import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Camera, Materials, MeshFilter, MeshRenderer, Skylight } from '@forgeax/engine-render';
import type {
  RendererHostAssembly,
  RendererLegacyHostAdapter,
} from '@forgeax/engine-render/internal/construct-renderer';
import type { EncodedTape, RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../../scripts/test/ready-render-frame.mjs';
import { decodeMaterialNormalX12Y12 } from '../../../../render/src/__tests__/gtao-reference';
import {
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_STORAGE,
} from '../../../../render/src/gpu-usage';
import {
  byteErrorMetrics,
  captureForwardGtaoTarget,
  type ForwardGtaoCaptureHost,
} from './forward-gtao-capture';
import { describeForwardGtaoFailure } from './forward-gtao-failure';
import type { createForwardGtaoSceneDataConsumer } from './forward-gtao-scene-data';
import {
  attachStandardPbrSkin,
  standardPbrSkinMaterial,
  standardPbrSkinMesh,
} from './standard-pbr-skin-subject';

export const UNLIT_AO_SIZE = 64;

/** Real color/depth/normal coverage, on both direct and scene-index submissions. */
export async function verifyUnlitAo(
  host: RendererHostAssembly,
  recorder: RecorderAttachment,
  onTape: (lane: string, tape: EncodedTape) => Promise<void>,
  surface?: ReturnType<typeof createForwardGtaoSceneDataConsumer>,
) {
  const { renderer, assets } = host;
  const debug = host.debugDrawHost as ForwardGtaoCaptureHost &
    Pick<RendererLegacyHostAdapter, 'setClusterWorkObservationForConformance'>;
  debug.setClusterWorkObservationForConformance(true);
  const observationBuffer =
    surface === undefined
      ? undefined
      : debug.device
          .createBuffer({
            label: 'unlit-ao-surface-readback',
            size: surface.observationBytes,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_STORAGE,
          })
          .unwrap();
  if (surface !== undefined && observationBuffer !== undefined) {
    surface.setObservationBuffer(observationBuffer);
    surface.setEnabled(true);
  }
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World({ assets });
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 30,
          antialias: 0,
          bloom: 0,
          tonemap: 0,
        },
      },
    )
    .unwrap();
  world.spawn({ component: Skylight, data: {} }).unwrap();
  const backgroundMesh = assets.create(createBoxGeometry(10, 10, 0.1).unwrap()).unwrap();
  const backgroundMaterial = assets
    .create(Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] }))
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -4] } },
      { component: MeshFilter, data: { assetHandle: backgroundMesh } },
      { component: MeshRenderer, data: { materials: [backgroundMaterial] } },
    )
    .unwrap();
  const source = createBoxGeometry(1.5, 1.5, 0.1).unwrap();
  const mesh = assets.create(source).unwrap();
  const skinMesh = assets.create(standardPbrSkinMesh(source)).unwrap();
  const alphaTexture = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array([255, 255, 255, 255]),
    })
    .unwrap();
  const material = assets
    .create(
      Materials.unlit([0.8, 0.3, 0.1, 1], { alphaTexture, alphaChannel: 3, alphaCutoff: 0.5 }),
    )
    .unwrap();
  const angle = 0.4;
  const pose = { pos: [0, 0, -3], quat: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)] };
  const subject = world
    .spawn(
      { component: Transform, data: pose },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  const draw = async (geometryLane: 'automatic' | 'direct') => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    try {
      return await drawReadyFrame(renderer, {
        source: lease,
        camera: { entityKey: camera },
        geometryLane,
      });
    } catch (cause) {
      throw new Error(JSON.stringify(describeForwardGtaoFailure(cause)), { cause });
    }
  };
  const centerNormal = (capture: Awaited<ReturnType<typeof captureForwardGtaoTarget>>) => {
    expect(capture.format).toBe('r32uint');
    const pixel = Math.floor(capture.height / 2) * capture.width + Math.floor(capture.width / 2);
    const bytes = new DataView(
      capture.bytes.buffer,
      capture.bytes.byteOffset,
      capture.bytes.byteLength,
    );
    return decodeMaterialNormalX12Y12(bytes.getUint32(pixel * 4, true));
  };
  const nearNormal = (actual: readonly number[], expected: readonly number[]) => {
    for (let axis = 0; axis < 3; axis++) expect(actual[axis]).toBeCloseTo(expected[axis] ?? NaN, 1);
  };
  const expectNormal = async (lane: 'automatic' | 'direct', expected: readonly number[]) => {
    if (surface === undefined) return;
    const normal = await captureForwardGtaoTarget(debug, 'standard-scene-surface-normal', () =>
      draw(lane),
    );
    nearNormal(centerNormal(normal), expected);
  };
  const captureAo = (lane: 'automatic' | 'direct') =>
    captureForwardGtaoTarget(debug, 'ssao-calc', () => draw(lane));
  try {
    for (const algorithm of ['ssao', 'gtao'] as const) {
      const configured = renderer.setProfile({
        ...renderer.inspect().profile,
        renderPath: 'forward',
        ambientOcclusion: { enabled: true, method: algorithm },
      });
      if (!configured.ok) throw configured.error;
      for (const geometryLane of ['automatic', 'direct'] as const) {
        // No authored normal texture: AO must see the rotated mesh surface.
        for (let frame = 0; frame < 60; frame++) await draw(geometryLane);
        const _capture = () =>
          captureForwardGtaoTarget(debug, 'standard-scene-surface-normal', () =>
            draw(geometryLane),
          );
        await expectNormal(geometryLane, [Math.sin(angle), 0, Math.cos(angle)]);
        const opaqueAo = await captureForwardGtaoTarget(debug, 'ssao-calc', () =>
          draw(geometryLane),
        );
        // Alpha Mask holes reveal the actual background normal, not a phantom foreground.
        assets.update(material, { values: { baseColor: [0.8, 0.3, 0.1, 0] } }).unwrap();
        await expectNormal(geometryLane, [0, 0, 1]);
        const maskedAo = await captureForwardGtaoTarget(debug, 'ssao-calc', () =>
          draw(geometryLane),
        );
        expect(opaqueAo.format).toBe('r8unorm');
        expect(byteErrorMetrics(opaqueAo.bytes, maskedAo.bytes).maxAbsolute).toBeGreaterThan(0);
        assets.update(material, { values: { baseColor: [0.8, 0.3, 0.1, 1] } }).unwrap();
        await expectNormal(geometryLane, [Math.sin(angle), 0, Math.cos(angle)]);
        assets.update(alphaTexture, { data: new Uint8Array([255, 255, 255, 0]) }).unwrap();
        await expectNormal(geometryLane, [0, 0, 1]);
        assets.update(alphaTexture, { data: new Uint8Array([255, 255, 255, 255]) }).unwrap();
        await expectNormal(geometryLane, [Math.sin(angle), 0, Math.cos(angle)]);
        expect(renderer.inspect().standardLighting?.ambientOcclusion).toMatchObject({
          status: 'active',
          requestedMethod: algorithm,
          effectiveMethod: 'ssao',
          input: { normalSchema: 'depth-reconstruction' },
        });
      }
    }
    // Standard PBR-Skin must retain its posed surface normal alongside Unlit AO.
    const skinMaterial = assets
      .create(standardPbrSkinMaterial(Materials.standard({ baseColor: [0.8, 0.3, 0.1, 1] })))
      .unwrap();
    world.set(subject, MeshRenderer, { materials: [skinMaterial] }).unwrap();
    world.set(subject, MeshFilter, { assetHandle: skinMesh }).unwrap();
    world.set(subject, Transform, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }).unwrap();
    const skin = attachStandardPbrSkin(world, assets, subject, [0, 0, -3]);
    world.set(skin.joint, Transform, pose).unwrap();
    for (const geometryLane of ['automatic', 'direct'] as const) {
      for (let frame = 0; frame < 60; frame++) await draw(geometryLane);
      const pendingTape = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      await draw(geometryLane);
      (await recorder.frameBoundary()).unwrap();
      await onTape(geometryLane, (await pendingTape).unwrap());
      await expectNormal(geometryLane, [Math.sin(angle), 0, Math.cos(angle)]);
      const posed = await captureAo(geometryLane);
      world
        .set(skin.joint, Transform, {
          ...pose,
          quat: [0, -Math.sin(angle / 2), 0, Math.cos(angle / 2)],
        })
        .unwrap();
      await expectNormal(geometryLane, [-Math.sin(angle), 0, Math.cos(angle)]);
      const moved = await captureAo(geometryLane);
      expect(byteErrorMetrics(posed.bytes, moved.bytes).maxAbsolute).toBeGreaterThan(0);
      world.set(skin.joint, Transform, pose).unwrap();
    }
    expect(errors).toEqual([]);
  } finally {
    lease.dispose();
    unsubscribe();
    debug.setClusterWorkObservationForConformance(false);
    surface?.setEnabled(false);
    if (observationBuffer !== undefined)
      (await debug.device.destroyBuffer(observationBuffer)).unwrap();
  }
}
