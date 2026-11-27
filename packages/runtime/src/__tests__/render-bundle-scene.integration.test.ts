import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { RhiNullAdapter, RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  nativeOutputShaderFixture,
  standardPbrManifestRow,
  waterInfoShaderFixture,
} from '../../../render/src/__tests__/shader-manifest-fixture';
import { constructRendererHost } from '../../../render/src/construct-renderer';
import { testAssets } from './helpers/runtime-assets';

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}
const manifest = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    entries: [
      ...waterInfoShaderFixture.entries,
      ...nativeOutputShaderFixture.entries,
      { hash: 'pbr00000', wgsl: 'f_schlick(', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: 'unlit', glsl: '', bindings: '' },
      { hash: 'tonemap0', wgsl: 'struct TonemapParams {}', glsl: '', bindings: '' },
    ],
    materialShaders: [
      ...waterInfoShaderFixture.materialShaders,
      ...nativeOutputShaderFixture.materialShaders,
      {
        identifier: 'forgeax::default-unlit',
        sourcePath: 'unlit.wgsl',
        composedWgsl: '/* null backend shader */',
        paramSchema: '[]',
        variants: [],
      },
      standardPbrManifestRow('f_schlick('),
    ],
  }),
)}`;

it('records direct draws through resize and follows real scene membership and culling changes', async () => {
  const adapter = new RhiNullAdapter();
  const device = (await adapter.requestDevice()).unwrap();
  if (!(device instanceof RhiNullDevice)) throw new Error('Expected the structural Null backend');
  const create = vi.spyOn(device, 'createRenderBundleEncoder');
  const textures = vi.spyOn(device, 'createTexture');
  const backend = {
    ...rhi,
    requestAdapter: async () =>
      ok({
        features: adapter.features,
        limits: adapter.limits,
        requestDevice: async () => ok(device),
      }),
  };
  const canvas = { width: 32, height: 32, getContext: () => null } as unknown as HTMLCanvasElement;
  const world = new World();
  const material = testAssets(world)
    .create({
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColor: [1, 0, 0] },
    })
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: MeshFilter,
        data: {
          assetHandle: testAssets(world)
            .create(createBoxGeometry(1, 1, 1).unwrap())
            .unwrap(),
        },
      },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
    )
    .unwrap();
  const { renderer } = value(
    await constructRendererHost(canvas, { rhi: backend }, { shaderManifestUrl: manifest }),
  );
  try {
    const lease = value(renderer.attach(world));
    const frame = async () => {
      const draws = device.totalDrawCount;
      world.update(0).unwrap();
      const receipt = value(renderer.draw({ source: lease }));
      value(await receipt.completed);
      return device.totalDrawCount - draws;
    };
    for (let i = 0; i < 60; i++) await frame();
    expect(create).not.toHaveBeenCalled();
    const drawsBeforeResize = await frame();
    expect(drawsBeforeResize).toBeGreaterThan(0);
    world.set(entity, Transform, { pos: [0.1, 0, 0] }).unwrap();
    await frame();
    await frame();
    expect(create).not.toHaveBeenCalled();
    textures.mockClear();
    canvas.width = 64;
    expect(await frame()).toBe(drawsBeforeResize);
    expect(await frame()).toBe(drawsBeforeResize);
    expect(await frame()).toBe(drawsBeforeResize);
    expect(textures).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'scene-depth',
        size: expect.objectContaining({ width: 64, height: 32 }),
      }),
    );
    // Direct draws use the current scene rows and the resized attachments.
    expect(create).not.toHaveBeenCalled();
    const stableFrame = async () => {
      const draws = await frame();
      expect(draws).toBeGreaterThan(0);
      expect(await frame()).toBe(draws);
      expect(await frame()).toBe(draws);
      return draws;
    };
    const baseline = await stableFrame();
    for (let cycle = 0; cycle < 20; cycle++) {
      const added = Array.from({ length: 16 + (cycle % 4) }, () =>
        world
          .spawn(
            { component: Transform, data: {} },
            {
              component: MeshFilter,
              data: {
                assetHandle: testAssets(world)
                  .create(createBoxGeometry(1, 1, 1).unwrap())
                  .unwrap(),
              },
            },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap(),
      );
      const spawned = await stableFrame();
      expect(spawned).toBeGreaterThan(baseline);
      for (let index = 0; index < added.length; index++) {
        const target = added[index];
        if (target === undefined) throw new Error('Missing spawned entity');
        world.set(target, Transform, { pos: [index % 2 === 0 ? 1000 : 0.1, 0, 0] }).unwrap();
      }
      const culled = await stableFrame();
      expect(culled).toBeGreaterThan(baseline);
      expect(culled).toBeLessThan(spawned);
      for (const target of added) world.despawn(target).unwrap();
      canvas.width = cycle % 2 === 0 ? 32 : 64;
      expect(await stableFrame()).toBe(baseline);
    }
    expect(create).not.toHaveBeenCalled();
  } finally {
    renderer.dispose();
  }
}, 60_000);
