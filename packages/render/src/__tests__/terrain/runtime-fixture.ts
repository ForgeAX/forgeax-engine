import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { Terrain } from '@forgeax/engine-terrain';
import { standardSurfaceParameters, type TerrainSource } from '@forgeax/engine-types';
import { samplerContribution } from '../../assets/asset-decoders';
import { MaterialResource } from '../../material-resource';
import type { RenderResourceScope } from '../../publication/resource-scope';
import {
  type DispatchEntry,
  type RenderableSnapshot,
  resolveMaterialSnapshot,
} from '../../render-system-extract';
import { extractTerrainSources, TerrainSourceCache } from '../../terrain/source';

export function runtimeTerrainFixture(input: Omit<TerrainSource, 'layers' | 'weights'>) {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const layer = assets
    .create({
      kind: 'material',
      parameters: standardSurfaceParameters([]),
      values: { baseColor: [1, 1, 1, 1] },
      passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
    })
    .unwrap();
  const handle = assets
    .create({
      kind: 'terrain',
      ...input,
      weights: new Float32Array(input.columns * input.rows).fill(1),
      layers: [{ material: layer, blend: 'weight' }],
    })
    .unwrap();
  const world = new World({ assets });
  for (const component of [Terrain, Transform, GlobalTransform])
    world.components.register(component).unwrap();
  const entity = world
    .spawn(
      { component: Terrain, data: { asset: handle } },
      { component: Transform, data: {} },
      {
        component: GlobalTransform,
        data: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
      },
    )
    .unwrap();
  const rows: RenderableSnapshot[] = [],
    dispatch: DispatchEntry[] = [];
  extractTerrainSources(world, assets, undefined, 0, rows, dispatch);
  const source = rows[0];
  if (source === undefined) throw new Error('Expected admitted Terrain source');
  return { assets, world, handle, source, entity };
}

/** Standalone view tests supply the same material owner seam as PersistentRenderScene. */
export function terrainViewPreparation(assets: AssetRegistry) {
  return [
    new TerrainSourceCache(),
    (world: RenderResourceScope, handle: number) =>
      MaterialResource.from(resolveMaterialSnapshot(handle, world, assets)),
  ] as const;
}
