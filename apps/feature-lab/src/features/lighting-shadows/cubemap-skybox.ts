import { SkyboxBackground, Skylight, TONEMAP_ACES_FILMIC } from '@forgeax/engine/render';
import type { EquirectAsset } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnMesh, standard } from '../../lab/stage';
import { proceduralEquirect } from './support/scene';

// An 8-bit equirect is outside the linear-HDR projection contract.
function ldrEquirect(): EquirectAsset {
  return {
    kind: 'equirect',
    width: 8,
    height: 4,
    format: 'rgba8unorm',
    data: new Uint8Array(8 * 4 * 4).fill(200),
    colorSpace: 'linear',
  };
}

export default defineFeature({
  title: 'Cubemap Skybox',
  catalog: 'Cubemap Skybox',
  kind: 'visual',
  expectsAppError: true,
  summary:
    'SkyboxBackground shares the Skylight equirect handle and draws it as a full-screen cubemap background before scene geometry.',
  expect:
    'ON: the background is the procedural sky: blue above, a white horizon band, orange below. OFF: the SkyboxBackground entity is despawned; the sphere keeps its IBL lighting but the background falls back to the camera clear color. Check: an 8-bit equirect source reports invalid-source-format.',
  async setup({ app, world, frames }) {
    spawnCamera(world, {
      eye: [0, 0, 4],
      target: [0, 0, 0],
      data: { tonemap: TONEMAP_ACES_FILMIC },
    });
    const equirect = world.allocSharedRef('EquirectAsset', proceduralEquirect());
    const skylight = world
      .spawn({ component: Skylight, data: { equirect, intensity: 1 } as never })
      .unwrap();
    spawnMesh(
      world,
      MESH.sphere,
      standard(world, { baseColor: [1, 1, 1, 1], metallic: 1, roughness: 0.1 }),
      { pos: [0, 0, 0], scale: [0.6, 0.6, 0.6] },
    );
    let skybox = world.spawn({ component: SkyboxBackground, data: { equirect } as never }).unwrap();
    // The equirect projection compiles its IBL pipelines asynchronously; until they
    // are ready the renderer binds a neutral cube, so let a software adapter finish.
    await frames(240);
    return {
      toggle(on) {
        if (on)
          skybox = world
            .spawn({ component: SkyboxBackground, data: { equirect } as never })
            .unwrap();
        else world.despawn(skybox).unwrap();
      },
      async checks() {
        const checks = new CheckList();
        const errors: string[] = [];
        const stop = app.onError((error) => {
          const cause = (error as { detail?: { cause?: { code?: string } } }).detail?.cause;
          errors.push(`${error.code}:${cause?.code ?? ''}`);
        });
        world.despawn(skybox).unwrap();
        world.despawn(skylight).unwrap();
        const invalid = world.allocSharedRef('EquirectAsset', ldrEquirect());
        world.spawn({ component: SkyboxBackground, data: { equirect: invalid } as never }).unwrap();
        await frames(6);
        stop();
        checks.equal(
          'invalid equirect format reported once with its cause',
          errors.join(','),
          'equirect-projection-failed:invalid-source-format',
        );
        return checks.items;
      },
    };
  },
});
