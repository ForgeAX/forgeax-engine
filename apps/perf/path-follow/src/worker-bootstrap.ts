import {
  configureRuntimeAssetCatalog,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import type { ExecutionBootstrapEntry } from '@forgeax/engine-app';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { FixedTime } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { DesiredPathPose, Path, PathFollower, pathPlugin } from '@forgeax/engine-path';
import { Camera, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { GlobalTransform, Name, Transform, worldInstantiateSceneFlat } from '@forgeax/engine-scene';
import type { SceneAsset } from '@forgeax/engine-types';
import { sceneGuid } from './scene-guid';

const entry: ExecutionBootstrapEntry = () => ({
  plugins: [
    pathPlugin(),
    {
      name: 'path-worker-scene',
      inject: ['world', 'assets'],
      async apply(ctx) {
        if (!ctx.assets) throw new Error('Worker asset service absent');
        configureRuntimeAssetCatalog(ctx.assets, runtimeBinding);
        const source = (await ctx.assets.loadByGuid<SceneAsset>(sceneGuid)).unwrap();
        const handle = ctx.world.allocSharedRef('SceneAsset', source);
        try {
          worldInstantiateSceneFlat(ctx.world, handle).unwrap();
        } finally {
          ctx.world.sharedRefs.release(handle).unwrap();
        }
        const material = ctx.world.allocSharedRef(
          'MaterialAsset',
          Materials.unlit([0.05, 0.85, 0.8, 1]),
        );
        const entities = Array.from(ctx.world.query({ read: [Name] }).unwrap(), (row) => ({
          name: row.get(Name).value,
          entity: row.entity,
        }));
        const platform = entities.find((row) => row.name === 'platform')?.entity;
        if (platform === undefined) throw new Error('Worker platform absent');
        ctx.world.addComponent(platform, { component: DesiredPathPose, data: {} }).unwrap();
        for (const row of entities)
          if (row.name.startsWith('patrol')) {
            ctx.world
              .addComponent(row.entity, {
                component: MeshFilter,
                data: { assetHandle: HANDLE_CUBE },
              })
              .unwrap();
            ctx.world
              .addComponent(row.entity, {
                component: MeshRenderer,
                data: { materials: [material] },
              })
              .unwrap();
          }
        const rotation = quat.create();
        quat.fromLookAt(rotation, [12, 12, 16], [0, 1, 0], [0, 1, 0]);
        const camera = ctx.world
          .spawn(
            { component: Transform, data: { pos: [12, 12, 16], quat: rotation } },
            {
              component: Camera,
              data: perspective({ fov: Math.PI / 3, aspect: 1.5, near: 0.1, far: 100 }),
            },
          )
          .unwrap();
        const rail = entities.find((row) => row.name === 'rail')?.entity;
        if (rail === undefined) throw new Error('Worker rail absent');
        // Inspector evaluates snapshots in this realm; no mirrored path clock.
        ctx.world.insertResource('PathSnapshot', () => ({
          tick: ctx.world.getResource(FixedTime).tick,
          worldIdentity: ctx.world.identity,
          cameraMatrix: Array.from(ctx.world.get(camera, GlobalTransform).unwrap().world),
          camera: (() => {
            const view = ctx.world.get(camera, Camera).unwrap();
            return { fov: view.fov, aspect: view.aspect, near: view.near, far: view.far };
          })(),
          sceneGuid: AssetGuid.format(sceneGuid),
          followers: Array.from(
            ctx.world.query({ read: [PathFollower, GlobalTransform, Name] }).unwrap(),
            (row) => ({
              entity: row.entity,
              name: row.get(Name).value,
              distance: row.get(PathFollower).distance,
              matrix: Array.from(row.get(GlobalTransform).world),
            }),
          ),
          path: Array.from(ctx.world.get(rail, Path).unwrap().points),
        }));
      },
    },
  ],
});
export default entry;
