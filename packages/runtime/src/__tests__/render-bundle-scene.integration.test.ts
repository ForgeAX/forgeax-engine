import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { RhiNullAdapter, RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { standardPbrManifestRow } from '../../../render/src/__tests__/shader-manifest-fixture';
import { constructRendererHost } from '../../../render/src/construct-renderer';
import { RenderBundleCache } from '../../../render/src/record/render-bundle-cache';

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
      { hash: 'pbr00000', wgsl: 'f_schlick(', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: 'unlit', glsl: '', bindings: '' },
      { hash: 'tonemap0', wgsl: 'struct TonemapParams {}', glsl: '', bindings: '' },
    ],
    materialShaders: [
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

it('retains bundles through resize and follows real scene membership and culling changes', async () => {
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
  const material = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [1, 0, 0] },
  });
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
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
      const receipt = value(
        renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
      );
      value(await receipt.completed);
      return device.totalDrawCount - draws;
    };
    for (let i = 0; i < 60; i++) await frame();
    expect(create.mock.calls.length).toBeGreaterThan(0);
    expect(create.mock.calls.length).toBeLessThan(10);
    const warmed = create.mock.calls.length;
    const drawsBeforeResize = await frame();
    expect(drawsBeforeResize).toBeGreaterThan(0);
    world.set(entity, Transform, { pos: [0.1, 0, 0] }).unwrap();
    await frame();
    await frame();
    expect(create).toHaveBeenCalledTimes(warmed);
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
    // Resized attachments do not change the scene's bound resources or bundle formats.
    expect(create).toHaveBeenCalledTimes(warmed);
    // Exercise actual World membership and culling inputs, with the uncached
    // compiled renderer as a structural oracle at each transition.
    const compare = async () => {
      const cached = await frame();
      expect(cached).toBeGreaterThan(0);
      const direct = vi
        .spyOn(RenderBundleCache.prototype, 'encode')
        .mockImplementation((_device, pass, record) => record(pass));
      try {
        expect(await frame()).toBe(cached);
      } finally {
        direct.mockRestore();
      }
      expect(await frame()).toBe(cached);
    };
    await compare();
    for (let cycle = 0; cycle < 20; cycle++) {
      const added = Array.from({ length: 16 + (cycle % 4) }, () =>
        world
          .spawn(
            { component: Transform, data: {} },
            { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap(),
      );
      await compare();
      for (let index = 0; index < added.length; index++) {
        const target = added[index];
        if (target === undefined) throw new Error('Missing spawned entity');
        world.set(target, Transform, { pos: [index % 2 === 0 ? 1000 : 0.1, 0, 0] }).unwrap();
      }
      await compare();
      for (const target of added) world.despawn(target).unwrap();
      canvas.width = cycle % 2 === 0 ? 32 : 64;
      await compare();
    }
  } finally {
    renderer.dispose();
  }
}, 60_000);
