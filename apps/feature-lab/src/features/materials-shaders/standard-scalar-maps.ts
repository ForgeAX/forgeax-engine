import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { materialToggle } from './lib/swap';
import { pixels, texture } from './lib/textures';

export default defineFeature({
  title: 'Independent Standard scalar maps',
  catalog: 'Independent Standard scalar maps',
  kind: 'visual',
  summary:
    'Standard takes separate metallicTexture / roughnessTexture / alphaTexture with channel selectors. Here a G-channel stripe map drives alpha (with alphaCutoff) and an R-channel map drives roughness, without repacking.',
  expect:
    'ON: the blue cube is cut into horizontal slats (alphaTexture + alphaCutoff 0.5) with alternating glossy/matte columns. OFF: the same cube without the maps is solid and uniformly lit.',
  setup({ world }) {
    spawnStage(world, { eye: [2.5, 2, 3.5], target: [0, 0.8, 0] });
    const slats = texture(
      world,
      64,
      pixels(64, (_u, v) => [0, Math.floor(v * 8) % 2 === 0 ? 255 : 0, 0, 255]),
      'linear',
    );
    const columns = texture(
      world,
      64,
      pixels(64, (u) => [Math.floor(u * 6) % 2 === 0 ? 20 : 255, 0, 0, 255]),
      'linear',
    );
    const base = { baseColor: [0.15, 0.35, 1, 1] as const, metallic: 0.2, roughness: 1 };
    const mapped = standard(world, {
      ...base,
      alphaTexture: slats as never,
      alphaCutoff: 0.5,
      roughnessTexture: columns as never,
      roughnessChannel: 0,
      renderState: { cullMode: 'none' },
    });
    const plain = standard(world, base);
    const cube = spawnMesh(world, MESH.cube, mapped, { pos: [0, 0.8, 0], scale: [1.5, 1.5, 1.5] });
    return { toggle: materialToggle(world, cube, mapped, plain) };
  },
});
