# Procedural props built at pack time

Geometry known before play is a Pack output, not runtime code: one seeded `build` lathes
vases (`createRevolutionGeometry`), extrudes a bevelled gear with a hole
(`createExtrusionGeometry`), sweeps a star section along a leaning spine
(`createProfileSweepGeometry`) and a tube along a Catmull-Rom arch (`createSweepGeometry`).
The factories emit normals, UVs and tangents, so Standard materials shade them directly.
The `seed` parameter is the only source of variation: the same seed cooks the same
meshes, and a new seed (View **Generate**, or a Pack instance's `values`) re-cooks them.
The game loads the outputs by the GUIDs that `(packageId, sourceKey)` derive, like any asset.

| Files | Factories | Owner skill for details |
|:--|:--|:--|
| `props.pack.ts`, `props.ts` | revolution, extrusion, profile sweep, sweep | `forgeax-engine-assets`, `packages/geometry/README.md` |
| `growth.ts` | runtime `create` / `writeRange` / `release`, `MeshBuilder` | `packages/assets-runtime/README.md` |

```ts file=assets/play/props.pack.ts
import { createExtrusionGeometry, createProfileSweepGeometry, createRevolutionGeometry, createSweepGeometry,
  type Vec2Point, type Vec3Point } from '@forgeax/engine/geometry';
import { curve3, rng, vec3 } from '@forgeax/engine/math';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { Materials } from '@forgeax/engine/render';
import { ok } from '@forgeax/engine/types';

export const PROPS_PACKAGE = definePackageId('3b1f6a52-8c0e-4d6b-9f1e-2a7c5d0e9b43');
export const VASE_COUNT = 3;

/** Closed 2D loop (either winding); alternating radii make teeth or star points. */
const loop = (count: number, radius: (i: number) => number): Vec2Point[] =>
  Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    return { x: Math.cos(angle) * radius(i), y: Math.sin(angle) * radius(i) };
  });

export default definePack({
  schemaVersion: '2.0.0', packageId: PROPS_PACKAGE,
  parameters: [{ name: 'seed', type: 'u32', default: 7 }],
  build: ({ values }) => {
    const rand = rng.create(values.seed); // the seed fixes the stream; never Math.random()
    const vases = Object.fromEntries(Array.from({ length: VASE_COUNT }, (_, i) => {
      // Lathe a (radius, height) profile around +Y; radius 0 at both ends closes base and lid.
      const belly = 0.22 + rand.next() * 0.14, neck = 0.08 + rand.next() * 0.06, height = 0.8 + rand.next() * 0.5;
      const profile: Vec2Point[] = [{ x: 0, y: 0 }, { x: 0.16, y: 0 }, { x: belly, y: height * 0.35 },
        { x: neck, y: height * 0.8 }, { x: neck + 0.05, y: height }, { x: 0, y: height }];
      return [`mesh/vase-${i}`, createRevolutionGeometry(profile, 32).unwrap()];
    }));
    // Extrude a toothed contour with a hole along Z (centred), bevelling both rims.
    const teeth = 9 + Math.floor(rand.next() * 4);
    const gear = createExtrusionGeometry(loop(teeth * 4, (i) => (i % 4 < 2 ? 0.55 : 0.44)), 0.18,
      { holes: [loop(24, () => 0.14)], bevelSize: 0.03, bevelSegments: 2 }).unwrap();
    // Sweep a star section along a leaning spine; `up` must not be parallel to the first tangent.
    const lean = (rand.next() - 0.5) * 0.8;
    const spine = Array.from({ length: 24 }, (_, i): Vec3Point => [Math.sin((i / 23) * Math.PI) * lean, (i / 23) * 1.8, 0]);
    const column = createProfileSweepGeometry({ contour: loop(10, (i) => (i % 2 ? 0.09 : 0.2)) }, spine,
      { up: [1, 0, 0] }).unwrap();
    // Sweep a round tube along a sampled Catmull-Rom curve; sampling density is the author's.
    const knots = [[-0.7, 0, 0], [-0.6, 1.1 + rand.next() * 0.4, 0], [0.6, 1.1 + rand.next() * 0.4, 0], [0.7, 0, 0]];
    const point = vec3.create();
    const arch = Array.from({ length: 40 }, (_, i): Vec3Point => {
      curve3.catmullRom(point, knots, i / 39);
      return [point[0]!, point[1]!, point[2]!];
    });
    const pipe = createSweepGeometry(arch, 0.06, 12).unwrap();
    return ok({ ...vases, 'mesh/gear': gear, 'mesh/column': column, 'mesh/pipe': pipe,
      'material/glaze': Materials.standard({ baseColor: '#3f7fa6', roughness: 0.25 }),
      'material/brass': Materials.standard({ baseColor: '#c9a043', metallic: 1, roughness: 0.35 }),
      'material/marble': Materials.standard({ baseColor: '#e8e2d6', roughness: 0.6 }),
      'material/copper': Materials.standard({ baseColor: '#b8673e', metallic: 1, roughness: 0.4 }),
      'material/leaf': Materials.standard({ baseColor: '#4f9a3a', roughness: 0.7 }), // growth.ts
      'material/shard': Materials.standard({ baseColor: '#8c8f96', roughness: 0.8 }), // growth.ts
    });
  },
});
```

```ts file=assets/play/props.ts
import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { Time, Update, type World } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { PROPAGATE_TRANSFORMS_SYSTEM, Transform } from '@forgeax/engine/scene';
import { PROPS_PACKAGE, VASE_COUNT } from './props.pack.ts';

/** Pack and game share only the package id; each output GUID derives from its sourceKey. */
export const propGuid = (key: string) => AssetGuid.format(AssetGuid.derive(PROPS_PACKAGE, key));

export async function* installProps(world: World, assets: AssetRegistry) {
  const placed: [mesh: string, material: string, pos: [number, number, number]][] = [
    ...Array.from({ length: VASE_COUNT }, (_, i): [string, string, [number, number, number]] =>
      [`vase-${i}`, 'glaze', [-6 + i * 0.9, 0, 1.5]]),
    ['gear', 'brass', [-2, 0.62, 1.5]], ['column', 'marble', [0.5, 0, 1.5]], ['pipe', 'copper', [2.5, 0, 1.5]],
  ];
  const [meshes, materials] = await Promise.all([
    Promise.all(placed.map(async ([mesh]) => (await assets.load(propGuid(`mesh/${mesh}`), 'mesh')).unwrap())),
    Promise.all(placed.map(async ([, material]) => (await assets.load(propGuid(`material/${material}`), 'material')).unwrap())),
  ]);
  yield () => { for (const handle of [...meshes, ...materials]) assets.release(handle).unwrap(); };
  const props = placed.map(([, , pos], i) => world.spawn(
    { component: Transform, data: { pos } },
    { component: MeshFilter, data: { assetHandle: meshes[i]! } },
    { component: MeshRenderer, data: { materials: [materials[i]!] } },
  ).unwrap());
  yield () => { for (const entity of props) world.despawn(entity).unwrap(); };
  const gear = props[VASE_COUNT]!, spin = quat.create();
  world.addSystem(Update, {
    name: 'play-gear-spin', before: [PROPAGATE_TRANSFORMS_SYSTEM], queries: [],
    fn() {
      quat.fromAxisAngle(spin, [0, 0, 1], world.getResource(Time).elapsed * 0.8);
      world.set(gear, Transform, { quat: spin }).unwrap();
    },
  }).unwrap();
  yield () => world.removeSystem(Update, 'play-gear-spin').unwrap();
}
```
