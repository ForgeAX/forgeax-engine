// The scene under test: three delivered assets (two with LODs) and 38 placements, one of them mirrored.
// Every asset is produced by the real kernel delivery path; placements are plain data handed to sceneManifest.
import { box, cylinder } from '../../src/brep/build.ts';
import { type DeliveredAsset, deliverAsset } from '../../src/deliver.ts';
import type { SceneAsset, ScenePlacement } from '../../src/scene-manifest.ts';
import type { DeliverySource } from '../../src/deliver.ts';
import type { Tuple3 } from '../../src/geom.ts';

const exact = await import('../../src/brep/index.ts');

function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`primitive failed: ${r.error.code}`);
  return r.value;
}

function deliver(source: DeliverySource, sizes: readonly number[], lods?: readonly number[]): DeliveredAsset {
  const r = deliverAsset(source, 'desktop-hero', {
    exact,
    sizes,
    merge: {},
    ...(lods === undefined ? {} : { lods }),
  });
  if (!r.ok) throw new Error(`delivery failed: ${r.error.code} ${JSON.stringify(r.error.detail)}`);
  return r.value;
}

const crate = deliver(
  {
    parts: [
      { name: 'body', shape: must(box({ size: [1, 1, 1] })), material: 'wood' },
      { name: 'band', shape: must(box({ size: [1.02, 1.02, 0.12] })), material: 'iron' },
    ],
  },
  [0.35],
);

const barrel = deliver(
  {
    parts: [
      { name: 'staves', shape: must(cylinder({ radius: 0.5, height: 1.2 })), material: 'wood' },
      { name: 'hoops', shape: must(cylinder({ radius: 0.52, height: 0.1 })), material: 'iron' },
    ],
  },
  [0.3],
  [0.7, 1.0],
);

const pillar = deliver(
  { parts: [{ name: 'shaft', shape: must(cylinder({ radius: 0.25, height: 3 })), material: 'stone' }] },
  [0.4],
);

// LOD distances are the camera ranges at which each coarser level takes over.
export const SCENE_ASSETS: readonly SceneAsset[] = [
  { id: 'crate', asset: { mesh: crate.mesh, lods: crate.lods, textures: crate.textures } },
  {
    id: 'barrel',
    asset: { mesh: barrel.mesh, lods: barrel.lods, textures: barrel.textures },
    lodDistances: [8, 16],
  },
  { id: 'pillar', asset: { mesh: pillar.mesh, lods: pillar.lods, textures: pillar.textures } },
];

/** Deterministic placements: a 6 x 5 field of crates, a barrel row (one mirrored), and two pillars. */
function scatter(): ScenePlacement[] {
  const out: ScenePlacement[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 6; col++) {
      const yaw = ((row * 6 + col) % 4) * (Math.PI / 2);
      const rotation: [number, number, number, number] = [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)];
      out.push({
        asset: 'crate',
        name: `crate-${row}-${col}`,
        position: [col * 2.2 - 5.5, row * 2.2 - 3.3, 0.5] as Tuple3,
        rotation,
      });
    }
  }
  for (let i = 0; i < 6; i++) {
    out.push({
      asset: 'barrel',
      name: `barrel-${i}`,
      position: [-8 + i * 3.2, -9, 0.6] as Tuple3,
      scale: i === 2 ? [-1.2, 1.2, 1.2] : 1.2,
    });
  }
  out.push({ asset: 'pillar', name: 'pillar-0', position: [-7, 6, 1.5] as Tuple3 });
  out.push({ asset: 'pillar', name: 'pillar-1', position: [7, 6, 1.5] as Tuple3 });
  return out;
}

export const SCENE_PLACEMENTS: readonly ScenePlacement[] = scatter();
