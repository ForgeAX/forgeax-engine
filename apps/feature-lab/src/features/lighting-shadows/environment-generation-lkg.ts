import {
  Atmosphere,
  DirectionalLight,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine/render';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { MESH, spawnCamera, spawnMesh, standard } from '../../lab/stage';
import { proceduralEquirect } from './support/scene';

interface Snapshot {
  readonly source: string | undefined;
  readonly status: string;
  readonly generation: number | undefined;
  readonly signature: string | undefined;
  readonly lkg: string | undefined;
}

export default defineFeature({
  title: 'Environment generation/LKG',
  catalog: 'Environment generation/LKG',
  kind: 'probe',
  summary:
    'The renderer promotes each environment source (image Skylight, then analytic Atmosphere) as a new generation and keeps a last-known-good generation; inspect().environment exposes source, status, generation and signatures.',
  expect:
    'Checks: the image source becomes active, switching to Atmosphere produces a different signature and a newer generation, and an LKG signature is recorded.',
  async setup({ world, app, frames }) {
    spawnCamera(world, {
      eye: [0, 0.3, 4],
      target: [0, 0.5, 0],
      data: { tonemap: TONEMAP_ACES_FILMIC },
    });
    spawnMesh(world, MESH.sphere, standard(world, { baseColor: [0.9, 0.9, 0.9, 1] }), {
      pos: [0, 0.3, 0],
      scale: [0.5, 0.5, 0.5],
    });
    const equirect = world.allocSharedRef('EquirectAsset', proceduralEquirect());
    const snapshot = (): Snapshot => {
      const env = app.renderer.inspect().environment;
      return {
        source: env.source,
        status: env.status,
        generation: env.generation,
        signature: env.activeSignature,
        lkg: env.lkgSignature,
      };
    };
    const sky = world
      .spawn({ component: Skylight, data: { equirect, intensity: 1 } as never })
      .unwrap();
    await frames(20);
    const image = snapshot();
    world.despawn(sky).unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0.3, -0.4, 1], castShadow: false } as never,
      })
      .unwrap();
    world.spawn({ component: Skylight, data: { intensity: 1 } as never }).unwrap();
    world.spawn({ component: Atmosphere, data: {} as never }).unwrap();
    await frames(20);
    const atmosphere = snapshot();
    return {
      checks(): FeatureCheck[] {
        return [
          {
            name: 'image source active',
            ok: image.source === 'image' && image.status === 'active',
            detail: JSON.stringify(image),
          },
          {
            name: 'atmosphere source active',
            ok: atmosphere.source === 'atmosphere' && atmosphere.status === 'active',
            detail: JSON.stringify(atmosphere),
          },
          {
            name: 'new signature after source switch',
            ok: atmosphere.signature !== undefined && atmosphere.signature !== image.signature,
          },
          {
            name: 'generation advances',
            ok: (atmosphere.generation ?? -1) > (image.generation ?? Number.POSITIVE_INFINITY),
            detail: `${image.generation} -> ${atmosphere.generation}`,
          },
          {
            name: 'LKG signature recorded',
            ok: atmosphere.lkg !== undefined,
            detail: `lkg=${atmosphere.lkg}`,
          },
        ];
      },
    };
  },
});
