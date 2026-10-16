import { AssetGuid } from '@forgeax/engine-pack/source';
import { terrainBootstrapData } from './identity.ts';
import { runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createCatalogSource } from '@forgeax/engine-assets-runtime';
import { validateCatalogDelta, type TerrainAsset } from '@forgeax/engine-types';
import { Transform } from '@forgeax/engine-scene';
import type { ExecutionBootstrapEntry } from '@forgeax/engine-app';
import { physicsPlugin } from '@forgeax/engine-physics';
import { Terrain } from '@forgeax/engine-terrain';
import { installTerrainWalker } from './walker.ts';
import { terrainReloadPolicy } from './reload-policy.ts';
import { buildTerrainWorld } from './scene.ts';

const entry: ExecutionBootstrapEntry = (data) => {
  const input = terrainBootstrapData(data);
  const rootGuid = input.rootGuid;
  return {
    configureRenderer(renderer) {
      const channel = new BroadcastChannel(input.channel);
      let pending: number | undefined;
      let rejectNext = false;
      const nativeSubmit = GPUQueue.prototype.submit;
      const instrumentedSubmit: GPUQueue['submit'] = function (this: GPUQueue, commands) {
        if (rejectNext) {
          rejectNext = false;
          channel.postMessage({ kind: 'queue-rejected' });
          throw new Error('terrain Worker fixture rejects before native queue acceptance');
        }
        return nativeSubmit.call(this, commands);
      };
      GPUQueue.prototype.submit = instrumentedSubmit;
      channel.onmessage = (event) => {
        if (event.data?.kind === 'reject-next-submit') {
          rejectNext = true;
          channel.postMessage({ kind: 'reject-armed' });
          return;
        }
        if (typeof event.data?.id === 'number') pending = event.data.id;
      };
      const draw = renderer.draw.bind(renderer);
      renderer.draw = (request) => {
        const result = draw(request);
        if (pending !== undefined && result.ok && result.value.presentation === 'ready') {
          const id = pending;
          pending = undefined;
          void result.value.completed.then((completed) =>
            channel.postMessage({ id, frameId: result.value.frameId, completed }),
          );
        }
        return result;
      };
      const dispose = renderer.dispose.bind(renderer);
      renderer.dispose = () => {
        channel.close();
        if (GPUQueue.prototype.submit === instrumentedSubmit)
          GPUQueue.prototype.submit = nativeSubmit;
        return dispose();
      };
    },
    plugins: [
      physicsPlugin('rapier-3d'),
      {
        name: 'terrain-worker-proof',
        inject: ['world', 'assets', 'executionBootstrapHost'],
        async apply(ctx) {
          if (ctx.assets === undefined) throw new Error('terrain Worker requires assets');
          const port = ctx.executionBootstrapHost.port;
          if (runtimeBinding !== undefined && port !== undefined)
            ctx.assets.setCatalogSource(
              createCatalogSource({
                url: runtimeBinding.catalogUrl,
                expectedScope: runtimeBinding,
                subscribe(listener) {
                  const receive = (event: MessageEvent) => {
                    if (event.data?.kind !== 'terrain-catalog-delta') return;
                    const delta = validateCatalogDelta(event.data.delta);
                    if (delta.ok) listener(delta.value);
                  };
                  port.addEventListener('message', receive);
                  port.start();
                  return () => port.removeEventListener('message', receive);
                },
              }),
            );
          const subjects = await buildTerrainWorld(
            { world: ctx.world, assets: ctx.assets },
            rootGuid,
          );
          const query = ctx.executionBootstrapHost.querySubmittedTerrainHeight;
          if (query === undefined)
            throw new Error('terrain Worker requires submitted query capability');
          const policy = terrainReloadPolicy(
            ctx.world,
            ctx.assets,
            subjects.terrain,
            query,
            rootGuid,
          );
          const disposeWalker = installTerrainWalker(ctx.world, subjects, policy.gate);
          ctx.effect(
            () => () => {
              disposeWalker();
              policy.dispose();
            },
            'terrain/reload-policy',
          );
          ctx.world.insertResource('TerrainReloadPolicy', policy);
          ctx.world.insertResource('TerrainSubjects', subjects);
          ctx.world.insertResource('TerrainQuery', query);
          const failures: unknown[] = [];
          ctx.world.insertResource('TerrainWriterFailures', failures);
          let prior: { position: number[]; updates: number } | undefined;
          const token = ctx.world.scheduleToken('Update'),
            audit = 'terrain-worker-writer-audit';
          ctx.world
            .addSystem(token, {
              name: audit,
              queries: [],
              fn() {
                const position = Array.from(ctx.world.get(subjects.walker, Transform).unwrap().pos),
                  updates = ctx.world.getResource<{ updates: number }>('TerrainWalker').updates;
                if (policy.gate.blocked) {
                  if (
                    prior !== undefined &&
                    (updates !== prior.updates || position.some((v, i) => v !== prior?.position[i]))
                  )
                    failures.push({ before: prior, after: { position, updates } });
                  prior = { position, updates };
                } else prior = undefined;
              },
            })
            .unwrap();
          ctx.effect(
            () => () => ctx.world.removeSystem(token, audit).unwrap(),
            'terrain/writer-audit',
          );
          const root = ctx.world.get(subjects.terrain, Terrain).unwrap().asset;
          const source = ctx.world.sharedRefs.resolve<'TerrainAsset', TerrainAsset>(root).unwrap();
          if (
            source.kind !== 'terrain' ||
            ctx.assets.lookup(AssetGuid.format(input.rootGuid)) !== source
          )
            throw new Error('Worker terrain must have the selected Catalog identity');
          ctx.executionBootstrapHost.port?.postMessage({
            subjects,
            asset: Number(root),
            rootGuid: AssetGuid.format(input.rootGuid),
            materialEncoding: source.materialEncoding,
          });
        },
      },
    ],
  };
};
export default entry;
