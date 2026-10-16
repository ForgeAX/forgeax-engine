import { MessageChannel } from 'node:worker_threads';
import { resolveAssetHandle } from '@forgeax/engine/assets-runtime';
import { loadPackProgram } from '@forgeax/engine/pack/runtime';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { err, ok, type AssetPublicationEnvelope, type MeshAsset } from '@forgeax/engine/types';
import { describe, expect, it, vi } from 'vitest';
import { assetGuid, guidText, PACKAGE_IDS } from '../../shared/asset-refs.ts';
import { pluginFixture } from '../../shared/__tests__/plugin-fixture.ts';
import { vase } from '../vase.pack.ts';
import { vaseContent, VASE_CHANNEL, VASE_DEFAULTS, VASE_PARAMETERS, type VaseValues, type VaseState } from '../vase-program.ts';

const material = guidText(assetGuid(PACKAGE_IDS.materials, 'material/painted'));
const imports = Object.fromEntries(['@forgeax/engine/geometry', '@forgeax/engine/pack/source']
  .map((name) => [name, { identity: 'template-test', url: import.meta.resolve(name) }]));
async function program() {
  const content = vaseContent(Object.fromEntries(Object.keys(imports).map((name) => [name, 'template-test'])), material, 'material-version');
  const build = (await loadPackProgram(content.programs['game-3d/vase'].artifact, imports)).unwrap() as
    (input: { values: VaseValues & { material: string } }) => { ok: true; value: { vase: MeshAsset } };
  return (input: { values: VaseValues }) => build({ values: { ...input.values, material } });
}

describe('runtime vase', () => {
  it('executes native JS at the parameter bounds with real typed geometry and material identity', async () => {
    const build = await program();
    const meshes = [VASE_DEFAULTS, Object.fromEntries(VASE_PARAMETERS.map(p => [p.name, p.minimum])),
      Object.fromEntries(VASE_PARAMETERS.map(p => [p.name, p.maximum]))].map(values =>
      build({ values: values as VaseValues }).value.vase);
    for (const mesh of meshes) {
      expect(mesh.vertices).toBeInstanceOf(Float32Array);
      expect(ArrayBuffer.isView(mesh.indices)).toBe(true);
      expect(Array.from(mesh.vertices).every(Number.isFinite)).toBe(true);
      expect(mesh.materialSlots?.[0]?.defaultMaterial).toEqual(assetGuid(PACKAGE_IDS.materials, 'material/painted'));
    }
    expect(meshes.map(mesh => mesh.aabb![4])).toEqual([expect.closeTo(2.4), 1, 4]);
    expect(meshes[2]!.submeshes[0]!.vertexCount).toBeGreaterThan(meshes[1]!.submeshes[0]!.vertexCount!);
  });

  it('keeps the entity and GUID on replacement, preserves the bound mesh after failure, and joins pending work on disposal', async () => {
    const fixture = await pluginFixture();
    const { ctx, world, registerRead } = fixture;
    world.components.register(MeshFilter).unwrap();
    world.components.register(MeshRenderer).unwrap();
    const build = await program();
    let current = build({ values: VASE_DEFAULTS }).value.vase;
    let generation = 0;
    let finishPending: (() => void) | undefined;
    const producer = {
      inspect: () => ({ imports: Object.fromEntries(Object.keys(imports).map(name => [name, 'template-test'])) }),
      admit: vi.fn(async () => ok({})),
      withdraw: vi.fn(),
      generate: vi.fn(async ({ values }: { values: VaseValues }, signal: AbortSignal) => {
        if (values.height < 1) return err(new Error('height is below minimum'));
        if (values.height === 4) await new Promise<void>(resolve => { finishPending = resolve; });
        if (signal.aborted) return err(new Error('cancelled'));
        current = build({ values }).value.vase;
        const publication = { generation: ++generation } satisfies Pick<AssetPublicationEnvelope, 'generation'>;
        return ok({ publication });
      }),
    };
    const channel = new MessageChannel();
    ctx.set('gameHost', { ...ctx.gameHost!, port: channel.port1 as unknown as MessagePort });
    const post = (values: VaseValues) => channel.port2.postMessage({ channel: VASE_CHANNEL, kind: 'generate', values });
    ctx.provide('assets', {
      parseGuid: (value: string) => value,
      loadByGuid: async (guid: unknown) => ok(guid === material ? { kind: 'material' } : current),
    } as never);
    ctx.provide('runtimePacks', { producer, catalog: { enumerate: async () => ok([
      { guid: material, publication: { outputs: [{ guid: material, digest: 'material-version' }] } },
    ]) } } as never);
    let read: () => VaseState = () => { throw new Error('projection unavailable'); };
    registerRead.mockImplementationOnce((...args: unknown[]) => { read = (args[0] as { read: () => VaseState }).read; return vi.fn(); });
    try {
      const fiber = await ctx.plugin(vase, { material });
      const initial = read();
      const mesh = () => resolveAssetHandle<MeshAsset>(world,
        world.get(initial.entity!, MeshFilter).unwrap().assetHandle).unwrap();
      const original = mesh();
      post({ height: 3.5, radius: 1.1, sides: 16 });
      await vi.waitFor(() => expect(read().generation).toBe(2));
      expect(read()).toMatchObject({ entity: initial.entity, guid: initial.guid, values: { height: 3.5 } });
      expect(mesh()).not.toBe(original);
      expect(mesh().aabb![4]).toBeCloseTo(3.5);
      const replacement = mesh();
      post({ ...VASE_DEFAULTS, height: 0 });
      await vi.waitFor(() => expect(read().error).toContain('minimum'));
      expect(mesh()).toBe(replacement);
      expect(read().generation).toBe(2);
      post({ ...VASE_DEFAULTS, height: 4 });
      await vi.waitFor(() => expect(finishPending).toBeTypeOf('function'));
      const disposed = fiber.dispose();
      finishPending!();
      await disposed;
      expect(world.get(initial.entity!, MeshFilter).ok).toBe(false);
      expect(producer.withdraw).toHaveBeenCalledTimes(1);
      const count = producer.generate.mock.calls.length;
      post(VASE_DEFAULTS);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(producer.generate).toHaveBeenCalledTimes(count);
      const received = new Promise(resolve => channel.port2.once('message', resolve));
      channel.port1.postMessage('borrowed port remains open');
      // Drain queued state notifications until our marker arrives.
      const marker = new Promise(resolve => channel.port2.on('message', value => {
        if (value === 'borrowed port remains open') resolve(value);
      }));
      await received;
      await marker;
    } finally {
      finishPending?.();
      await ctx.fiber.dispose();
      channel.port1.close(); channel.port2.close();
    }
  });
  it('cancels a pending admission immediately when its native Fiber is removed', async () => {
    const { ctx, world, registerRead } = await pluginFixture();
    let finish: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const generate = vi.fn();
    const withdraw = vi.fn();
    const spawn = vi.spyOn(world, 'spawn');
    ctx.provide('assets', {} as never);
    ctx.provide('runtimePacks', {
      catalog: { enumerate: async () => ok([{ guid: material,
        publication: { outputs: [{ guid: material, digest: 'material-version' }] },
      }]) },
      producer: {
        inspect: () => ({ imports: Object.fromEntries(Object.keys(imports).map(name => [name, 'template-test'])) }),
        admit: async (_content: unknown, requested: AbortSignal) => {
          signal = requested;
          await new Promise<void>(resolve => { finish = resolve; });
          return requested.aborted ? err(new Error('runtime-pack-cancelled')) : ok({});
        },
        generate, withdraw,
      },
    } as never);
    try {
      const fiber = ctx.plugin(vase, { material });
      await vi.waitFor(() => expect(signal).toBeDefined());
      const disposing = fiber.dispose();
      expect(signal!.aborted).toBe(true);
      finish!();
      await disposing;
      await fiber.await();
      expect(generate).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(registerRead).not.toHaveBeenCalled();
      expect(withdraw).toHaveBeenCalledTimes(1);
    } finally {
      finish?.();
      await ctx.fiber.dispose();
    }
  });

});
