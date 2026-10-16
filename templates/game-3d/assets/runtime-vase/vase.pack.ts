import type {} from '@forgeax/engine/app';
import type { EntityHandle } from '@forgeax/engine/ecs';
import { PackageId } from '@forgeax/engine/pack/guid';
import { definePack } from '@forgeax/engine/pack/source';
import type { Plugin } from '@forgeax/engine/plugin';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { ChildOf, Name, Transform } from '@forgeax/engine/scene';
import { ok, type MaterialAsset, type MeshAsset } from '@forgeax/engine/types';
import { assetGuid, guidText, PACKAGE_IDS } from '../shared/asset-refs.ts';
import type {} from '../shared/scene-refs.ts';
import {
  VASE_CHANNEL, VASE_DEFAULTS, VASE_GENERATOR, VASE_INSTANCE, VASE_PLUGIN,
  vaseContent, type VaseState, type VaseValues,
} from './vase-program.ts';

export const vase: Plugin.Object<{ readonly material: string }> = {
  name: 'game-3d/runtime-vase',
  inject: ['world', 'assets', 'runtimePacks', 'gameScene', 'gameHost'],
  async apply(ctx, config) {
    const assets = ctx.assets!;
    const { producer, catalog } = ctx.runtimePacks!;
    const port = ctx.gameHost!.port;
    const world = ctx.world;
    const guid = assetGuid(VASE_INSTANCE, 'vase');
    const lifetime = new AbortController();
    ctx.on('internal/plugin', (fiber) => {
      if (fiber === ctx.fiber && fiber.uid === null) lifetime.abort();
    });
    let entity: EntityHandle | undefined;
    let pending: Promise<void> | undefined;
    let state: VaseState = { busy: false, guid: guidText(guid), values: VASE_DEFAULTS };
    const publish = () => {
      if (!lifetime.signal.aborted) port?.postMessage({ channel: VASE_CHANNEL, kind: 'state', state });
    };
    const generate = async (requested: VaseValues) => {
      const values = { ...VASE_DEFAULTS, ...requested };
      state = { ...state, busy: true, error: undefined };
      publish();
      try {
        const generated = (await producer.generate({
          schemaVersion: '3.0.0', packageId: PackageId.format(VASE_INSTANCE), parent: PackageId.format(VASE_GENERATOR), values,
        }, lifetime.signal)).unwrap();
        if (lifetime.signal.aborted) return;
        const mesh = (await assets.loadByGuid<MeshAsset>(guid)).unwrap();
        if (lifetime.signal.aborted) return;
        const material = (await assets.loadByGuid<MaterialAsset>(assets.parseGuid(config.material))).unwrap();
        if (lifetime.signal.aborted) return;
        const meshHandle = world.allocSharedRef('MeshAsset', mesh);
        const materialHandle = world.allocSharedRef('MaterialAsset', material);
        try {
          if (entity === undefined) {
            entity = world.spawn(
              { component: Transform, data: { pos: [0, 0, 4] } },
              { component: Name, data: { value: 'Runtime Vase' } },
              { component: ChildOf, data: { parent: ctx.gameScene.root } },
              { component: MeshFilter, data: { assetHandle: meshHandle } },
              { component: MeshRenderer, data: { materials: [materialHandle] } },
            ).unwrap();
          } else {
            world.set(entity, MeshFilter, { assetHandle: meshHandle }).unwrap();
          }
        } finally {
          world.sharedRefs.release(meshHandle).unwrap();
          world.sharedRefs.release(materialHandle).unwrap();
        }
        state = {
          busy: true, guid: guidText(guid), values: { ...values }, entity,
          generation: generated.publication!.generation,
          vertexCount: mesh.submeshes[0]!.vertexCount,
          aabb: Array.from(mesh.aabb!),
        };
      } catch (cause) {
        state = { ...state, error: cause instanceof Error ? cause.message : JSON.stringify(cause) };
      } finally {
        state = { ...state, busy: false };
        publish();
      }
    };
    const receive = (event: MessageEvent) => {
      if (lifetime.signal.aborted || event.data?.channel !== VASE_CHANNEL) return;
      if (event.data.kind === 'inspect') publish();
      if (event.data.kind === 'generate' && !state.busy && !lifetime.signal.aborted) {
        pending = generate(event.data.values);
      }
    };
    await ctx.effect(async function* () {
      yield async () => {
        lifetime.abort();
        port?.removeEventListener('message', receive);
        await pending;
        if (entity !== undefined) world.despawn(entity).unwrap();
        producer.withdraw(PackageId.format(VASE_GENERATOR));
      };
      port?.addEventListener('message', receive);
      port?.start();
      const enumerated = await catalog.enumerate();
      if (lifetime.signal.aborted) return;
      const rows = enumerated.unwrap();
      const row = rows.find((row) => row.guid === config.material);
      const digest = row?.publication?.outputs.find((output) => output.guid === config.material)?.digest;
      if (!digest) throw new Error('Runtime vase requires a published material dependency');
      const admitted = await producer.admit(vaseContent(producer.inspect().imports, config.material, digest), lifetime.signal);
      if (lifetime.signal.aborted) return;
      admitted.unwrap();
      const unregister = ctx.gameHost!.gameProjection?.registerRead({
        id: 'game-3d.runtime-vase', title: 'Runtime vase',
        description: 'Current generated mesh identity, parameters, and bound geometry.',
        read: () => ({ ...state }),
      });
      if (unregister) yield unregister;
      pending = generate(VASE_DEFAULTS);
    });
  },
};

export default definePack({
  schemaVersion: '2.0.0', packageId: VASE_PLUGIN,
  build: () => ok({
    'plugin/vase': {
      kind: 'plugin', module: { specifier: './vase.pack.ts', export: 'vase' },
      config: { material: { $asset: guidText(assetGuid(PACKAGE_IDS.materials, 'material/painted')) } },
    },
  }),
});
