import { expect, it, vi } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

async function fixture(iterations = 4) {
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module);
  const raw = physics.raw;
  raw.integrationParameters.numSolverIterations = iterations;
  const floor = raw.createRigidBody(module.RigidBodyDesc.fixed());
  floor.userData = 1;
  raw.createCollider(module.ColliderDesc.cuboid(3, 0.2, 3), floor);
  physics.registerBody(1, floor.handle);
  const body = raw.createRigidBody(module.RigidBodyDesc.dynamic().setTranslation(0, 1.1, 0));
  body.userData = 2;
  raw.createCollider(
    module.ColliderDesc.cuboid(0.5, 0.5, 0.5).setMass(120).setRestitution(0),
    body,
  );
  physics.registerBody(2, body.handle);
  return { physics, raw, body, floor };
}

it.each([
  1, 2, 4, 8,
])('reports only this step impulse with %i solver iterations', async (iterations) => {
  const { physics, body } = await fixture(iterations);
  try {
    let bearingSteps = 0;
    let maximumResidual = 0;
    for (let step = 0; step < 100; step += 1) {
      body.wakeUp();
      const before = body.linvel().y;
      physics.step(1 / 60);
      const snapshot = physics.getCurrentContacts(2).unwrap();
      expect(snapshot.fixedStep).toBe(step + 1);
      expect(snapshot.deltaTime).toBeCloseTo(1 / 60, 7);
      const impulse = snapshot.manifolds.reduce(
        (sum, contact) => sum + (contact.normalImpulse ?? 0),
        0,
      );
      if (impulse > 0) bearingSteps += 1;
      const momentumImpulse = body.mass() * (body.linvel().y - before + 9.81 * snapshot.deltaTime);
      maximumResidual = Math.max(maximumResidual, Math.abs(impulse - momentumImpulse));
      if (step > 75) expect(impulse / snapshot.deltaTime).toBeCloseTo(body.mass() * 9.81, 1);
    }
    expect(bearingSteps).toBeGreaterThan(60);
    // Includes the first impact and every warm-started subsequent native step.
    expect(maximumResidual).toBeLessThan(0.02);
  } finally {
    physics.dispose();
  }
});

it('keeps current resting geometry but does not replay sleeping impulses, moved or retired bodies', async () => {
  const { physics, body } = await fixture();
  try {
    expect(physics.getCurrentContacts(2)).toMatchObject({ ok: false });
    for (let step = 0; step < 180; step += 1) physics.step(1 / 60);
    expect(body.isSleeping()).toBe(true);
    const resting = physics.getCurrentContacts(2).unwrap();
    expect(resting.manifolds).toHaveLength(1);
    const manifold = resting.manifolds[0];
    expect(manifold).toMatchObject({ other: 1, normalImpulse: null });
    expect(manifold?.normal[1]).toBeCloseTo(-1, 6);
    expect(manifold?.points).toHaveLength(4);
    for (const point of manifold?.points ?? []) expect(point[1]).toBeCloseTo(0.2, 2);
    const other = physics.getCurrentContacts(1).unwrap().manifolds[0];
    expect(other?.normal[1]).toBeCloseTo(1, 6);
    const beforeWake = physics.getBodyMotion(2).unwrap();
    physics.wakeBody(2).unwrap();
    expect(physics.getBodyMotion(2).unwrap()).toEqual({ ...beforeWake, sleeping: false });
    expect(physics.getCurrentContacts(2)).toMatchObject({ ok: false });
    physics.step(1 / 60);
    expect(physics.getCurrentContacts(2).unwrap().manifolds[0]?.normalImpulse).toBeGreaterThan(0);
    expect(resting.manifolds[0]?.normalImpulse).toBeNull();

    physics
      .setBodyMotion(2, {
        position: [8, 2, 0],
        rotation: [0, 0, 0, 1],
        linearVelocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
      })
      .unwrap();
    expect(physics.getCurrentContacts(2)).toMatchObject({ ok: false });
    physics.step(1 / 60);
    expect(physics.getCurrentContacts(2).unwrap().manifolds).toEqual([]);
    physics.removeEntity(2);
    expect(physics.wakeBody(2)).toMatchObject({
      ok: false,
      error: { code: 'managed-body-missing' },
    });
    expect(physics.getCurrentContacts(2)).toMatchObject({
      ok: false,
      error: { code: 'managed-body-missing' },
    });
    expect(physics.getCurrentContacts(1).unwrap().manifolds).toEqual([]);
  } finally {
    physics.dispose();
  }
  expect(physics.getCurrentContacts(1)).toMatchObject({ ok: false });
  expect(physics.wakeBody(1)).toMatchObject({ ok: false });
});

it('projects unique current neighbors in the requested normal direction without decoding points', async () => {
  const { physics, raw, body } = await fixture();
  try {
    expect(physics.getCurrentContactNeighbors(2)).toMatchObject({ ok: false });
    for (let step = 0; step < 180; step += 1) physics.step(1 / 60);
    const normal = { direction: [0, -1, 0] as const, minimumDot: 0.2 };
    const full = physics.getCurrentContacts(2).unwrap();
    const manifoldRead = vi.spyOn(raw.narrowPhase, 'contactPair');
    const neighbors = physics.getCurrentContactNeighbors(2, undefined, normal).unwrap();
    expect(neighbors).toEqual({
      fixedStep: full.fixedStep,
      deltaTime: full.deltaTime,
      entities: [1],
    });
    expect(manifoldRead).not.toHaveBeenCalled();
    expect(physics.getCurrentContactNeighbors(1, undefined, normal).unwrap().entities).toEqual([]);
    expect(physics.getCurrentContactNeighbors(1).unwrap().entities).toEqual([2]);
    expect(physics.getCurrentContactNeighbors(2, 0).unwrap().entities).toEqual([]);
    for (const minimumDot of [1, 1 - Number.EPSILON, 1 + Number.EPSILON]) {
      expect(
        physics
          .getCurrentContactNeighbors(2, undefined, { direction: [0, -1, 0], minimumDot })
          .unwrap().entities,
      ).toEqual(minimumDot < 1 ? [1] : []);
      expect(
        physics
          .getCurrentContactNeighbors(1, undefined, { direction: [0, 1, 0], minimumDot })
          .unwrap().entities,
      ).toEqual(minimumDot < 1 ? [2] : []);
    }
    for (const direction of [
      [NaN, 0, 0],
      [0, Infinity, 0],
      [0, 0, -Infinity],
    ] as const) {
      expect(
        physics.getCurrentContactNeighbors(2, undefined, { direction, minimumDot: 0 }),
      ).toMatchObject({ ok: false });
    }
    for (const minimumDot of [NaN, Infinity, -Infinity]) {
      expect(
        physics.getCurrentContactNeighbors(2, undefined, { ...normal, minimumDot }),
      ).toMatchObject({ ok: false });
    }
    expect(
      physics
        .getCurrentContactNeighbors(2, undefined, { direction: [0, -1e100, 0], minimumDot: 1e99 })
        .unwrap().entities,
    ).toEqual([1]);
    expect(body.isSleeping()).toBe(true);
    physics.wakeBody(2).unwrap();
    expect(physics.getCurrentContactNeighbors(2)).toMatchObject({ ok: false });
    physics.step(1 / 60);
    expect(physics.getCurrentContactNeighbors(2, undefined, normal).unwrap().entities).toEqual([1]);
    expect(neighbors.entities).toEqual([1]);
    physics.removeEntity(2);
    expect(physics.getCurrentContactNeighbors(2)).toMatchObject({
      ok: false,
      error: { code: 'managed-body-missing' },
    });
    expect(physics.getCurrentContactNeighbors(1).unwrap().entities).toEqual([]);
    expect(physics.getCurrentContacts(1).unwrap().manifolds).toEqual([]);
  } finally {
    physics.dispose();
  }
  expect(physics.getCurrentContactNeighbors(1)).toMatchObject({ ok: false });
});

it('deduplicates collider contacts and rejects unowned or replaced native bodies', async () => {
  const { physics, raw, body, floor } = await fixture();
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  try {
    raw.createCollider(module.ColliderDesc.cuboid(0.2, 0.5, 0.2).setTranslation(0.65, 0, 0), body);
    for (let step = 0; step < 90; step += 1) physics.step(1 / 60);
    const full = physics.getCurrentContacts(2).unwrap().manifolds;
    expect(full.length).toBeGreaterThan(1);
    const normal = { direction: [0, -1, 0] as const, minimumDot: 0.2 };
    expect(physics.getCurrentContactNeighbors(2, undefined, normal).unwrap().entities).toEqual([
      ...new Set(full.filter((row) => -row.normal[1] > normal.minimumDot).map((row) => row.other)),
    ]);
    expect(physics.getCurrentContactNeighbors(1).unwrap().entities).toEqual([2]);
    floor.collider(0).setEnabled(false);
    expect(physics.getCurrentContactNeighbors(2).unwrap().entities).toEqual([]);
    floor.collider(0).setEnabled(true);
    floor.userData = undefined;
    expect(physics.getCurrentContactNeighbors(2).unwrap().entities).toEqual([]);
    floor.userData = 1;
    expect(physics.getCurrentContactNeighbors(2).unwrap().entities).toEqual([1]);
    const replacement = raw.createRigidBody(
      module.RigidBodyDesc.dynamic().setTranslation(50, 50, 0),
    );
    replacement.userData = 2;
    physics.registerBody(2, replacement.handle);
    physics.step(1 / 60);
    expect(physics.getCurrentContactNeighbors(1).unwrap().entities).toEqual([]);
  } finally {
    physics.dispose();
  }
});

it('prefilters native contacts without relying on collision event flags or publishing manifolds', async () => {
  const { physics } = await fixture();
  try {
    expect(physics.hasManagedContactPair(2, 1)).toBeUndefined();
    for (let step = 0; step < 180; step += 1) physics.step(1 / 60);
    expect(physics.getCollisionPairs().get(2)?.has(1)).not.toBe(true);
    const publication = vi.spyOn(physics, 'getCurrentContacts');
    expect(physics.hasManagedContactPair(2, 1)).toBe(true);
    expect(physics.hasManagedContactPair(1, 2)).toBe(true);
    expect(publication).not.toHaveBeenCalled();
    expect(
      physics
        .getCurrentContacts(2)
        .unwrap()
        .manifolds.some((row) => row.other === 1),
    ).toBe(true);
    physics
      .setBodyMotion(2, {
        position: [8, 2, 0],
        rotation: [0, 0, 0, 1],
        linearVelocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
      })
      .unwrap();
    expect(physics.hasManagedContactPair(2, 1)).toBeUndefined();
    physics.step(1 / 60);
    expect(physics.hasManagedContactPair(2, 1)).toBe(false);
    expect(physics.getCurrentContacts(2).unwrap().manifolds).toEqual([]);
    physics.removeEntity(2);
    expect(physics.hasManagedContactPair(2, 1)).toBeUndefined();
  } finally {
    physics.dispose();
  }
  expect(physics.hasManagedContactPair(1, 2)).toBeUndefined();
});

it.each([
  'wake',
  'sleep',
] as const)('observes current awake state after a public native owner accessor (%s)', async (transition) => {
  const { physics, body } = await fixture();
  try {
    for (let step = 0; step < 90; step += 1) {
      body.wakeUp();
      physics.step(1 / 60);
    }
    if (transition === 'wake') body.wakeUp();
    else body.sleep();
    const expected = physics.getCurrentContacts(2).unwrap();
    expect(expected.manifolds).toHaveLength(1);
    if (transition === 'wake') expect(expected.manifolds[0]?.normalImpulse).toBeGreaterThan(0);
    else expect(expected.manifolds[0]?.normalImpulse).toBeNull();

    if (transition === 'wake') body.sleep();
    else body.wakeUp();
    let reads = 0;
    Object.defineProperty(body, 'userData', {
      configurable: true,
      get() {
        reads += 1;
        if (transition === 'wake') body.wakeUp();
        else body.sleep();
        return 2;
      },
    });
    const observed = physics.getCurrentContacts(2).unwrap();
    expect(reads).toBe(1);
    expect(body.isSleeping()).toBe(transition === 'sleep');
    expect(observed).toEqual(expected);
  } finally {
    physics.dispose();
  }
});

it('preserves native manifold order and impulses across ordinary repeated owner reads', async () => {
  const { physics, body, raw } = await fixture();
  try {
    const module = await loadRapier3D();
    if ('code' in module) throw module;
    const peer = raw.createRigidBody(module.RigidBodyDesc.dynamic().setTranslation(0.9, 0.69, 0));
    peer.userData = 3;
    raw.createCollider(module.ColliderDesc.cuboid(0.5, 0.5, 0.5), peer);
    physics.registerBody(3, peer.handle);
    for (let step = 0; step < 90; step += 1) {
      body.wakeUp();
      peer.wakeUp();
      physics.step(1 / 60);
    }
    for (let step = 0; step < 30; step += 1) {
      body.wakeUp();
      peer.wakeUp();
      physics.step(1 / 60);
      const first = physics.getCurrentContacts(2).unwrap();
      const second = physics.getCurrentContacts(2).unwrap();
      expect(second).toEqual(first);
      expect(first.manifolds.some((manifold) => manifold.other === 1)).toBe(true);
      expect(first.manifolds.every((manifold) => manifold.normalImpulse !== null)).toBe(true);
    }
  } finally {
    physics.dispose();
  }
});

it('preserves compound shape identity and transformed world-space solver points', async () => {
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module);
  try {
    const floor = physics.raw.createRigidBody(
      module.RigidBodyDesc.fixed().setTranslation(4, 2, -3).setRotation({
        x: 0,
        y: Math.SQRT1_2,
        z: 0,
        w: Math.SQRT1_2,
      }),
    );
    floor.userData = 1;
    physics.registerBody(1, floor.handle);
    physics
      .admitDerivedShapeCandidate(
        physics
          .prepareDerivedShapeCandidate({
            entity: 1,
            revision: 0,
            sourceKey: 'supports',
            bodyType: 'static',
            shapes: [
              {
                kind: 'convex-compound',
                id: 'offset-supports',
                revision: 0,
                origin: [0, 0.5, 0],
                pieces: [
                  boxPoints([-2, -0.2, -0.5], [-1, 0.2, 0.5]),
                  boxPoints([1, -0.2, -0.5], [2, 0.2, 0.5]),
                ],
              },
            ],
          })
          .unwrap(),
      )
      .unwrap();
    const body = physics.raw.createRigidBody(
      module.RigidBodyDesc.dynamic().setTranslation(4, 3.5, -3),
    );
    body.userData = 2;
    physics.registerBody(2, body.handle);
    physics
      .admitDerivedShapeCandidate(
        physics
          .prepareDerivedShapeCandidate({
            entity: 2,
            revision: 0,
            sourceKey: 'load',
            bodyType: 'dynamic',
            shapes: [
              {
                kind: 'convex-compound',
                id: 'load',
                revision: 0,
                pieces: [boxPoints([-0.4, -0.2, -2], [0.4, 0.2, 2])],
              },
            ],
            massProperties: { mode: 'automatic', density: 120 },
          })
          .unwrap(),
      )
      .unwrap();
    let maximumResidual = 0;
    for (let step = 0; step < 100; step += 1) {
      body.wakeUp();
      const before = body.linvel().y;
      physics.step(1 / 60);
      const current = physics.getCurrentContacts(2).unwrap();
      const impulseY = current.manifolds.reduce(
        (sum, contact) => sum - contact.normal[1] * (contact.normalImpulse ?? 0),
        0,
      );
      const momentumImpulse = body.mass() * (body.linvel().y - before + 9.81 * current.deltaTime);
      maximumResidual = Math.max(maximumResidual, Math.abs(impulseY - momentumImpulse));
    }
    expect(maximumResidual).toBeLessThan(0.02);
    const contacts = physics.getCurrentContacts(2).unwrap();
    expect(
      physics
        .getCurrentContactNeighbors(2, undefined, { direction: [0, -1, 0], minimumDot: 0.2 })
        .unwrap().entities,
    ).toEqual([
      ...new Set(contacts.manifolds.filter((row) => row.normal[1] < -0.2).map((row) => row.other)),
    ]);
    // Native clustering merges the two coplanar support manifolds into one solver manifold.
    expect(contacts.manifolds).toHaveLength(1);
    const totalImpulse = contacts.manifolds.reduce(
      (sum, contact) => sum + (contact.normalImpulse ?? 0),
      0,
    );
    expect(totalImpulse / contacts.deltaTime).toBeCloseTo(body.mass() * 9.81, 0);
    for (const contact of contacts.manifolds) {
      expect(contact).toMatchObject({ other: 1, shape: 'load', otherShape: 'offset-supports' });
      expect(contact.normal[1]).toBeCloseTo(-1, 6);
      expect(contact.points.length).toBeGreaterThan(0);
      for (const point of contact.points) {
        expect(point[0]).toBeGreaterThan(3.4);
        expect(point[0]).toBeLessThan(4.6);
        expect(point[1]).toBeCloseTo(2.7, 2);
        expect(Math.abs(point[2] + 3)).toBeGreaterThan(0.95);
        expect(Math.abs(point[2] + 3)).toBeLessThan(2.05);
      }
    }
    const reverse = physics.getCurrentContacts(1).unwrap();
    expect(reverse.manifolds).toHaveLength(1);
    for (const contact of reverse.manifolds) {
      expect(contact).toMatchObject({ other: 2, shape: 'offset-supports', otherShape: 'load' });
      expect(contact.normal[1]).toBeCloseTo(1, 6);
    }
  } finally {
    physics.dispose();
  }
});

it('excludes sensors from physical contacts', async () => {
  const { physics, raw, body, floor } = await fixture();
  try {
    body.collider(0).setSensor(true);
    body.setTranslation({ x: 0, y: 0.65, z: 0 }, true);
    physics.step(1 / 60);
    expect(raw.intersectionPair(body.collider(0), floor.collider(0))).toBe(true);
    expect(physics.getCurrentContacts(2).unwrap().manifolds).toEqual([]);
    expect(physics.getCurrentContactNeighbors(2).unwrap().entities).toEqual([]);
  } finally {
    physics.dispose();
  }
});

it.each([
  false,
  true,
])('filters contact groups before manifold decoding, sleeping=%s', async (sleeping) => {
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module);
  try {
    const supports = [
      { entity: 1, x: -1, groups: 0x0001fffe, type: module.RigidBodyDesc.fixed() },
      { entity: 3, x: 0, groups: 0x0011ffff, type: module.RigidBodyDesc.fixed() },
      { entity: 4, x: 1, groups: 0x0002000d, type: module.RigidBodyDesc.kinematicPositionBased() },
    ];
    for (const { entity, x, groups, type } of supports) {
      const support = physics.raw.createRigidBody(type.setTranslation(x, 0, 0));
      support.userData = entity;
      physics.raw.createCollider(
        module.ColliderDesc.cuboid(0.45, 0.2, 0.5).setCollisionGroups(groups),
        support,
      );
      physics.registerBody(entity, support.handle);
    }
    const body = physics.raw.createRigidBody(
      module.RigidBodyDesc.dynamic().setTranslation(0, 0.69, 0),
    );
    body.userData = 2;
    physics.raw.createCollider(
      module.ColliderDesc.cuboid(1.5, 0.5, 0.5).setCollisionGroups(0x0011ffff),
      body,
    );
    physics.registerBody(2, body.handle);
    for (let step = 0; step < 30; step += 1) physics.step(1 / 60);
    if (sleeping) body.sleep();
    const complete = physics.getCurrentContacts(2).unwrap();
    expect(new Set(complete.manifolds.map((contact) => contact.other))).toEqual(new Set([1, 3, 4]));
    expect(
      complete.manifolds.every((contact) => (contact.normalImpulse === null) === sleeping),
    ).toBe(true);
    const decode = vi.spyOn(physics.raw.narrowPhase, 'contactPair');
    try {
      const selected = physics.getCurrentContacts(2, 0xffff001e).unwrap();
      expect(selected).toEqual({
        ...complete,
        manifolds: complete.manifolds.filter((contact) => contact.other !== 1),
      });
      expect(decode).toHaveBeenCalledTimes(2);
      decode.mockClear();
      // The partner's filter must accept the query membership, too.
      expect(physics.getCurrentContacts(2, 0x00020002).unwrap().manifolds).toEqual([]);
      expect(decode).not.toHaveBeenCalled();
      expect(
        [...physics.getCurrentContactNeighbors(2, 0xffff001e).unwrap().entities].sort(),
      ).toEqual([3, 4]);
      expect(physics.getCurrentContactNeighbors(2, 0x00020002).unwrap().entities).toEqual([]);
      expect(physics.getCurrentContactNeighbors(2, 0).unwrap().entities).toEqual([]);
      expect(decode).not.toHaveBeenCalled();
      expect(physics.getCurrentContacts(2, 0).unwrap().manifolds).toEqual([]);
      expect(decode).not.toHaveBeenCalled();
      expect(physics.getCurrentContacts(2).unwrap()).toEqual(complete);
      expect(physics.getCurrentContacts(2, 0xffffffff).unwrap()).toEqual(complete);
    } finally {
      decode.mockRestore();
    }
  } finally {
    physics.dispose();
  }
});

it.each([
  750, 2050,
])('bounds each native projection atomically with %i contact partners', async (count) => {
  const module = await loadRapier3D();
  if ('code' in module) throw module;
  const physics = createRapier3DPhysicsWorld(module);
  try {
    const floor = physics.raw.createRigidBody(module.RigidBodyDesc.fixed());
    floor.userData = 1;
    physics.raw.createCollider(module.ColliderDesc.cuboid(100, 0.2, 100), floor);
    physics.registerBody(1, floor.handle);
    for (let index = 0; index < count; index += 1) {
      const body = physics.raw.createRigidBody(
        module.RigidBodyDesc.dynamic().setTranslation(
          (index % 46) * 3 - 70,
          0.69,
          Math.floor(index / 46) * 3 - 70,
        ),
      );
      body.userData = index + 2;
      physics.raw.createCollider(module.ColliderDesc.cuboid(0.5, 0.5, 0.5), body);
      physics.registerBody(index + 2, body.handle);
    }
    physics.step(1 / 60);
    expect(physics.getCurrentContacts(2).unwrap().manifolds).toHaveLength(1);
    expect(physics.getCurrentContacts(1)).toMatchObject({
      ok: false,
      error: {
        code: 'managed-physics-unavailable',
        detail: {
          reason: expect.stringMatching(
            /4096 native visits for entity 1: colliders=1, pairs=\d+, manifolds=\d+, points=\d+; exhausted at points/,
          ),
        },
      },
    });
    expect(physics.getCurrentContacts(1, 0).unwrap().manifolds).toEqual([]);
    const neighbors = physics.getCurrentContactNeighbors(1);
    if (count === 750)
      expect(new Set(neighbors.unwrap().entities)).toEqual(
        new Set(Array.from({ length: count }, (_, index) => index + 2)),
      );
    else
      expect(neighbors).toMatchObject({
        ok: false,
        error: {
          code: 'managed-physics-unavailable',
          detail: {
            reason: expect.stringContaining(
              'colliders=1, pairs=2048, manifolds=2048, points=0; exhausted at manifolds',
            ),
          },
        },
      });
    expect(physics.getCurrentContactNeighbors(1, 0).unwrap().entities).toEqual([]);
    expect(physics.getCurrentContactNeighbors(2).unwrap().entities).toEqual([1]);
    // A failed callback must release its raw temporary pointers and permit later queries/steps.
    expect(physics.getCurrentContacts(2).unwrap().manifolds).toHaveLength(1);
    physics.step(1 / 60);
    expect(physics.getCurrentContacts(2).unwrap().fixedStep).toBe(2);
    expect(physics.getCurrentContactNeighbors(2).unwrap().entities).toEqual([1]);
  } finally {
    physics.dispose();
  }
});
