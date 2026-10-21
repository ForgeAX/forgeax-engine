// Run after a normal Engine build: node packages/physics-rapier3d/bench/derived-admission.bench.ts
// Optionally pass the absolute baseline dist/index.mjs to alternate both builds.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { ok, toShared } from '@forgeax/engine-types';
import * as candidate from '../dist/index.mjs';

const arms = new Map([['candidate', candidate]]);
if (process.argv[2]) arms.set('baseline', await import(pathToFileURL(process.argv[2]).href));
const native = await candidate.loadRapier3D();
if ('code' in native) throw native;
const rows = [];
for (const count of [32, 128, 256, 512]) {
  for (let repeat = 0; repeat < 9; repeat++) {
    const order = [...arms];
    if (repeat % 2) order.reverse();
    for (const [arm, engine] of order) {
      const physics = engine.createRapier3DPhysicsWorld(native);
      try {
        for (let entity = 1; entity <= count; entity++) {
          physics.ensureBody(
            entity,
            {
              position: { x: entity * 5, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0, w: 1 },
              scale: { x: 1, y: 1, z: 1 },
            },
            {
              type: 1,
              mass: 1,
              linearDamping: 0,
              angularDamping: 0,
              gravityScale: 0,
              ccdEnabled: 0,
            },
            {
              shape: 0,
              mesh: toShared<'MeshAsset'>(0),
              halfExtents: [0.25, 0.25, 0.25],
              radius: 0.25,
              halfHeight: 0.25,
              friction: 0.5,
              restitution: 0,
              density: 1,
              isSensor: false,
              collisionGroups: 0xffffffff,
              solverGroups: 0xffffffff,
            },
          );
        }
        const input = Array.from({ length: count }, (_, i) => ({
          entity: i + 1,
          sourceKey: `retire:${i + 1}`,
          revision: 1,
          bodyType: 'static' as const,
          shapes: [],
          velocityPolicy: 'reset' as const,
        }));
        let start = performance.now();
        const prepared = physics.prepareDerivedShapeCandidates(input).unwrap();
        const prepareMs = performance.now() - start;
        let commits = 0;
        start = performance.now();
        physics
          .admitDerivedShapeCandidates(prepared, () => {
            commits++;
            return ok(undefined);
          })
          .unwrap();
        const admitMs = performance.now() - start;
        start = performance.now();
        physics.step(1 / 60);
        const stepMs = performance.now() - start;
        assert.equal(commits, 1);
        for (let entity = 1; entity <= count; entity++)
          assert.equal(physics.getDerivedPublication(entity)?.revision, 1);
        rows.push({ arm, count, repeat, prepareMs, admitMs, stepMs });
      } finally {
        physics.dispose();
      }
    }
  }
}
process.stdout.write(
  `${JSON.stringify({ scope: 'Native batch retirement; not gameplay FPS', rows }, null, 2)}\n`,
);
