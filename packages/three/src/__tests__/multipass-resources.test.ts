import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { samplerContribution } from '@forgeax/engine-render';
import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
} from 'three/src/Three.Core.js';
import { expect, it, vi } from 'vitest';
import { cameraData } from '../camera';
import { SceneProjection } from '../scene';

it('publishes no new assets after warming an offscreen-to-output composition', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const projection = new SceneProjection(assets);
  const scenes = [new Scene(), new Scene()];
  const meshes = scenes.map((scene) => {
    const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    scene.add(mesh);
    return mesh;
  });
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.z = 5;
  const create = vi.spyOn(assets, 'create');
  const replace = vi.spyOn(assets, 'replace');
  const sync = () => {
    for (const [index, scene] of scenes.entries()) {
      projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1), {
        deferResourceSweep: index === 0,
        depth: true,
        stencil: false,
        sortObjects: true,
        opaque: true,
        transparent: true,
        updateMatrices: true,
      });
    }
  };
  try {
    sync();
    expect(create).toHaveBeenCalled();
    create.mockClear();
    replace.mockClear();
    for (let frame = 0; frame < 10; frame++) sync();
    expect(create).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  } finally {
    create.mockRestore();
    replace.mockRestore();
    projection.dispose();
    assets.dispose();
    for (const mesh of meshes) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
});
