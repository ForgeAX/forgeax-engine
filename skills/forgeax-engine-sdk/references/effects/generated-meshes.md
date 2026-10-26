# Meshes generated during play

Content that exists only because of play (a stem that grows, debris from a hit, water
that deforms) has no Pack declaration: build a `MeshAsset` in code and `assets.create` it.
The caller owns the returned handle; an ECS binding takes its own reference, so release
yours once nothing else writes to the mesh, and despawning the last user frees it.
Change a live mesh with `writeRange` when the vertex and index counts stay the same (cheap,
per frame) or `replace` with a complete new `MeshAsset` when its topology changes. The
materials still come from the Pack. Per-frame material `values` edits cannot move vertices.

The stem is one swept tube whose positions are rewritten every frame: rows past the
growth front collapse onto it, so it grows smoothly to a point. Each debris burst creates
fresh meshes with `createMeshBuilder`, which fills any missing normal, UV and tangent
streams, so positions and indices are enough.
A fixed gameplay seed makes every run drop the same shards.

```ts file=assets/play/growth.ts
import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { Time, Update, type EntityHandle, type World } from '@forgeax/engine/ecs';
import { createMeshBuilder, createSweepGeometry, type Vec3Point } from '@forgeax/engine/geometry';
import { Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue } from '@forgeax/engine/physics';
import { type Rng, rng } from '@forgeax/engine/math';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { propGuid } from './props.ts';

const ROWS = 48, SIDES = 8, RING = SIDES + 1, GROW = 8; // path samples, tube sides, ring vertices, rows/s
const ROOT = [4.5, 0, 1.5] as const;
const PATH = Array.from({ length: ROWS }, (_, i): Vec3Point => {
  const t = i / (ROWS - 1);
  return [Math.cos(t * 10) * 0.3 * t, t * 2.6, Math.sin(t * 10) * 0.3 * t];
});

/** Restore the front's row and collapse the rest onto the front point; earlier rows are already final. */
function front(full: Float32Array, grown: number) {
  const k = Math.min(ROWS - 2, Math.floor(grown)), f = Math.min(1, grown - k);
  const a = PATH[k]!, b = PATH[k + 1]!;
  const values = full.slice(k * RING * 3, ROWS * RING * 3);
  for (let i = RING * 3; i < values.length; i += 3)
    for (let axis = 0; axis < 3; axis++) values[i + axis] = a[axis] + (b[axis] - a[axis]) * f;
  return { attribute: 'position', first: k * RING, values } as const;
}

/** A flat-shaded random tetrahedron around the origin, with outward faces. */
function shard(rand: Rng) {
  const corners = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map((c) => c.map((v) => v * (0.08 + rand.next() * 0.1)));
  const position: number[] = [], normal: number[] = [], uv: number[] = [];
  for (const [i, j, k] of [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]] as const) {
    const a = corners[i]!, u = corners[j]!.map((v, x) => v - a[x]!), w = corners[k]!.map((v, x) => v - a[x]!);
    const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    const outward = n[0]! * a[0]! + n[1]! * a[1]! + n[2]! * a[2]! > 0; // counter-clockwise from outside
    const length = Math.hypot(n[0]!, n[1]!, n[2]!) * (outward ? 1 : -1);
    position.push(...a, ...corners[outward ? j : k]!, ...corners[outward ? k : j]!);
    for (let v = 0; v < 3; v++) normal.push(n[0]! / length, n[1]! / length, n[2]! / length);
    uv.push(0, 0, 1, 0, 0, 1);
  }
  const attributes = { position: new Float32Array(position), normal: new Float32Array(normal), uv: new Float32Array(uv) };
  return createMeshBuilder({ attributes, indices: [...Array(12).keys()] }).build().unwrap();
}

export async function* installGrowth(world: World, assets: AssetRegistry) {
  const [leaf, stone] = await Promise.all(['leaf', 'shard'].map(async (key) =>
    (await assets.load(propGuid(`material/${key}`), 'material')).unwrap()));
  yield () => { assets.release(leaf!).unwrap(); assets.release(stone!).unwrap(); };
  const source = createSweepGeometry(PATH, 0.05, SIDES).unwrap();
  const full = source.attributes.position; // create() captures its own copy; this one stays ours
  if (!(full instanceof Float32Array)) throw new Error('factory positions are Float32Array');
  const mesh = assets.create(source).unwrap(); // caller-owned reference, kept for writeRange
  yield () => assets.release(mesh).unwrap();
  assets.writeRange(mesh, front(full, 0)).unwrap();
  const stem = world.spawn({ component: Transform, data: { pos: [...ROOT] } },
    { component: MeshFilter, data: { assetHandle: mesh } }, { component: MeshRenderer, data: { materials: [leaf!] } }).unwrap();
  yield () => world.despawn(stem).unwrap();
  const rand = rng.create(42), debris: { entity: EntityHandle; until: number }[] = [];
  let nextBurst = 1;
  world.addSystem(Update, {
    name: 'play-growth', queries: [],
    fn() {
      const { elapsed } = world.getResource(Time);
      const cycle = (elapsed * GROW) % (ROWS + 2 * GROW); // grow, hold two seconds, regrow
      assets.writeRange(mesh, front(full, Math.min(ROWS - 1, cycle))).unwrap();
      if (elapsed >= nextBurst) {
        nextBurst = elapsed + 3;
        for (let i = 0; i < 6; i++) {
          const handle = assets.create(shard(rand)).unwrap();
          const entity = world.spawn(
            { component: Transform, data: { pos: [ROOT[0] + 1.2 + rand.next() - 0.5, 2.5 + rand.next(), ROOT[2] + rand.next() - 0.5] } },
            { component: MeshFilter, data: { assetHandle: handle } },
            { component: MeshRenderer, data: { materials: [stone!] } },
            { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, mass: 0.2 } },
            { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.1 } },
          ).unwrap();
          assets.release(handle).unwrap(); // MeshFilter now holds the only reference
          debris.push({ entity, until: elapsed + 4 });
        }
      }
      while (debris[0] !== undefined && debris[0].until <= elapsed)
        world.despawn(debris.shift()!.entity).unwrap(); // last reference dropped: the shard mesh is freed
    },
  }).unwrap();
  yield () => {
    world.removeSystem(Update, 'play-growth').unwrap();
    for (const { entity } of debris) world.despawn(entity).unwrap();
  };
}
```

`play.ts` composes both after `installPillars`. The props Pack is an ordinary Pack under
`assets/` and needs no forge.json root.
