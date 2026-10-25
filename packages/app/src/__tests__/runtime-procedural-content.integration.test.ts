import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createWorldContext, type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createSphereGeometry } from '@forgeax/engine-geometry';
import type { Plugin } from '@forgeax/engine-plugin';
import {
  Camera,
  createRenderPublisher,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  type RenderPublication,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-null';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { AssetHandle } from '@forgeax/engine-types';
import { expect, it } from 'vitest';

interface Spawned {
  readonly mesh: AssetHandle<'mesh'>;
  readonly material: AssetHandle<'material'>;
  readonly entity: EntityHandle;
}

// Game code: content created during play, without a Pack declaration or GUID.
// Each generator step registers its inverse, so Fiber disposal (plugin removal,
// hot replacement or failure) despawns first and then releases the creator's references.
function debrisPlugin(spawned: (value: Spawned) => void): Plugin.Object {
  return {
    name: 'test/runtime-debris',
    inject: ['world', 'assets'],
    apply(ctx) {
      const assets = ctx.assets;
      if (assets === undefined) throw new Error('runtime debris requires the asset service');
      ctx.effect(function* () {
        const mesh = assets.create(createBoxGeometry(0.5, 0.5, 0.5).unwrap()).unwrap();
        yield () => assets.release(mesh).unwrap();
        const material = assets
          .create(Materials.standard({ baseColor: [1, 0.4, 0.1, 1], roughness: 0.6 }))
          .unwrap();
        yield () => assets.release(material).unwrap();
        const entity = ctx.world
          .spawn(
            { component: Transform, data: { pos: [0, 0, 0] } },
            { component: MeshFilter, data: { assetHandle: mesh } },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap();
        yield () => ctx.world.despawn(entity).unwrap();
        spawned({ mesh, material, entity });
      });
    },
  };
}

it('creates, binds, edits and retires code-created assets across the Worker publication boundary', async () => {
  const { renderLifecycleManifestUrl } = await import(
    new URL('../../../render/src/__tests__/shader-manifest-fixture.ts', import.meta.url).href
  );
  const identity = { source: 'runtime-procedural-content', epoch: 1 };
  const constructed = await constructRuntimeRendererHost(
    { width: 64, height: 64, getContext: () => null },
    { rhi, publicationSource: identity },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  if (!constructed.ok) throw constructed.error;
  const { renderer } = constructed.value;
  // The Engine Worker owns its own registry; the Renderer receives only publications.
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const ctx = await createWorldContext(world);
  ctx.provide('assets', assets);
  const publisher = createRenderPublisher(world, assets, identity, renderer.inspect().capabilities);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      {
        component: Camera,
        data: perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 }),
      },
    )
    .unwrap();
  let time = 0;
  const frame = async (): Promise<RenderPublication> => {
    world.update(1 / 60).unwrap();
    time += 1 / 60;
    const prepared = publisher.prepare(time).unwrap();
    // Structured clone is the Worker transport; no source object reaches the Renderer.
    const packet = structuredClone(prepared.packet, {
      transfer: renderPublicationTransfers(prepared.packet),
    });
    const sent = structuredClone(packet);
    prepared.accept();
    const draw = renderer.draw({ publication: packet });
    if (!draw.ok) throw draw.error;
    const completed = await draw.value.completed;
    if (!completed.ok) throw completed.error;
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    return sent;
  };
  const rows = (packet: RenderPublication, handle: number) =>
    packet.assets.filter((row) => row.handle === handle);
  const bound = () =>
    renderer
      .inspect()
      .meshMaterialBindings.filter(
        (binding) => binding.worldIdentity === 'runtime-procedural-content:1',
      );
  try {
    let spawned: Spawned | undefined;
    const fiber = await ctx.plugin(
      debrisPlugin((value) => {
        spawned = value;
      }),
    );
    if (spawned === undefined) throw new Error('plugin did not spawn its content');
    const { mesh, material, entity } = spawned;
    expect(assets.guidOf(mesh)).toBeUndefined();
    expect(assets.sourceOf(material)).toBeUndefined();

    const first = await frame();
    expect(rows(first, mesh)).toEqual([
      expect.objectContaining({ revision: 1, value: expect.objectContaining({ kind: 'mesh' }) }),
    ]);
    expect(rows(first, mesh)[0]).not.toHaveProperty('guid');
    expect(rows(first, material)[0]?.value.kind).toBe('material');
    expect(bound()).toEqual([
      expect.objectContaining({
        bindings: [expect.objectContaining({ handle: material })],
        residency: [expect.objectContaining({ readiness: 'ready' })],
      }),
    ]);

    // Edits keep the handle; only changed content crosses the boundary again.
    assets.update(material, { values: { baseColor: [0.2, 0.8, 1, 1] } }).unwrap();
    assets.replace(mesh, createSphereGeometry(0.4, 16, 12).unwrap()).unwrap();
    const edited = await frame();
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(mesh);
    expect(rows(edited, mesh)[0]?.revision).toBeGreaterThan(1);
    // A value edit crosses as a field patch, not a second material payload.
    expect(rows(edited, material)).toEqual([]);
    expect(edited.assetPatches).toEqual([
      expect.objectContaining({
        handle: material,
        fields: { values: expect.objectContaining({ baseColor: [0.2, 0.8, 1, 1] }) },
      }),
    ]);
    expect(bound()).toHaveLength(1);
    const unchanged = await frame();
    expect(rows(unchanged, mesh)).toEqual([]);

    // Fiber disposal is the deterministic owner of the runtime content.
    await fiber.dispose();
    expect(world.get(entity, MeshFilter).ok).toBe(false);
    for (const handle of [mesh, material])
      expect(assets.validate(handle)).toMatchObject({
        ok: false,
        error: { code: 'asset-reference-invalid' },
      });
    const retired = await frame();
    expect(retired.retiredAssets).toEqual(expect.arrayContaining([mesh, material]));
    expect(bound()).toEqual([]);
  } finally {
    await ctx.fiber.dispose();
    publisher.dispose();
    await renderer.dispose();
    assets.dispose();
  }
});

it('rejects a runtime material whose static selection no publication has cooked', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  try {
    const created = assets.create(
      Materials.standard({
        staticSwitches: { clearcoat: true },
        baseColor: [1, 1, 1, 1],
        clearcoat: 0.8,
      }),
    );
    expect(created).toMatchObject({
      ok: false,
      error: { code: 'material-specialization-not-cooked' },
    });
  } finally {
    assets.dispose();
  }
});
