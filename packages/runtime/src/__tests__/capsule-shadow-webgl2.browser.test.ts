import { World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_MSAA,
  Camera,
  DirectionalLight,
  ShadowParticipation,
} from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRendererHost } from '../../../render/src/construct-renderer';
import { loadRhiPack } from '../backend-selection';
import {
  buildCapsuleScene,
  CAPSULE_SHADOW_SIZE,
  type CapsuleShadowVariant,
  setVariant,
  shadowMask,
} from './capsule-shadow.fixture';
import { compactTape } from './compact-tape.fixture';
import { luminanceRgba16f } from './contact-shadow.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const DIRECTORY = 'artifacts/ci-focus/capsule-shadow-webgl2';
async function save(name: string, bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  await commands.writeFile(`${DIRECTORY}/${name}`, btoa(binary), 'base64');
}

it('replaces Forward skinned cascades with posed capsule visibility on WebGL2', {
  timeout: 240_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CAPSULE_SHADOW_SIZE;
  document.body.append(canvas);
  const recorder = attachRecorder(wgpu).unwrap();
  const host = renderValue(
    await constructRendererHost(
      canvas,
      undefined,
      { shaderManifestUrl: '/shaders/manifest.json' },
      loadRhiPack(
        { ...recorder.backend },
        {
          resolveSurfaceDevice: (device) =>
            ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
        },
      ),
    ),
  );
  const { renderer, assets } = host;
  const world = new World({ assets });
  const scene = buildCapsuleScene(world, assets, false);
  const lease = renderValue(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const draw = async (capture = false) => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    return drawReadyFrame(
      renderer,
      { leases: [lease], camera: { lease }, environment: { lease } },
      capture ? ['linear-hdr'] : undefined,
    );
  };
  const sample = async (name: string, variant: CapsuleShadowVariant, frames = 60) => {
    setVariant(world, scene, variant);
    for (let frame = 0; frame < frames; frame++) await draw();
    const receipt = await draw(true);
    const image = renderValue(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations?.find((image) => image.domain === 'linear-hdr');
    if (image === undefined) throw new Error('missing completed capsule-shadow image');
    const shot = await page.elementLocator(canvas).screenshot({ base64: true });
    await commands.writeFile(
      `${DIRECTORY}/${name}.png`,
      typeof shot === 'string' ? shot : shot.base64,
      'base64',
    );
    await save(`${name}.rgba16f`, image.bytes);
    return {
      luminance: luminanceRgba16f(
        image.bytes,
        CAPSULE_SHADOW_SIZE,
        CAPSULE_SHADOW_SIZE,
        image.metadata.bytesPerRow,
      ),
      inspection: renderer.inspect().capsuleShadow,
    };
  };
  const captureFrame = async (name: string) => {
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await draw();
    (await recorder.frameBoundary()).unwrap();
    const tape = compactTape((await capture).unwrap());
    await save(`${name}.rhitape`, tape.bytes);
    return buildFrameModel(decodeTape(tape.bytes).unwrap());
  };
  const cascadeWorks = (model: ReturnType<typeof buildFrameModel>) =>
    model.works.filter(
      (work) =>
        work.attachments !== null &&
        work.attachments.colorViewHandleIds.length === 0 &&
        work.attachments.depthStencilViewHandleId !== null,
    );
  try {
    expect(renderer.inspect().capabilities.backendKind).toBe('wgpu-webgl2');
    const none = await sample('none', 'none');
    const raster = await sample('raster', 'raster');
    const rasterModel = await captureFrame('raster');
    const capsule = await sample('capsule', 'capsule');
    const model = await captureFrame('capsule');
    const rasterShadow = shadowMask(none.luminance, raster.luminance, CAPSULE_SHADOW_SIZE);
    const capsuleShadow = shadowMask(none.luminance, capsule.luminance, CAPSULE_SHADOW_SIZE);
    expect(capsule.inspection).toMatchObject({
      requested: 1,
      admitted: 1,
      capsuleCount: 1,
      droppedCapsules: 0,
      tileOverflow: 0,
      fallbacks: {},
    });
    expect(capsuleShadow.stats.maxDarken).toBeGreaterThan(0.1);
    expect(capsuleShadow.stats.pixels).toBeGreaterThan(rasterShadow.stats.pixels * 0.5);
    expect(capsuleShadow.stats.pixels).toBeLessThan(rasterShadow.stats.pixels * 2.5);
    let covered = 0;
    for (let i = 0; i < rasterShadow.mask.length; i++)
      if (rasterShadow.mask[i] && capsuleShadow.mask[i]) covered++;
    expect(covered / rasterShadow.stats.pixels).toBeGreaterThan(0.6);
    expect(model.works.some((work) => work.kind === 'dispatchWorkgroups')).toBe(false);
    expect(cascadeWorks(model).length).toBeLessThan(cascadeWorks(rasterModel).length);
    world
      .addComponent(scene.receiver, { component: ShadowParticipation, data: { receive: false } })
      .unwrap();
    world
      .addComponent(scene.character, { component: ShadowParticipation, data: { receive: false } })
      .unwrap();
    const optOut = await sample('receiver-opt-out', 'capsule', 2);
    const optOutNone = await sample('receiver-opt-out-none', 'none', 2);
    expect(
      shadowMask(optOutNone.luminance, optOut.luminance, CAPSULE_SHADOW_SIZE).stats.pixels,
    ).toBe(0);
    world.set(scene.receiver, ShadowParticipation, { receive: true }).unwrap();
    world.set(scene.character, ShadowParticipation, { receive: true }).unwrap();
    world.set(scene.joint, Transform, { pos: [0.7, 0.8, 0] }).unwrap();
    const movedNone = await sample('moved-none', 'none', 2);
    const moved = await sample('moved', 'capsule', 2);
    const movedShadow = shadowMask(movedNone.luminance, moved.luminance, CAPSULE_SHADOW_SIZE);
    expect(movedShadow.stats.maxDarken).toBeGreaterThan(0.1);
    expect(
      Math.hypot(
        movedShadow.stats.centroid[0] - capsuleShadow.stats.centroid[0],
        movedShadow.stats.centroid[1] - capsuleShadow.stats.centroid[1],
      ),
    ).toBeGreaterThan(5);
    // Reuse the single-sample surface while the main Forward target uses MSAA.
    world.set(scene.camera, Camera, { antialias: ANTIALIAS_MSAA }).unwrap();
    world.set(scene.light, DirectionalLight, { contactShadowLength: 0.2 }).unwrap();
    const combined = await sample('msaa-contact-capsule', 'capsule');
    expect(combined.inspection?.admitted).toBe(1);
    expect(errors, JSON.stringify(errors)).toEqual([]);
    await commands.writeFile(
      `${DIRECTORY}/evidence.json`,
      JSON.stringify({
        raster: rasterShadow.stats,
        capsule: capsuleShadow.stats,
        moved: movedShadow.stats,
        inspection: combined.inspection,
        completedFramesPerCoreState: 60,
        errors,
      }),
    );
  } finally {
    unsubscribe();
    renderer.dispose();
    (await recorder.dispose()).unwrap();
    canvas.remove();
  }
});
