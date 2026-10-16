import type { CreateAppOptions } from '@forgeax/engine/app';
import {
  DEFAULT_STANDARD_PROFILE,
  Skylight,
  TONEMAP_ACES_FILMIC,
  VolumetricFog,
} from '@forgeax/engine/render';
import type { TextureAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnGround, spawnMesh, standard, unlit } from '../../lab/stage';
import { spawnPointLight } from './support/scene';

const SIZE = 8;

const APP_OPTIONS: CreateAppOptions = {
  standardProfile: {
    ...DEFAULT_STANDARD_PROFILE,
    volumetricFog: { quality: 'low', depth: 48, tileSize: 16 },
  },
};

export default defineFeature({
  title: 'Volumetric Fog',
  catalog: 'Volumetric Fog',
  kind: 'visual',
  appOptions: APP_OPTIONS,
  summary:
    'VolumetricFog samples an inline 8x8x8 r8unorm 3D density texture inside a box and scatters a selected orange PointLight through it. Standard Forward/Deferred also support TONEMAP_NONE; low froxel quality keeps software adapters interactive.',
  expect:
    'ON: a glowing orange haze fills the box around the light, visible against the dark background. OFF: the VolumetricFog entity is despawned; only the light pool on the floor remains.',
  setup({ world, app }) {
    spawnGround(world, [0.3, 0.3, 0.32, 1]);
    spawnCamera(world, {
      eye: [0, 1.5, 5],
      target: [0, 1, 0],
      data: { tonemap: TONEMAP_ACES_FILMIC },
    });
    world
      .spawn({ component: Skylight, data: { color: [0.4, 0.4, 0.5], intensity: 0.03 } as never })
      .unwrap();
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.2, 0.5, 1, 1] }), {
      pos: [0.9, 0.5, 0],
      scale: [0.5, 1, 0.5],
    });
    spawnMesh(world, MESH.sphere, unlit(world, [1, 0.7, 0.3, 1]), {
      pos: [0, 1.2, 0],
      scale: [0.08, 0.08, 0.08],
    });
    const light = spawnPointLight(world, [0, 1.2, 0], [1, 0.6, 0.2], 40, 8);
    const asset: TextureAsset = {
      kind: 'texture',
      shape: { viewDimension: '3d', extent: { width: SIZE, height: SIZE, depth: SIZE } },
      format: 'r8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array(SIZE * SIZE * SIZE).fill(200),
    };
    const density = world.allocSharedRef('TextureAsset', asset);
    const data = {
      light,
      density,
      boundsMin: [-1.2, 0, -1.2],
      boundsMax: [1.2, 2.4, 1.2],
      extinction: [0.01, 0.01, 0.01],
      albedo: [0.9, 0.9, 0.9],
      emission: [0, 0, 0],
      anisotropy: 0.3,
      maxDistance: 30,
    };
    let fog = world.spawn({ component: VolumetricFog, data: data as never }).unwrap();
    let enabled = true;
    let onSample = app.renderer.inspect().volumetricFog;
    return {
      toggle(on) {
        if (!on && enabled) onSample = app.renderer.inspect().volumetricFog;
        enabled = on;
        if (on) fog = world.spawn({ component: VolumetricFog, data: data as never }).unwrap();
        else world.despawn(fog).unwrap();
      },
      checks() {
        // The runner checks after OFF; judge the ON state by the sample taken before the toggle.
        const volume = enabled ? app.renderer.inspect().volumetricFog : onSample;
        return [
          {
            name: 'one volumetric owner',
            ok: volume?.ownerCount === 1,
            detail: `ownerCount=${volume?.ownerCount}`,
          },
          {
            name: 'status available',
            ok: volume?.status === 'available',
            detail: `status=${volume?.status} stage=${volume?.resourceStage}`,
          },
          {
            name: 'point light selected',
            ok: volume?.selectedLight !== undefined,
            detail: JSON.stringify(volume?.selectedLight),
          },
        ];
      },
    };
  },
});
