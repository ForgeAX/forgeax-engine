import { World } from '@forgeax/engine-ecs';
import { createMeshBuilder, createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Instances,
  Materials,
  MeshFilter,
  MeshRenderer,
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
import { compactTape } from './compact-tape.fixture';
import { readPixel } from './oit.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const WIDTH = 440,
  HEIGHT = 300,
  COUNT = 260;
const DIRECTORY = 'artifacts/ci-focus/instance-lod-webgl2';
async function save(name: string, bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  await commands.writeFile(`${DIRECTORY}/${name}`, btoa(binary), 'base64');
}

it('batches 260 alternating instance LODs into six WebGL2 page draws without losing identities', {
  timeout: 240_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
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
  const lease = renderValue(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const geometry = (low: boolean) => {
    const base = createPlaneGeometry(0.14, 0.14, low ? 1 : 4, low ? 1 : 4).unwrap();
    if (base.indices === undefined) throw new Error('missing indexed LOD geometry');
    const vertices = (base.attributes.position as Float32Array).length / 3;
    const color = Float32Array.from({ length: vertices * 4 }, (_, i) =>
      i % 4 === (low ? 1 : 0) || i % 4 === 3 ? 1 : 0,
    );
    return createMeshBuilder({ attributes: { ...base.attributes, color }, indices: base.indices })
      .build()
      .unwrap();
  };
  const lower = assets.create(geometry(true)).unwrap();
  const mesh = assets
    .create({ ...geometry(false), lods: [{ mesh: lower, screenCoverage: 0.04 }], lodHysteresis: 0 })
    .unwrap();
  const transforms = new Float32Array(COUNT * 16);
  for (let ordinal = 0; ordinal < COUNT; ordinal++) {
    const base = ordinal * 16;
    transforms[base] = transforms[base + 5] = transforms[base + 10] = ordinal % 2 === 0 ? 1 : 0.3;
    transforms[base + 15] = 1;
    transforms[base + 12] = ((ordinal % 20) - 9.5) * 0.2;
    transforms[base + 13] = (Math.floor(ordinal / 20) - 6) * 0.2;
  }
  const object = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      {
        component: MeshRenderer,
        data: {
          materials: [
            assets
              .create(
                Materials.standard({
                  baseColor: [1, 1, 1, 1],
                  roughness: 1,
                  specular: 0,
                  renderState: { cullMode: 'none' },
                }),
              )
              .unwrap(),
          ],
        },
      },
      { component: Instances, data: { transforms } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -2.2,
          right: 2.2,
          bottom: -1.5,
          top: 1.5,
          near: 0.1,
          far: 10,
          tonemap: 1,
          antialias: 0,
          aspect: WIDTH / HEIGHT,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0, 0, -1],
        intensity: 3,
        castShadow: true,
        cascadeCount: 1,
        mapSize: 256,
        shadowDistance: 10,
        staticShadowCache: false,
      },
    })
    .unwrap();
  const draw = async (capture = false) => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    return drawReadyFrame(
      renderer,
      { leases: [lease], camera: { lease }, environment: { lease } },
      capture ? ['linear-hdr'] : undefined,
    );
  };
  const sample = async (name: string, expectedLow: (ordinal: number) => boolean, count = COUNT) => {
    for (let frame = 0; frame < 60; frame++) await draw();
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const receipt = await draw(true);
    (await recorder.frameBoundary()).unwrap();
    const tape = compactTape((await pending).unwrap());
    await save(`${name}.rhitape`, tape.bytes);
    const image = renderValue(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations?.find((image) => image.domain === 'linear-hdr');
    if (image === undefined) throw new Error('missing completed instance LOD pixels');
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const x = Math.floor(((((ordinal % 20) - 9.5) * 0.2 + 2.2) / 4.4) * WIDTH);
      const y = Math.floor(((1.5 - (Math.floor(ordinal / 20) - 6) * 0.2) / 3) * HEIGHT);
      const color = readPixel(image.bytes, image.metadata, x, y);
      expect(
        color[expectedLow(ordinal) ? 1 : 0],
        `${name} ordinal ${ordinal}: ${color}`,
      ).toBeGreaterThan(0.2);
      expect(
        color[expectedLow(ordinal) ? 0 : 1],
        `${name} ordinal ${ordinal}: ${color}`,
      ).toBeLessThan(0.01);
    }
    const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
    const indexed = model.works.filter((work) => work.kind === 'drawIndexed');
    const main = indexed.filter((work) => (work.attachments?.colorViewHandleIds.length ?? 0) > 0);
    const shadow = indexed.filter((work) => work.attachments?.colorViewHandleIds.length === 0);
    const calls = (works: typeof indexed) =>
      works.map(
        (work) =>
          work.drawCall as { instanceCount: number; indexCount: number; firstIndex: number },
      );
    expect(calls(main).reduce((sum, call) => sum + call.instanceCount, 0)).toBe(count);
    expect(main.length).toBeLessThanOrEqual(Math.ceil(count / 128) * 2);
    expect(shadow.length).toBeGreaterThan(0);
    expect(shadow.length).toBeLessThanOrEqual(Math.ceil(count / 128) * 2);
    expect(calls(shadow).reduce((sum, call) => sum + call.instanceCount, 0)).toBe(count);
    const shot = await page.elementLocator(canvas).screenshot({ base64: true });
    await commands.writeFile(
      `${DIRECTORY}/${name}.png`,
      typeof shot === 'string' ? shot : shot.base64,
      'base64',
    );
    await commands.writeFile(
      `${DIRECTORY}/${name}.json`,
      JSON.stringify({
        main: calls(main),
        shadow: calls(shadow),
        completedFrames: 60,
        inspectedInstances: count,
        errors,
      }),
    );
    return calls(main);
  };
  try {
    expect(renderer.inspect().capabilities.backendKind).toBe('wgpu-webgl2');
    expect(await sample('alternating', (ordinal) => ordinal % 2 !== 0)).toHaveLength(6);
    const changed = transforms.slice();
    for (let ordinal = 0; ordinal < COUNT; ordinal++)
      changed[ordinal * 16] =
        changed[ordinal * 16 + 5] =
        changed[ordinal * 16 + 10] =
          ordinal % 2 !== 0 ? 1 : 0.3;
    world.set(object, Instances, { transforms: changed }).unwrap();
    expect(await sample('changed', (ordinal) => ordinal % 2 === 0)).toHaveLength(6);
    world.set(object, Instances, { transforms: changed.slice(0, 129 * 16) }).unwrap();
    expect(await sample('shrink', (ordinal) => ordinal % 2 === 0, 129)).toHaveLength(3);
    expect(transforms[0]).toBe(1);
    expect(transforms[16]).toBeCloseTo(0.3);
    expect(errors, JSON.stringify(errors)).toEqual([]);
  } finally {
    unsubscribe();
    renderer.dispose();
    (await recorder.dispose()).unwrap();
    canvas.remove();
  }
});
