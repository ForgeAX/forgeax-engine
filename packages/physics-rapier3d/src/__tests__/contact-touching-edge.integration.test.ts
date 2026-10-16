import { beforeAll, expect, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { createDerivedColliderDesc } from '../derived-collider.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D, type Rapier3DModule } from '../wasm-loader.js';

let rapier: Rapier3DModule;
beforeAll(async () => {
  rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
});

it('keeps a nonzero plane normal for a newly admitted Hull/Cuboid touching edge', () => {
  const physics = createRapier3DPhysicsWorld(rapier);
  const raw = physics.raw;
  raw.gravity = { x: 0, y: 0, z: 0 };
  try {
    // Exact child pair captured before the first step of a newly admitted body.
    // The original hull must remain a hull: its f32 center is not exact.
    const hull = createDerivedColliderDesc(rapier, {
      kind: 'convex-compound',
      id: 'edge-hull',
      revision: 1,
      pieces: [boxPoints([2.9, 0.9, 1.4], [3, 1, 1.5])],
    });
    const box = createDerivedColliderDesc(rapier, {
      kind: 'convex-compound',
      id: 'edge-box',
      revision: 1,
      pieces: [boxPoints([2.5, 1, 0], [2.9, 8.2, 10.5])],
    });
    const boxParts = box.shape as InstanceType<typeof rapier.Compound>;
    expect(hull.shape.type).toBe(rapier.ShapeType.ConvexPolyhedron);
    expect(boxParts.shapes[0]?.type).toBe(rapier.ShapeType.Cuboid);
    const dynamic = raw.createRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(44, 0, 92).setAdditionalMass(612),
    );
    const fixed = raw.createRigidBody(
      rapier.RigidBodyDesc.fixed().setTranslation(44, Math.fround(9.536743306171047e-8), 84),
    );
    dynamic.userData = 1;
    fixed.userData = 2;
    // Keep the captured multi-piece collider's compound dispatch while
    // reducing it to the one child responsible for the failing manifold.
    raw.createCollider(
      new rapier.ColliderDesc(
        new rapier.Compound([hull.shape], [{ x: 0, y: 0, z: 0 }], [{ x: 0, y: 0, z: 0, w: 1 }]),
      )
        .setEnabled(true)
        .setDensity(0),
      dynamic,
    );
    raw.createCollider(box.setEnabled(true).setDensity(0), fixed);
    physics.registerBody(1, dynamic.handle);
    physics.registerBody(2, fixed.handle);
    for (let step = 0; step < 3; step += 1) {
      physics.step(1 / 60);
      const a = physics.getCurrentContacts(1).unwrap();
      const b = physics.getCurrentContacts(2).unwrap();
      expect(a.fixedStep).toBe(step + 1);
      expect(a.manifolds.length).toBeGreaterThan(0);
      expect(b.manifolds.length).toBe(a.manifolds.length);
      for (const [index, contact] of a.manifolds.entries()) {
        expect(contact.points.length).toBeGreaterThan(0);
        expect(contact.normal.every(Number.isFinite)).toBe(true);
        expect(Math.hypot(...contact.normal)).toBeCloseTo(1, 5);
        expect(b.manifolds[index]?.normal).toEqual(contact.normal.map((value) => -value));
        expect(contact.normalImpulse).toBe(0);
      }
    }
  } finally {
    physics.dispose();
  }
});
