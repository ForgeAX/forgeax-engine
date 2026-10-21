import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  Collider,
  type DerivedPhysicsCandidate,
  type DerivedPhysicsCandidateInput,
  type PhysicsConstraintInput,
  RigidBody,
  type RigidBodyType,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { type AssetHandle, err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d';
import { loadRapier3D, type Rapier3DModule } from '../wasm-loader';

function compoundCandidate(entity: number, revision: number, worldIdentity?: object) {
  return {
    entity,
    revision,
    sourceKey: `body:${entity}`,
    ...(worldIdentity === undefined ? {} : { worldIdentity }),
    shapes: [
      {
        id: 'left',
        revision,
        kind: 'convex-compound' as const,
        pieces: [boxPoints([-1, 0, 0], [1, 1, 1])],
        origin: [0, 0, 0] as const,
      },
      {
        id: 'right',
        revision,
        kind: 'convex-compound' as const,
        pieces: [boxPoints([0, 0, 0], [1, 1, 1])],
        origin: [2, 0, 0] as const,
      },
    ],
    bodyType: 'dynamic' as const,
    massProperties: {
      mode: 'explicit' as const,
      mass: 2,
      centerOfMass: [0.25, 0, 0] as const,
      principalInertia: [1, 1, 1] as const,
    },
    velocityPolicy: 'preserve' as const,
    constraints: [],
  };
}

function addBody(
  pw: ReturnType<typeof createRapier3DPhysicsWorld>,
  entity: number,
  position: [number, number, number],
  rotation: readonly [number, number, number, number] = [0, 0, 0, 1],
) {
  pw.ensureBody(
    entity,
    {
      position: { x: position[0], y: position[1], z: position[2] },
      rotation: { x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] },
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
      mesh: 0 as AssetHandle<'mesh'>,
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

describe('complete derived admission projection', () => {
  it.each([
    'publish',
    'cancel',
    'dispose',
  ] as const)('copies candidate geometry only when inspected, independently of %s', async (finish) => {
    const module = await loadRapier3D();
    if ('code' in module) throw module;
    const physics = createRapier3DPhysicsWorld(module);
    const writes = vi.spyOn(Float32Array.prototype, 'set');
    try {
      addBody(physics, 7, [0, 0, 0]);
      const source = compoundCandidate(7, 1);
      const expected = source.shapes.map((shape) => shape.pieces.map((piece) => Array.from(piece)));
      const candidate = physics.prepareDerivedShapeCandidate(source).unwrap();
      for (const shape of source.shapes) for (const piece of shape.pieces) piece.fill(999);
      const preparedWrites = writes.mock.calls.length;
      expect(candidate.input.entity).toBe(7);
      expect(candidate.input.revision).toBe(1);
      expect(writes.mock.calls.length).toBe(preparedWrites);
      if (finish === 'publish') {
        physics.admitDerivedShapeCandidate(candidate).unwrap();
        physics.step(1 / 60);
      } else if (finish === 'cancel') physics.cancelDerivedShapeCandidate(candidate).unwrap();
      else physics.dispose();
      const beforeInspection = writes.mock.calls.length;
      const inspected = candidate.input.shapes;
      expect(writes.mock.calls.length).toBeGreaterThan(beforeInspection);
      const inspectedWrites = writes.mock.calls.length;
      expect(candidate.input.shapes).toBe(inspected);
      expect(writes.mock.calls.length).toBe(inspectedWrites);
      expect(
        inspected.map((shape) =>
          shape.kind === 'convex-compound' ? shape.pieces.map((piece) => Array.from(piece)) : [],
        ),
      ).toEqual(expected);
      for (const shape of inspected)
        if (shape.kind === 'convex-compound') for (const piece of shape.pieces) piece.fill(-999);
      if (finish === 'publish') {
        const saved = physics.captureDerivedPhysicsState().bodies[0];
        expect(
          saved?.shapes.map((shape) =>
            shape.kind === 'convex-compound' ? shape.pieces.map((piece) => Array.from(piece)) : [],
          ),
        ).toEqual(expected);
      }
    } finally {
      writes.mockRestore();
      physics.dispose();
    }
  });

  async function fixture() {
    const module = await loadRapier3D();
    if ('code' in module) throw module;
    const physics = createRapier3DPhysicsWorld(module);
    for (const entity of [1, 2, 3]) addBody(physics, entity, [entity * 10, 0, 0]);
    const initial = physics
      .prepareDerivedShapeCandidates([1, 2, 3].map((entity) => compoundCandidate(entity, 1)))
      .unwrap();
    physics.admitDerivedShapeCandidates(initial).unwrap();
    physics.step(1 / 60);
    return physics;
  }

  function dependency(
    bodyA: number,
    bodyB: number,
    revisionA: number,
    revisionB: number,
  ): PhysicsConstraintInput {
    return {
      id: `link:${bodyA}:${bodyB}`,
      revision: 1,
      kind: 'spring',
      bodyA,
      bodyB,
      bodyASource: { sourceKey: `body:${bodyA}`, revision: revisionA },
      bodyBSource: { sourceKey: `body:${bodyB}`, revision: revisionB },
      anchorA: [0, 0, 0],
      anchorB: [0, 0, 0],
      restLength: 10,
      stiffness: 10,
      damping: 1,
    };
  }

  it.each([
    false,
    true,
  ])('publishes dependencies on a later member in either batch order (%s)', async (reverse) => {
    const physics = await fixture();
    try {
      const inputs = [
        { ...compoundCandidate(1, 2), constraints: [dependency(1, 2, 2, 2)] },
        compoundCandidate(2, 2),
      ];
      if (reverse) inputs.reverse();
      const prepared = physics.prepareDerivedShapeCandidates(inputs).unwrap();
      const commit = vi.fn(() => ok(undefined));
      physics.admitDerivedShapeCandidates(prepared, commit).unwrap();
      expect(commit).not.toHaveBeenCalled();
      physics.step(1 / 60);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(physics.getDerivedPublication(1)?.revision).toBe(2);
      expect(physics.getDerivedPublication(2)?.revision).toBe(2);
      expect(physics.getDerivedConstraintStates()).toHaveLength(1);
    } finally {
      physics.dispose();
    }
  });

  it('rejects the entire incoming batch when removing an old queue group invalidates a later member', async () => {
    const physics = await fixture();
    try {
      const before = [1, 2, 3].map((entity) => physics.getDerivedPublication(entity));
      const nativeSize = physics.raw.colliders.len();
      const old = physics
        .prepareDerivedShapeCandidate({
          ...compoundCandidate(1, 2),
          constraints: [dependency(1, 3, 2, 1)],
        })
        .unwrap();
      physics.admitDerivedShapeCandidate(old).unwrap();
      const incoming = physics
        .prepareDerivedShapeCandidates([
          compoundCandidate(3, 2),
          { ...compoundCandidate(2, 2), constraints: [dependency(2, 1, 2, 2)] },
        ])
        .unwrap();
      const commit = vi.fn(() => ok(undefined));
      expect(physics.admitDerivedShapeCandidates(incoming, commit)).toMatchObject({
        ok: false,
        error: { code: 'derived-constraint-stale' },
      });
      physics.step(1 / 60);
      expect(commit).not.toHaveBeenCalled();
      expect([1, 2, 3].map((entity) => physics.getDerivedPublication(entity))).toEqual(before);
      expect(physics.raw.colliders.len()).toBe(nativeSize);
      expect(physics.getDerivedRecoveryState()).toBe('ready');
    } finally {
      physics.dispose();
    }
  });

  it('retains a newer queued revision when a complete batch submits an older member', async () => {
    const physics = await fixture();
    try {
      const incoming = physics
        .prepareDerivedShapeCandidates([compoundCandidate(1, 2), compoundCandidate(2, 2)])
        .unwrap();
      const newer = physics.prepareDerivedShapeCandidate(compoundCandidate(2, 3)).unwrap();
      physics.admitDerivedShapeCandidate(newer).unwrap();
      const commit = vi.fn(() => ok(undefined));
      expect(physics.admitDerivedShapeCandidates(incoming, commit)).toMatchObject({
        ok: false,
        error: { code: 'derived-candidate-stale' },
      });
      physics.step(1 / 60);
      expect(commit).not.toHaveBeenCalled();
      expect(physics.getDerivedPublication(1)?.revision).toBe(1);
      expect(physics.getDerivedPublication(2)?.revision).toBe(3);
    } finally {
      physics.dispose();
    }
  });

  it('refuses a batch invalidated while resolving a later caller credential', async () => {
    const physics = await fixture();
    try {
      const nativeSize = physics.raw.colliders.len();
      const prepared = physics
        .prepareDerivedShapeCandidates([compoundCandidate(1, 2), compoundCandidate(2, 2)])
        .unwrap();
      const callerTokens = prepared.map(
        (token, index): DerivedPhysicsCandidate => ({
          ...token,
          get owner() {
            if (index === 1) physics.invalidateDerivedShapeCandidates('caller invalidation');
            return token.owner;
          },
        }),
      );
      const commit = vi.fn(() => ok(undefined));
      expect(physics.admitDerivedShapeCandidates(callerTokens, commit).ok).toBe(false);
      physics.step(1 / 60);
      expect(commit).not.toHaveBeenCalled();
      expect(physics.getDerivedPublication(1)?.revision).toBe(1);
      expect(physics.getDerivedPublication(2)?.revision).toBe(1);
      expect(physics.raw.colliders.len()).toBe(nativeSize);
    } finally {
      physics.dispose();
    }
  });
});

/** Public-module fixture: inject a failure only after native mass mutation. */
function rapierWithMassFailure(RAPIER: Rapier3DModule): Rapier3DModule {
  const OriginalWorld = RAPIER.World;
  function FaultWorld(gravity: unknown) {
    const world = new OriginalWorld(gravity);
    const createRigidBody = world.createRigidBody.bind(world);
    world.createRigidBody = (descriptor: unknown) => {
      const body = createRigidBody(descriptor);
      const setAdditionalMassProperties = body.setAdditionalMassProperties.bind(body);
      let inject = true;
      body.setAdditionalMassProperties = (...args: unknown[]) => {
        setAdditionalMassProperties(...args);
        if (inject) {
          inject = false;
          throw new Error('injected failure after native mass mutation');
        }
      };
      return body;
    };
    return world;
  }
  return { ...RAPIER, World: FaultWorld };
}

function rapierWithCreationCounter(RAPIER: Rapier3DModule) {
  const counts = { rigidBodies: 0, colliders: 0 };
  const OriginalWorld = RAPIER.World;
  function CountingWorld(gravity: unknown) {
    const world = new OriginalWorld(gravity);
    const createRigidBody = world.createRigidBody.bind(world);
    world.createRigidBody = (descriptor: unknown) => {
      counts.rigidBodies += 1;
      return createRigidBody(descriptor);
    };
    const createCollider = world.createCollider.bind(world);
    world.createCollider = (descriptor: unknown, parent?: unknown) => {
      counts.colliders += 1;
      return createCollider(descriptor, parent);
    };
    return world;
  }
  return { module: { ...RAPIER, World: CountingWorld }, counts };
}

describe('Rapier 3D derived convex candidates', () => {
  it.each([
    false,
    true,
  ])('does not inspect unrelated derived publications during terrain retirement (resolved pose: %s)', async (resolvedPose) => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    const world = new World();
    world.components.register(Transform).unwrap();
    if (resolvedPose) world.components.register(GlobalTransform).unwrap();
    const releaseComponents = registerPhysicsComponents(world);
    const entities: number[] = [];
    try {
      for (let index = 0; index < 64; index++) {
        const entity = world
          .spawn(
            { component: Transform, data: { pos: [index * 5, 0, 0] } },
            { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
          )
          .unwrap();
        entities.push(entity);
        addBody(pw, entity, [index * 5, 0, 0]);
        const candidate = pw.prepareDerivedShapeCandidate(compoundCandidate(entity, 1)).unwrap();
        pw.admitDerivedShapeCandidate(candidate).unwrap();
        if (index % 16 === 15) pw.step(1 / 60);
      }
      pw.step(1 / 60);
      const publications = vi.spyOn(pw, 'getDerivedPublication');
      try {
        pw._syncFromEcs(world, Transform);
        expect(publications).not.toHaveBeenCalled();
      } finally {
        publications.mockRestore();
      }
      for (const entity of entities)
        expect(pw.getDerivedPublication(entity)?.shapeIds).toEqual(['left', 'right']);
    } finally {
      pw.dispose();
      releaseComponents();
    }
  });

  it('explicit derived sources retain their own lifecycle even when named terrain', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    const world = new World();
    world.components.register(Transform).unwrap();
    try {
      addBody(pw, 7, [0, 0, 0]);
      const input = compoundCandidate(7, 1);
      const shape = input.shapes[0];
      if (shape === undefined) throw new Error('missing fixture shape');
      const candidate = pw
        .prepareDerivedShapeCandidate({
          ...input,
          sourceKey: 'terrain:7',
          bodyType: 'static',
          shapes: [{ ...shape, id: 'terrain:7' }],
        })
        .unwrap();
      pw.admitDerivedShapeCandidate(candidate).unwrap();
      pw.step(1 / 60);
      expect(pw.getDerivedPublication(7)?.shapeIds).toEqual(['terrain:7']);
      pw._syncFromEcs(world, Transform);
      pw.step(1 / 60);
      expect(pw.getDerivedPublication(7)?.shapeIds).toEqual(['terrain:7']);
      const retirement = pw
        .prepareDerivedShapeCandidate({
          entity: 7,
          sourceKey: 'terrain:7',
          revision: 2,
          bodyType: 'static',
          shapes: [],
        })
        .unwrap();
      pw.admitDerivedShapeCandidate(retirement).unwrap();
      pw.step(1 / 60);
      expect(pw.getDerivedPublication(7)).toMatchObject({ revision: 2, shapeIds: [] });
    } finally {
      pw.dispose();
    }
  });

  it('retains immutable publication identity until a new fixed-step revision replaces it', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      pw.setGravity(vec3.create(0, 0, 0));
      addBody(pw, 7, [0, 0, 0]);
      expect(pw.getDerivedPublication(7)).toBeUndefined();
      const firstCandidate = pw.prepareDerivedShapeCandidate(compoundCandidate(7, 1)).unwrap();
      pw.admitDerivedShapeCandidate(firstCandidate).unwrap();
      pw.step(1 / 60);
      const first = pw.getDerivedPublication(7);
      if (first === undefined) throw new Error('missing first native publication');
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.shapeIds)).toBe(true);
      expect(Reflect.set(first, 'revision', 99)).toBe(false);
      expect(Reflect.set(first.shapeIds, 0, 'changed')).toBe(false);
      for (let frame = 0; frame < 60; frame += 1) {
        pw.step(1 / 60);
        expect(pw.getDerivedPublication(7)).toBe(first);
        expect(pw.getDerivedPublication(7)?.shapeIds).toBe(first.shapeIds);
      }
      const next = compoundCandidate(7, 2);
      const replacement = pw
        .prepareDerivedShapeCandidate({ ...next, shapes: next.shapes.slice(0, 1) })
        .unwrap();
      pw.admitDerivedShapeCandidate(replacement, () => {
        expect(() => pw.getDerivedPublication(7)).toThrow('derived-candidate-pending');
        return ok(undefined);
      }).unwrap();
      expect(pw.getDerivedPublication(7)).toBe(first);
      pw.step(1 / 60);
      const second = pw.getDerivedPublication(7);
      if (second === undefined) throw new Error('missing replacement native publication');
      expect(second).not.toBe(first);
      expect(second).toMatchObject({
        candidateId: replacement.candidateId,
        revision: 2,
        shapeIds: ['left'],
      });
      expect(second.fixedStep).toBeGreaterThan(first.fixedStep);
      expect(Object.isFrozen(second)).toBe(true);
      expect(Object.isFrozen(second.shapeIds)).toBe(true);
      expect(pw.getDerivedPublication(7)).toBe(second);
      expect(first).toMatchObject({
        candidateId: firstCandidate.candidateId,
        revision: 1,
        fixedStep: 1,
        shapeIds: ['left', 'right'],
      });
    } finally {
      pw.dispose();
    }
    expect(() => pw.getDerivedPublication(7)).toThrow('cannot run on a disposed instance');
  });

  it('does not expose a retained publication while native recovery is required', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      addBody(pw, 7, [0, 0, 0]);
      const firstCandidate = pw.prepareDerivedShapeCandidate(compoundCandidate(7, 1)).unwrap();
      pw.admitDerivedShapeCandidate(firstCandidate).unwrap();
      pw.step(1 / 60);
      const first = pw.getDerivedPublication(7);
      if (first === undefined) throw new Error('missing first native publication');
      pw.admitDerivedShapeCandidate(
        pw.prepareDerivedShapeCandidate(compoundCandidate(7, 2)).unwrap(),
        () => {
          throw new Error('uncertain geometry commit');
        },
      ).unwrap();
      pw.step(1 / 60);
      expect(pw.getDerivedRecoveryState()).toBe('rebuild-required');
      expect(pw.getDerivedPublication(7)).toBeUndefined();
      expect(first).toMatchObject({
        candidateId: firstCandidate.candidateId,
        revision: 1,
        shapeIds: ['left', 'right'],
      });
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.shapeIds)).toBe(true);
    } finally {
      pw.dispose();
    }
  });

  it('rejects nonfinite geometry before creating candidate resources', async () => {
    const source = await loadRapier3D();
    if ('code' in source) throw source;
    const instrumented = rapierWithCreationCounter(source);
    const pw = createRapier3DPhysicsWorld(instrumented.module);
    try {
      pw.setGravity(vec3.create(0, 0, 0));
      addBody(pw, 7, [0, 0, 0]);
      const before = { ...instrumented.counts };
      const result = pw.prepareDerivedShapeCandidate({
        entity: 7,
        revision: 1,
        sourceKey: 'body:7',
        shapes: [
          {
            kind: 'convex-compound',
            id: 'body:7',
            revision: 1,
            pieces: [boxPoints([Number.NaN, 0, 0], [1, 1, 1])],
          },
        ],
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'derived-shape-invalid',
          detail: { shapeId: 'body:7' },
        },
      });
      expect(instrumented.counts).toEqual(before);
    } finally {
      pw.dispose();
    }
  });

  it('validates compound input before requiring a native body', async () => {
    const source = await loadRapier3D();
    if ('code' in source) throw source;
    const instrumented = rapierWithCreationCounter(source);
    const pw = createRapier3DPhysicsWorld(instrumented.module);
    const world = new World();
    const foreignWorld = new World();
    world.components.register(Transform).unwrap();
    world.components.register(GlobalTransform).unwrap();
    const releaseComponents = registerPhysicsComponents(world);
    const entity = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: RigidBody, data: { type: 1, gravityScale: 0 } },
        { component: Collider, data: {} },
      )
      .unwrap();
    pw.setMoveContext(world, Transform);

    const compoundShape = {
      kind: 'convex-compound' as const,
      id: `compound:body:${entity}`,
      revision: 1,
      pieces: [boxPoints([0, 0, 0], [1, 1, 1])],
    };
    const input: DerivedPhysicsCandidateInput = {
      worldIdentity: world,
      entity,
      revision: 1,
      sourceKey: `body:${entity}`,
      shapes: [compoundShape],
      constraints: [],
    };
    const observe = () => ({
      capture: pw.captureDerivedPhysicsState(),
      shapes: pw.getDerivedShapes(entity),
      publication: pw.getDerivedPublication(entity),
      hasBody: pw.hasBody(entity),
      recovery: pw.getDerivedRecoveryState(),
    });

    try {
      const before = observe();
      const counts = { ...instrumented.counts };
      expect(before.hasBody).toBe(false);
      expect(pw.prepareDerivedShapeCandidate(input)).toMatchObject({
        ok: false,
        error: {
          code: 'derived-body-not-found',
          detail: { entity },
        },
      });
      expect(
        pw.prepareDerivedShapeCandidate({
          ...input,
          worldIdentity: foreignWorld,
          shapes: [{ ...compoundShape, pieces: [boxPoints([Number.NaN, 0, 0], [1, 1, 1])] }],
        }),
      ).toMatchObject({ ok: false, error: { code: 'derived-world-mismatch' } });
      expect(
        pw.prepareDerivedShapeCandidate({
          ...input,
          shapes: [{ ...compoundShape, pieces: [boxPoints([Number.NaN, 0, 0], [1, 1, 1])] }],
        }),
      ).toMatchObject({ ok: false, error: { code: 'derived-shape-invalid' } });
      expect(
        pw.prepareDerivedShapeCandidate({
          ...input,
          shapes: [{ ...compoundShape, unexpected: true } as unknown as typeof compoundShape],
        }),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'derived-candidate-invalid',
        },
      });
      expect(
        pw.prepareDerivedShapeCandidate({
          ...input,
          shapes: [
            {
              id: `uniform:body:${entity}`,
              revision: 1,
              kind: 'convex-compound',
              pieces: [boxPoints([0, 0, 0], [1, 1, 1])],
              origin: [0, 0, 0],
            },
          ],
        }),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'derived-body-not-found',
          expected: 'candidate entity has a committed body in this PhysicsWorld',
          hint: 'wait for physics reconciliation before preparing derived shapes',
          detail: { entity },
        },
      });
      expect(observe()).toEqual(before);
      expect(instrumented.counts).toEqual(counts);
    } finally {
      pw.clearEcsContext(world);
      pw.dispose();
      world.despawnAll().unwrap();
      releaseComponents();
      foreignWorld.despawnAll().unwrap();
    }
  });

  it('publishes 33 distinct bodies while retaining a 32-candidate staging bound', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      pw.setGravity(vec3.create(0, 0, 0));
      for (let entity = 1; entity <= 33; entity += 1) {
        addBody(pw, entity, [entity * 4, 0, 0]);
        const candidate = pw.prepareDerivedShapeCandidate(compoundCandidate(entity, 1)).unwrap();
        pw.admitDerivedShapeCandidate(candidate).unwrap();
        pw.step(1 / 60);
        expect(pw.getDerivedPublication(entity)?.candidateId).toBe(candidate.candidateId);
      }
      expect(pw.captureDerivedPhysicsState().bodies).toHaveLength(33);
      const pending = Array.from({ length: 32 }, (_, index) =>
        pw.prepareDerivedShapeCandidate(compoundCandidate(index + 1, 2)).unwrap(),
      );
      expect(pw.prepareDerivedShapeCandidate(compoundCandidate(33, 2))).toMatchObject({
        ok: false,
        error: { code: 'derived-candidate-budget-exceeded', detail: { reason: 'in-flight' } },
      });
      const first = pending[0];
      if (!first) throw new Error('expected a pending candidate');
      pw.cancelDerivedShapeCandidate(first).unwrap();
      const reopened = pw.prepareDerivedShapeCandidate(compoundCandidate(33, 2));
      expect(reopened.ok).toBe(true);
      if (reopened.ok) pw.cancelDerivedShapeCandidate(reopened.value).unwrap();
      for (const candidate of pending.slice(1)) pw.cancelDerivedShapeCandidate(candidate).unwrap();
    } finally {
      pw.dispose();
    }
  });
  it('applies a revision-bound world impulse at a point without teleporting the derived body', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      pw.setGravity(vec3.create(0, 0, 0));
      addBody(pw, 7, [0, 0, 0]);
      pw.admitDerivedShapeCandidate(
        pw.prepareDerivedShapeCandidate(compoundCandidate(7, 1)).unwrap(),
      ).unwrap();
      pw.step(1 / 60);
      const before = pw.getDerivedMotion(7);
      if (before === undefined) throw new Error('missing committed motion');
      const input = {
        entity: 7,
        sourceKey: 'body:7',
        revision: 1,
        impulse: [0, 2, 0] as const,
        point: [
          before.centerOfMass[0] + 1,
          before.centerOfMass[1],
          before.centerOfMass[2],
        ] as const,
      };
      pw.applyDerivedImpulse(input).unwrap();
      const after = pw.getDerivedMotion(7);
      if (after === undefined) throw new Error('missing impulse motion');
      expect(after.centerOfMass).toEqual(before.centerOfMass);
      expect(after.linearVelocity[1] - before.linearVelocity[1]).toBeCloseTo(1, 5);
      expect(after.angularVelocity[2] - before.angularVelocity[2]).toBeCloseTo(2, 5);
      expect(pw.applyDerivedImpulse({ ...input, revision: 0 }).ok).toBe(false);
      expect(pw.applyDerivedImpulse({ ...input, sourceKey: 'another-owner' }).ok).toBe(false);
      expect(pw.applyDerivedImpulse({ ...input, impulse: [0, Number.NaN, 0] }).ok).toBe(false);
      expect(pw.getDerivedMotion(7)).toEqual(after);
      const queued = pw.prepareDerivedShapeCandidate(compoundCandidate(7, 2)).unwrap();
      pw.admitDerivedShapeCandidate(queued).unwrap();
      expect(pw.applyDerivedImpulse(input).ok).toBe(false);
      pw.cancelDerivedShapeCandidate(queued).unwrap();
      expect(pw.applyDerivedImpulse(input).ok).toBe(true);
      const moving = pw.getDerivedMotion(7);
      if (moving === undefined) throw new Error('missing moving body');
      pw.step(1 / 120);
      const advanced = pw.getDerivedMotion(7);
      if (advanced === undefined) throw new Error('missing stepped motion');
      expect(advanced.centerOfMass[1] - moving.centerOfMass[1]).toBeCloseTo(
        moving.linearVelocity[1] / 120,
        5,
      );
    } finally {
      pw.dispose();
    }
  });

  it('requires recovery after a native impulse mutates and then throws', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const OriginalWorld = RAPIER.World;
    function FaultWorld(gravity: unknown) {
      const world = new OriginalWorld(gravity);
      const create = world.createRigidBody.bind(world);
      world.createRigidBody = (descriptor: unknown) => {
        const body = create(descriptor);
        const apply = body.applyImpulseAtPoint.bind(body);
        body.applyImpulseAtPoint = (...args: unknown[]) => {
          apply(...args);
          throw new Error('partial native impulse');
        };
        return body;
      };
      return world;
    }
    const pw = createRapier3DPhysicsWorld({ ...RAPIER, World: FaultWorld });
    try {
      addBody(pw, 7, [0, 0, 0]);
      pw.admitDerivedShapeCandidate(
        pw.prepareDerivedShapeCandidate(compoundCandidate(7, 1)).unwrap(),
      ).unwrap();
      pw.step(1 / 60);
      expect(
        pw.applyDerivedImpulse({
          entity: 7,
          sourceKey: 'body:7',
          revision: 1,
          impulse: [1, 0, 0],
          point: [0, 0, 0],
        }).ok,
      ).toBe(false);
      expect(pw.getDerivedRecoveryState()).toBe('rebuild-required');
      expect(pw.getDerivedMotion(7)).toBeUndefined();
      expect(() => pw.raycast(vec3.create(0, 0, 5), vec3.create(0, 0, -1), 10)).toThrow();
    } finally {
      pw.dispose();
    }
  });

  it('clears one derived shape set in the same group that replaces its successor', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      pw.setGravity(vec3.create(0, 0, 0));
      for (const entity of [7, 8]) {
        addBody(pw, entity, [(entity - 7) * 10, 0, 0]);
        pw.admitDerivedShapeCandidate(
          pw.prepareDerivedShapeCandidate(compoundCandidate(entity, 1)).unwrap(),
        ).unwrap();
      }
      pw.step(1 / 60);
      const ray = () => pw.raycast(vec3.create(-0.5, 0.5, 3), vec3.create(0, 0, -1), 5);
      expect(ray()?.entity).toBe(7);
      const removed = pw
        .prepareDerivedShapeCandidate({ entity: 7, revision: 2, sourceKey: 'body:7', shapes: [] })
        .unwrap();
      const successor = pw.prepareDerivedShapeCandidate(compoundCandidate(8, 2)).unwrap();
      pw.admitDerivedShapeCandidates([removed, successor]).unwrap();
      expect(ray()?.entity).toBe(7);
      pw.step(1 / 60);
      expect(ray()).toBeUndefined();
      expect(pw.getDerivedPublication(7)).toMatchObject({ revision: 2, shapeIds: [] });
      expect(pw.getDerivedPublication(8)?.revision).toBe(2);
      expect(pw.hasBody(7)).toBe(true); // ECS still owns body removal.
    } finally {
      pw.dispose();
    }
  });

  it.each([
    'cancel',
    'despawn',
  ] as const)('releases the whole queued group after one member %s', async (action) => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      for (const entity of [7, 8]) addBody(pw, entity, [(entity - 7) * 10, 0, 0]);
      const candidates = [7, 8].map((entity) =>
        pw.prepareDerivedShapeCandidate(compoundCandidate(entity, 1)).unwrap(),
      );
      pw.admitDerivedShapeCandidates(candidates).unwrap();
      const first = candidates[0];
      if (first === undefined) throw new Error('missing first fixture candidate');
      if (action === 'cancel') pw.cancelDerivedShapeCandidate(first).unwrap();
      else pw.removeEntity(7);
      pw.step(1 / 60);
      expect(pw.getDerivedPublication(8)).toBeUndefined();
      // A stranded member would retain the per-body pending lock here.
      const retry = pw.prepareDerivedShapeCandidate(compoundCandidate(8, 2)).unwrap();
      pw.admitDerivedShapeCandidate(retry).unwrap();
      pw.step(1 / 60);
      expect(pw.getDerivedPublication(8)?.revision).toBe(2);
    } finally {
      pw.dispose();
    }
  });

  it.each([
    'refuse',
    'throw',
  ] as const)('treats a batch geometry %s as a group-wide outcome', async (action) => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      for (const entity of [7, 8]) {
        addBody(pw, entity, [(entity - 7) * 10, 0, 0]);
        pw.admitDerivedShapeCandidate(
          pw.prepareDerivedShapeCandidate(compoundCandidate(entity, 1)).unwrap(),
        ).unwrap();
      }
      pw.step(1 / 60);
      const candidates = [7, 8].map((entity) =>
        pw.prepareDerivedShapeCandidate(compoundCandidate(entity, 2)).unwrap(),
      );
      pw.admitDerivedShapeCandidates(candidates, () => {
        if (action === 'throw') throw new Error('uncertain consumer write');
        return err(new Error('consumer refused without writes'));
      }).unwrap();
      pw.step(1 / 60);
      for (const entity of [7, 8]) {
        expect(pw.getDerivedFailure(entity)?.recovery).toBe(
          action === 'throw' ? 'rebuild-required' : 'old-state-retained',
        );
        expect(pw.getDerivedPublication(entity)?.revision).toBe(action === 'throw' ? undefined : 1);
      }
      expect(pw.getDerivedRecoveryState()).toBe(action === 'throw' ? 'rebuild-required' : 'ready');
    } finally {
      pw.dispose();
    }
  });

  it('publishes two derived bodies under one paired admission and fixed-step receipt', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      pw.setGravity(vec3.create(0, 0, 0));
      addBody(pw, 7, [0, 0, 0]);
      addBody(pw, 8, [10, 0, 0]);
      const candidates = [7, 8].map((entity) =>
        pw
          .prepareDerivedShapeCandidate({
            ...compoundCandidate(entity, 1),
            constraints: [
              {
                id: `coupled:${entity}`,
                revision: 1,
                kind: 'spring',
                bodyA: 7,
                bodyB: 8,
                bodyASource: { sourceKey: 'body:7', revision: 1 },
                bodyBSource: { sourceKey: 'body:8', revision: 1 },
                anchorA: [0, 0, 0],
                anchorB: [0, 0, 0],
                restLength: 10,
                stiffness: 2,
                damping: 1,
              },
            ],
          })
          .unwrap(),
      );
      let commits = 0;
      pw.admitDerivedShapeCandidates(candidates, () => {
        commits += 1;
        expect(pw.getDerivedAdmission(7)).toMatchObject({ entity: 7, revision: 1, fixedStep: 1 });
        expect(pw.getDerivedAdmission(8)).toMatchObject({ entity: 8, revision: 1, fixedStep: 1 });
        return ok(undefined);
      }).unwrap();
      expect(pw.getDerivedPublication(7)).toBeUndefined();
      expect(pw.getDerivedPublication(8)).toBeUndefined();
      pw.step(1 / 60);
      expect(commits).toBe(1);
      expect(pw.getDerivedPublication(7)).toMatchObject({ revision: 1, fixedStep: 1 });
      expect(pw.getDerivedPublication(8)).toMatchObject({ revision: 1, fixedStep: 1 });
      expect(pw.getDerivedAdmission(7)).toBeUndefined();
      const snapshot = pw.captureDerivedPhysicsState();
      const fresh = createRapier3DPhysicsWorld(RAPIER);
      try {
        fresh.setGravity(vec3.create(0, 0, 0));
        addBody(fresh, 7, [0, 0, 0]);
        addBody(fresh, 8, [10, 0, 0]);
        fresh.restoreDerivedPhysicsState(snapshot).unwrap();
        fresh.step(1 / 60);
        expect(fresh.getDerivedPublication(7)?.revision).toBe(1);
        expect(fresh.getDerivedPublication(8)?.revision).toBe(1);
        const restored = fresh
          .captureDerivedPhysicsState()
          .bodies.flatMap((body) => body.constraints);
        expect([...new Set(restored.map((joint) => joint.id))].sort()).toEqual([
          'coupled:7',
          'coupled:8',
        ]);
      } finally {
        fresh.dispose();
      }
    } finally {
      pw.dispose();
    }
  });

  it('rolls back the entire group when the second native mass mutation fails', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const OriginalWorld = RAPIER.World;
    let failSecond = false;
    function FaultWorld(gravity: unknown) {
      const world = new OriginalWorld(gravity);
      const create = world.createRigidBody.bind(world);
      world.createRigidBody = (descriptor: unknown) => {
        const body = create(descriptor);
        const setMass = body.setAdditionalMassProperties.bind(body);
        body.setAdditionalMassProperties = (...args: unknown[]) => {
          setMass(...args);
          if (failSecond && args[0] === 13) {
            failSecond = false;
            throw new Error('second body failed after mass mutation');
          }
        };
        return body;
      };
      return world;
    }
    const pw = createRapier3DPhysicsWorld({ ...RAPIER, World: FaultWorld });
    try {
      pw.setGravity(vec3.create(0, 0, 0));
      for (const entity of [7, 8]) {
        addBody(pw, entity, [(entity - 7) * 10, 0, 0]);
        pw.admitDerivedShapeCandidate(
          pw.prepareDerivedShapeCandidate(compoundCandidate(entity, 1)).unwrap(),
        ).unwrap();
      }
      pw.step(1 / 60);
      const before = [7, 8].map((entity) => ({
        publication: pw.getDerivedPublication(entity),
        motion: pw.getDerivedMotion(entity),
      }));
      const joint = {
        id: 'batch-shared-joint',
        revision: 1,
        kind: 'spring' as const,
        bodyA: 7,
        bodyB: 8,
        bodyASource: { sourceKey: 'body:7', revision: 1 },
        bodyBSource: { sourceKey: 'body:8', revision: 1 },
        anchorA: [0, 0, 0] as const,
        anchorB: [0, 0, 0] as const,
        restLength: 10,
        stiffness: 2,
        damping: 1,
      };
      pw.createDerivedConstraint(joint).unwrap();
      const oldRay = () => pw.raycast(vec3.create(-0.5, 0.5, 3), vec3.create(0, 0, -1), 5);
      const newRay = () => pw.raycast(vec3.create(4.5, 0.5, 3), vec3.create(0, 0, -1), 5);
      expect(oldRay()?.entity).toBe(7);
      expect(newRay()).toBeUndefined();
      const candidates = [7, 8].map((entity) => {
        const input = compoundCandidate(entity, 2);
        return pw
          .prepareDerivedShapeCandidate({
            ...input,
            shapes: [
              {
                kind: 'convex-compound',
                id: 'replacement',
                revision: 2,
                pieces: [boxPoints([4, 0, 0], [5, 1, 1])],
              },
            ],
            constraints:
              entity === 7
                ? [
                    {
                      ...joint,
                      revision: 2,
                      bodyASource: { sourceKey: 'body:7', revision: 2 },
                      bodyBSource: { sourceKey: 'body:8', revision: 2 },
                    },
                  ]
                : [],
            massProperties: { ...input.massProperties, mass: entity === 7 ? 5 : 13 },
          })
          .unwrap();
      });
      let commits = 0;
      failSecond = true;
      pw.admitDerivedShapeCandidates(candidates, () => {
        commits += 1;
        return ok(undefined);
      }).unwrap();
      pw.step(1 / 60);
      expect(commits).toBe(0);
      expect(oldRay()?.entity).toBe(7);
      expect(newRay()).toBeUndefined();
      expect(pw.captureDerivedPhysicsState().bodies.flatMap((body) => body.constraints)).toEqual([
        joint,
        joint,
      ]);
      for (let i = 0; i < 2; i++) {
        const entity = i + 7;
        expect(pw.getDerivedPublication(entity)).toEqual(before[i]?.publication);
        expect(pw.getDerivedMotion(entity)).toEqual(before[i]?.motion);
        expect(pw.getDerivedFailure(entity)).toMatchObject({
          candidateId: candidates[i]?.candidateId,
          recovery: 'old-state-retained',
        });
      }
      expect(pw.getDerivedRecoveryState()).toBe('ready');
    } finally {
      pw.dispose();
    }
  });

  it('restores a world COM using the newly admitted nonzero local mass center', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    try {
      pw.setGravity(vec3.create(0, 0, 0));
      addBody(pw, 7, [10, 20, 0], [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
      pw.admitDerivedShapeCandidate(
        pw
          .prepareDerivedShapeCandidate({
            ...compoundCandidate(7, 1),
            massProperties: {
              mode: 'explicit',
              mass: 6,
              centerOfMass: [1.5, 0, 0.5],
              principalInertia: [1, 1, 1],
            },
            motion: {
              centerOfMass: [10, 21.5, 0.5],
              linearVelocity: [0, 0, 0],
              angularVelocity: [0, 0, 0],
            },
          })
          .unwrap(),
      ).unwrap();
      pw.step(1 / 60);
      const motion = pw.getDerivedMotion(7);
      expect(motion?.centerOfMass[0]).toBeCloseTo(10, 5);
      expect(motion?.centerOfMass[1]).toBeCloseTo(21.5, 5);
      expect(motion?.centerOfMass[2]).toBeCloseTo(0.5, 5);
      expect(pw.getDerivedBodyMass(7)).toBeCloseTo(6, 5);
    } finally {
      pw.dispose();
    }
  });

  it('stops publication and queries if native step throws after the geometry commit', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 7, [0, 0, 0]);
    pw.admitDerivedShapeCandidate(
      pw.prepareDerivedShapeCandidate(compoundCandidate(7, 1)).unwrap(),
    ).unwrap();
    pw.step(1 / 60);
    let geometryRevision = 1;
    pw.admitDerivedShapeCandidate(
      pw.prepareDerivedShapeCandidate(compoundCandidate(7, 2)).unwrap(),
      () => {
        geometryRevision = 2;
        return ok(undefined);
      },
    ).unwrap();
    const nativeStep = pw.raw.step.bind(pw.raw);
    const failure = new Error('injected failure after native advancement');
    pw.raw.step = (...args: unknown[]) => {
      nativeStep(...args);
      throw failure;
    };
    expect(() => pw.step(1 / 60)).toThrow('derived-backend-failed');
    expect(geometryRevision).toBe(2);
    expect(pw.getDerivedRecoveryState()).toBe('rebuild-required');
    expect(pw.getDerivedFailure(7)?.recovery).toBe('rebuild-required');
    expect(pw.getDerivedFailure(7)?.error.cause).toBe(failure);
    expect(pw.getDerivedPublication(7)).toBeUndefined();
    expect(pw.getDerivedShapes(7)).toEqual([]);
    expect(() => pw.raycast(vec3.create(0, 0, 4), vec3.create(0, 0, -1), 10)).toThrow(
      'derived-recovery-invalid',
    );
    pw.raw.step = nativeStep;
    pw.dispose();
  });

  it('keeps staged and retired shapes out of automatic mass and restores a refused replacement', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 7, [0, 0, 0]);
    const automatic = (revision: number) => ({
      ...compoundCandidate(7, revision),
      massProperties: { mode: 'automatic' as const },
    });
    pw.admitDerivedShapeCandidate(pw.prepareDerivedShapeCandidate(automatic(1)).unwrap()).unwrap();
    pw.step(1 / 60);
    const mass = pw.getDerivedBodyMass(7);
    const pending = pw.prepareDerivedShapeCandidate(automatic(2)).unwrap();
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(mass ?? NaN, 6);
    pw.admitDerivedShapeCandidate(pending, () => err(new Error('binding refused'))).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedFailure(7)?.recovery).toBe('old-state-retained');
    expect(pw.getDerivedPublication(7)?.revision).toBe(1);
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(mass ?? NaN, 6);
    const otherPending = pw.prepareDerivedShapeCandidate(automatic(3)).unwrap();
    pw.admitDerivedShapeCandidate(pw.prepareDerivedShapeCandidate(automatic(4)).unwrap()).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(mass ?? NaN, 6);
    pw.cancelDerivedShapeCandidate(otherPending).unwrap();
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(mass ?? NaN, 6);
    pw.dispose();
  });

  it('requires rebuild if a geometry callback throws after an unknown ECS write', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 7, [0, 0, 0]);
    pw.admitDerivedShapeCandidate(
      pw.prepareDerivedShapeCandidate(compoundCandidate(7, 1)).unwrap(),
      () => {
        throw new Error('unknown failure after a possible geometry write');
      },
    ).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedFailure(7)?.recovery).toBe('rebuild-required');
    expect(pw.getDerivedRecoveryState()).toBe('rebuild-required');
    expect(pw.getDerivedPublication(7)).toBeUndefined();
    expect(() => pw.raycast(vec3.create(0, 0, 4), vec3.create(0, 0, -1), 10)).toThrow(
      'derived-recovery-invalid',
    );
    pw.dispose();
  });

  it('keeps the old physics publication when the paired geometry commit refuses', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 7, [0, 0, 0]);
    pw.admitDerivedShapeCandidate(
      pw.prepareDerivedShapeCandidate(compoundCandidate(7, 1)).unwrap(),
    ).unwrap();
    pw.step(1 / 60);
    let commits = 0;
    const replacement = pw
      .prepareDerivedShapeCandidate({
        ...compoundCandidate(7, 2),
        massProperties: {
          mode: 'explicit',
          mass: 9,
          centerOfMass: [0, 0, 0],
          principalInertia: [1, 1, 1],
        },
      })
      .unwrap();
    pw.admitDerivedShapeCandidate(replacement, () => {
      commits += 1;
      expect(() => pw.raycast(vec3.create(0, 0, 4), vec3.create(0, 0, -1), 10)).toThrow();
      return err(new Error('geometry admission refused'));
    }).unwrap();
    pw.step(1 / 60);
    expect(commits).toBe(1);
    expect(pw.getDerivedPublication(7)?.revision).toBe(1);
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(2);
    expect(pw.getDerivedFailure(7)?.recovery).toBe('old-state-retained');
    expect(pw.getDerivedRecoveryState()).toBe('ready');
    pw.admitDerivedShapeCandidate(
      pw.prepareDerivedShapeCandidate(compoundCandidate(7, 3)).unwrap(),
      () => {
        expect(pw.getDerivedAdmission(7)).toMatchObject({ revision: 3, fixedStep: 3 });
        return ok(undefined);
      },
    ).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedPublication(7)?.revision).toBe(3);
    expect(pw.getDerivedAdmission(7)).toBeUndefined();
    pw.dispose();
  });

  it('stages multiple native convex shapes and publishes them after one fixed step', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    pw.setGravity(vec3.create(0, 0, 0));
    addBody(pw, 7, [0, 0, 0]);
    const prepared = pw.prepareDerivedShapeCandidate(compoundCandidate(7, 1));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(pw.getDerivedShapes(7)).toHaveLength(0);
    const admitted = pw.admitDerivedShapeCandidate(prepared.value);
    expect(admitted.ok).toBe(true);
    expect(pw.getDerivedPublication(7)).toBeUndefined();

    pw.step(1 / 60);

    expect(pw.getDerivedPublication(7)).toMatchObject({
      entity: 7,
      revision: 1,
      fixedStep: 1,
      shapeIds: ['left', 'right'],
    });
    expect(pw.getDerivedShapes(7).map((entry) => entry.id)).toEqual(['left', 'right']);
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(2, 5);
  });

  it('retains a newly created colliderless body when its first paired admission is refused', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    pw.ensureBody(
      7,
      {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
      { type: 1, mass: 1, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
      undefined,
    );
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(1);
    const candidate = pw.prepareDerivedShapeCandidate(compoundCandidate(7, 1)).unwrap();
    pw.admitDerivedShapeCandidates([candidate], () =>
      err(new Error('reject new fragment')),
    ).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedRecoveryState()).toBe('ready');
    expect(pw.getDerivedFailure(7)?.recovery).toBe('old-state-retained');
    expect(pw.getDerivedBodyMass(7)).toBeCloseTo(1);
    expect(pw.getDerivedPublication(7)).toBeUndefined();
    expect(pw.raycast(vec3.create(0.5, 0.5, 3), vec3.create(0, 0, -1), 5)).toBeUndefined();
    pw.dispose();
  });

  it('carries a successor world orientation through admission, rollback and snapshot recovery', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 16, [0, 0, 0]);
    const rotation: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    const input = {
      ...compoundCandidate(16, 1),
      motion: {
        centerOfMass: [10, 0, 0] as const,
        linearVelocity: [0, 0, 0] as const,
        angularVelocity: [0, 0, 0] as const,
        rotation,
      },
    };
    const prepared = pw.prepareDerivedShapeCandidate(input).unwrap();
    rotation[1] = 0;
    rotation[3] = 1;
    pw.admitDerivedShapeCandidate(prepared).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedMotion(16)?.rotation?.[1]).toBeCloseTo(Math.SQRT1_2);
    expect(pw.raycast(vec3.create(10.5, 4, -2.25), vec3.create(0, -1, 0), 5)?.entity).toBe(16);
    const before = pw.getDerivedMotion(16);
    pw.admitDerivedShapeCandidate(
      pw
        .prepareDerivedShapeCandidate({
          ...compoundCandidate(16, 2),
          motion: { ...input.motion, rotation: [0, 0, 0, 1] },
        })
        .unwrap(),
      () => err(new Error('keep the prior orientation')),
    ).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedMotion(16)).toEqual(before);
    const snapshot = pw.captureDerivedPhysicsState();
    pw.removeEntity(16);
    addBody(pw, 16, [0, 0, 0]);
    pw.restoreDerivedPhysicsState(snapshot).unwrap();
    pw.step(1 / 60);
    expect(pw.getDerivedMotion(16)?.rotation?.[1]).toBeCloseTo(Math.SQRT1_2);
    expect(pw.raycast(vec3.create(10.5, 4, -2.25), vec3.create(0, -1, 0), 5)?.entity).toBe(16);
    expect(
      pw.prepareDerivedShapeCandidate({
        ...compoundCandidate(16, 2),
        motion: { ...input.motion, rotation: [0, 0, 0, 0] },
      }).ok,
    ).toBe(false);
    pw.dispose();
  });

  it('exposes committed COM and motion and restores that movement through a snapshot', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 16, [0, 0, 0]);
    const prepared = pw.prepareDerivedShapeCandidate({
      ...compoundCandidate(16, 1),
      massProperties: {
        mode: 'explicit' as const,
        mass: 2,
        centerOfMass: [0, 0, 0] as const,
        principalInertia: [1, 1, 1] as const,
      },
      motion: {
        centerOfMass: [0.5, 0.25, 0] as const,
        linearVelocity: [1, 2, 3] as const,
        angularVelocity: [0.1, 0.2, 0.3] as const,
      },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(pw.admitDerivedShapeCandidate(prepared.value).ok).toBe(true);
    pw.step(1 / 60);
    const motion = pw.getDerivedMotion(16);
    expect(motion?.centerOfMass[0]).toBeCloseTo(0.5 + 1 / 60, 4);
    expect(motion?.centerOfMass[1]).toBeCloseTo(0.25 + 2 / 60, 4);
    expect(motion?.centerOfMass[2]).toBeCloseTo(3 / 60, 4);
    expect(motion?.linearVelocity).toEqual([1, 2, 3]);
    expect(motion?.angularVelocity[0]).toBeCloseTo(0.1, 5);
    expect(motion?.angularVelocity[1]).toBeCloseTo(0.2, 5);
    expect(motion?.angularVelocity[2]).toBeCloseTo(0.3, 5);
    const snapshot = pw.captureDerivedPhysicsState();
    expect(snapshot.bodies[0]?.motion?.linearVelocity).toEqual([1, 2, 3]);
    expect(snapshot.bodies[0]?.motion?.angularVelocity[0]).toBeCloseTo(0.1, 5);
    pw.removeEntity(16);
    addBody(pw, 16, [0, 0, 0]);
    expect(pw.restoreDerivedPhysicsState(snapshot).ok).toBe(true);
    pw.step(1 / 60);
    const restoredMotion = pw.getDerivedMotion(16);
    const snapshotMotion = snapshot.bodies[0]?.motion;
    expect(snapshotMotion).toBeDefined();
    expect(restoredMotion?.centerOfMass[0]).toBeCloseTo(
      (snapshotMotion?.centerOfMass[0] ?? 0) + 1 / 60,
      4,
    );
    expect(restoredMotion?.centerOfMass[1]).toBeCloseTo(
      (snapshotMotion?.centerOfMass[1] ?? 0) + 2 / 60,
      4,
    );
    expect(restoredMotion?.centerOfMass[2]).toBeCloseTo(
      (snapshotMotion?.centerOfMass[2] ?? 0) + 3 / 60,
      4,
    );
    expect(restoredMotion?.linearVelocity).toEqual([1, 2, 3]);
    expect(restoredMotion?.angularVelocity[0]).toBeCloseTo(0.1, 5);
    pw.dispose();
  });

  it('keeps the committed shape set on cancellation and rejects stale revisions', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 8, [0, 0, 0]);
    const first = pw.prepareDerivedShapeCandidate(compoundCandidate(8, 1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(pw.admitDerivedShapeCandidate(first.value).ok).toBe(true);
    pw.step(1 / 60);
    const stale = pw.prepareDerivedShapeCandidate(compoundCandidate(8, 1));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('derived-candidate-stale');

    const next = pw.prepareDerivedShapeCandidate(compoundCandidate(8, 2));
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(pw.cancelDerivedShapeCandidate(next.value).ok).toBe(true);
    expect(pw.getDerivedPublication(8)?.revision).toBe(1);
    expect(pw.getDerivedShapes(8)).toHaveLength(2);
  });

  it('retains the committed native state when an endpoint disappears before admission', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 12, [0, 0, 0]);
    addBody(pw, 13, [0, 0, 0]);
    const first = pw.prepareDerivedShapeCandidate(compoundCandidate(12, 1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(pw.admitDerivedShapeCandidate(first.value).ok).toBe(true);
    pw.step(1 / 60);

    const next = pw.prepareDerivedShapeCandidate({
      ...compoundCandidate(12, 2),
      bodyType: 'static',
      constraints: [
        {
          id: 'disappearing-endpoint',
          revision: 1,
          kind: 'spring',
          bodyA: 12,
          bodyB: 13,
          bodyASource: { sourceKey: 'body:12', revision: 2 },
          bodyBSource: { sourceKey: 'entity:13', revision: 0 },
          anchorA: [0, 0, 0],
          anchorB: [0, 0, 0],
          restLength: 0,
          stiffness: 10,
          damping: 1,
        },
      ],
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(pw.admitDerivedShapeCandidate(next.value).ok).toBe(true);
    pw.removeEntity(13);
    pw.step(1 / 60);

    expect(pw.getDerivedBodyType(12)).toBe('dynamic');
    expect(pw.getDerivedPublication(12)?.revision).toBe(1);
    expect(pw.getDerivedShapes(12).map((shape) => shape.id)).toEqual(['left', 'right']);
    expect(pw.getDerivedFailure(12)).toMatchObject({
      candidateId: next.value.candidateId,
      recovery: 'old-state-retained',
      error: { code: 'derived-body-not-found' },
    });
  });

  it('rejects an invalid body type before native mutation and releases the candidate', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 14, [0, 0, 0]);
    const first = pw.prepareDerivedShapeCandidate(compoundCandidate(14, 1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(pw.admitDerivedShapeCandidate(first.value).ok).toBe(true);
    pw.step(1 / 60);

    const invalid = pw.prepareDerivedShapeCandidate({
      ...compoundCandidate(14, 2),
      bodyType: 'invalid',
    } as unknown as DerivedPhysicsCandidateInput);
    expect(invalid.ok).toBe(true);
    if (!invalid.ok) return;
    expect(pw.admitDerivedShapeCandidate(invalid.value)).toMatchObject({
      ok: false,
      error: { code: 'derived-candidate-invalid' },
    });
    expect(pw.cancelDerivedShapeCandidate(invalid.value)).toMatchObject({
      ok: false,
      error: { code: 'derived-candidate-not-found' },
    });
    expect(pw.getDerivedBodyType(14)).toBe('dynamic');
    expect(pw.getDerivedPublication(14)?.revision).toBe(1);
    expect(pw.getDerivedFailure(14)).toMatchObject({
      candidateId: invalid.value.candidateId,
      recovery: 'old-state-retained',
      error: { code: 'derived-candidate-invalid' },
    });
  });

  it('exposes stable constraint identity and real shape contact observations', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    pw.setGravity(vec3.create(0, 0, 0));
    addBody(pw, 9, [0, 0, 0]);
    addBody(pw, 10, [0, 0, 0]);
    const candidate = pw.prepareDerivedShapeCandidate(compoundCandidate(9, 1));
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    expect(pw.admitDerivedShapeCandidate(candidate.value).ok).toBe(true);
    pw.step(1 / 60);
    const constraint = pw.createDerivedConstraint({
      id: 'grab',
      revision: 1,
      kind: 'spring',
      bodyA: 9,
      bodyB: 10,
      bodyASource: { sourceKey: 'body:9', revision: 1 },
      bodyBSource: { sourceKey: 'entity:10', revision: 0 },
      anchorA: [0, 0, 0],
      anchorB: [0, 0, 0],
      restLength: 0,
      stiffness: 20,
      damping: 1,
    });
    expect(constraint.ok).toBe(true);
    pw.step(1 / 60);
    const observations = pw.getContactObservations();
    expect(
      observations.some(
        (observation) =>
          observation.fixedStep === 1 &&
          (observation.shapeA === 'left' || observation.shapeB === 'left'),
      ),
    ).toBe(true);
    expect(
      pw.updateDerivedConstraint?.({
        id: 'grab',
        revision: 2,
        kind: 'spring',
        bodyA: 9,
        bodyB: 10,
        bodyASource: { sourceKey: 'body:9', revision: 1 },
        bodyBSource: { sourceKey: 'entity:10', revision: 0 },
        anchorA: [0, 0, 0],
        anchorB: [0, 0, 0],
        restLength: 0.1,
        stiffness: 25,
        damping: 1,
      }).ok,
    ).toBe(true);
    const snapshot = pw.captureDerivedPhysicsState();
    expect(snapshot.bodies[0]?.constraints).toMatchObject([
      {
        id: 'grab',
        bodyASource: { sourceKey: 'body:9', revision: 1 },
        bodyBSource: { sourceKey: 'entity:10', revision: 0 },
      },
    ]);
    const bodyRevision = pw.prepareDerivedShapeCandidate(compoundCandidate(9, 2));
    expect(bodyRevision.ok).toBe(true);
    if (!bodyRevision.ok) return;
    expect(pw.admitDerivedShapeCandidate(bodyRevision.value).ok).toBe(true);
    pw.step(1 / 60);
    expect(pw.captureDerivedPhysicsState().bodies[0]?.constraints).toEqual([]);
    expect(pw.removeEntity(9)).toBeUndefined();
    addBody(pw, 9, [0, 0, 0]);
    expect(pw.restoreDerivedPhysicsState(snapshot).ok).toBe(true);
    pw.step(1 / 60);
    expect(pw.captureDerivedPhysicsState().bodies[0]?.constraints).toMatchObject([
      { id: 'grab', revision: 2 },
    ]);
  });

  it('restores committed input through a fresh native body without restoring handles', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 11, [0, 0, 0]);
    const candidate = pw.prepareDerivedShapeCandidate(compoundCandidate(11, 1));
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    expect(pw.admitDerivedShapeCandidate(candidate.value).ok).toBe(true);
    pw.step(1 / 60);
    const snapshot = pw.captureDerivedPhysicsState();
    pw.removeEntity(11);
    addBody(pw, 11, [0, 0, 0]);
    const restored = pw.restoreDerivedPhysicsState(snapshot);
    expect(restored.ok).toBe(true);
    expect(pw.getDerivedShapes(11)).toHaveLength(0);
    pw.step(1 / 60);
    expect(pw.getDerivedPublication(11)).toMatchObject({ revision: 1, fixedStep: 2 });
    expect(pw.getDerivedShapes(11).map((entry) => entry.id)).toEqual(['left', 'right']);
  });

  it('restores native mass policy after a public-entry failure injected after mutation', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(rapierWithMassFailure(RAPIER));
    addBody(pw, 15, [0, 0, 0]);
    const before = pw.getDerivedBodyMass(15);
    const prepared = pw.prepareDerivedShapeCandidate({
      ...compoundCandidate(15, 1),
      massProperties: {
        mode: 'explicit',
        mass: 10,
        centerOfMass: [0, 0, 0],
        principalInertia: [1, 1, 1],
      },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(pw.admitDerivedShapeCandidate(prepared.value).ok).toBe(true);
    pw.step(1 / 60);

    expect(pw.getDerivedBodyMass(15)).toBeCloseTo(before ?? Number.NaN, 6);
    expect(pw.getDerivedRecoveryState()).toBe('ready');
    expect(pw.getDerivedPublication(15)).toBeUndefined();
    expect(pw.getDerivedFailure(15)).toMatchObject({
      entity: 15,
      recovery: 'old-state-retained',
      error: { code: 'derived-backend-failed' },
    });
  });

  it('revalidates queued endpoint revisions at admission and fixed-step processing', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 20, [0, 0, 0]);
    addBody(pw, 21, [0, 0, 0]);
    for (const entity of [20, 21]) {
      const initial = pw.prepareDerivedShapeCandidate(compoundCandidate(entity, 1));
      expect(initial.ok).toBe(true);
      if (!initial.ok) return;
      expect(pw.admitDerivedShapeCandidate(initial.value).ok).toBe(true);
    }
    pw.step(1 / 60);

    const body21Revision2 = pw.prepareDerivedShapeCandidate(compoundCandidate(21, 2));
    expect(body21Revision2.ok).toBe(true);
    if (!body21Revision2.ok) return;
    expect(pw.admitDerivedShapeCandidate(body21Revision2.value).ok).toBe(true);
    const staleAtAdmission = pw.prepareDerivedShapeCandidate({
      ...compoundCandidate(20, 2),
      constraints: [
        {
          id: 'queued-stale',
          revision: 1,
          kind: 'spring',
          bodyA: 20,
          bodyB: 21,
          bodyASource: { sourceKey: 'body:20', revision: 2 },
          bodyBSource: { sourceKey: 'body:21', revision: 1 },
          anchorA: [0, 0, 0],
          anchorB: [0, 0, 0],
          restLength: 0,
          stiffness: 10,
          damping: 1,
        },
      ],
    });
    expect(staleAtAdmission.ok).toBe(true);
    if (!staleAtAdmission.ok) return;
    expect(pw.admitDerivedShapeCandidate(staleAtAdmission.value)).toMatchObject({
      ok: false,
      error: { code: 'derived-constraint-stale' },
    });
    pw.step(1 / 60);
    expect(pw.getDerivedPublication(21)).toMatchObject({ revision: 2 });
    expect(pw.getDerivedPublication(20)).toMatchObject({ revision: 1 });

    const queuedBeforeDependency = pw.prepareDerivedShapeCandidate({
      ...compoundCandidate(20, 3),
      constraints: [
        {
          id: 'process-stale',
          revision: 1,
          kind: 'spring',
          bodyA: 20,
          bodyB: 21,
          bodyASource: { sourceKey: 'body:20', revision: 3 },
          bodyBSource: { sourceKey: 'body:21', revision: 2 },
          anchorA: [0, 0, 0],
          anchorB: [0, 0, 0],
          restLength: 0,
          stiffness: 10,
          damping: 1,
        },
      ],
    });
    expect(queuedBeforeDependency.ok).toBe(true);
    if (!queuedBeforeDependency.ok) return;
    expect(pw.admitDerivedShapeCandidate(queuedBeforeDependency.value).ok).toBe(true);
    const body21Revision3 = pw.prepareDerivedShapeCandidate(compoundCandidate(21, 3));
    expect(body21Revision3.ok).toBe(true);
    if (!body21Revision3.ok) return;
    expect(pw.admitDerivedShapeCandidate(body21Revision3.value).ok).toBe(true);
    pw.step(1 / 60);
    expect(pw.getDerivedPublication(20)).toMatchObject({ revision: 1 });
    expect(pw.getDerivedPublication(21)).toMatchObject({ revision: 3 });
    expect(pw.getDerivedFailure(20)).toMatchObject({
      recovery: 'old-state-retained',
      error: { code: 'derived-constraint-stale' },
    });
  });

  it('keeps the newest prepared revision and rejects a descending admission', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 22, [0, 0, 0]);
    const revision4 = pw.prepareDerivedShapeCandidate(compoundCandidate(22, 4));
    const revision3 = pw.prepareDerivedShapeCandidate(compoundCandidate(22, 3));
    expect(revision4.ok).toBe(true);
    expect(revision3.ok).toBe(true);
    if (!revision4.ok || !revision3.ok) return;
    expect(pw.admitDerivedShapeCandidate(revision4.value).ok).toBe(true);
    expect(pw.admitDerivedShapeCandidate(revision3.value)).toMatchObject({
      ok: false,
      error: { code: 'derived-candidate-stale' },
    });
    pw.step(1 / 60);
    expect(pw.getDerivedPublication(22)).toMatchObject({ revision: 4 });
  });

  it('restores a two-body constraint into a fresh world as one dependency-consistent batch', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const source = createRapier3DPhysicsWorld(RAPIER);
    addBody(source, 30, [0, 0, 0]);
    addBody(source, 31, [0, 0, 0]);
    for (const entity of [30, 31]) {
      const prepared = source.prepareDerivedShapeCandidate(compoundCandidate(entity, 1));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(source.admitDerivedShapeCandidate(prepared.value).ok).toBe(true);
    }
    source.step(1 / 60);
    expect(
      source.createDerivedConstraint({
        id: 'fresh-restore-joint',
        revision: 1,
        kind: 'spring',
        bodyA: 30,
        bodyB: 31,
        bodyASource: { sourceKey: 'body:30', revision: 1 },
        bodyBSource: { sourceKey: 'body:31', revision: 1 },
        anchorA: [0, 0, 0],
        anchorB: [0, 0, 0],
        restLength: 0,
        stiffness: 10,
        damping: 1,
      }).ok,
    ).toBe(true);
    const snapshot = source.captureDerivedPhysicsState();

    const fresh = createRapier3DPhysicsWorld(RAPIER);
    addBody(fresh, 30, [0, 0, 0]);
    addBody(fresh, 31, [0, 0, 0]);
    const restored = fresh.restoreDerivedPhysicsState(snapshot);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value).toHaveLength(2);
    fresh.step(1 / 60);
    expect(fresh.getDerivedPublication(30)).toMatchObject({ revision: 1, fixedStep: 1 });
    expect(fresh.getDerivedPublication(31)).toMatchObject({ revision: 1, fixedStep: 1 });
    const restoredConstraints = fresh
      .captureDerivedPhysicsState()
      .bodies.flatMap((body) => body.constraints);
    expect(restoredConstraints).toHaveLength(2);
    expect(restoredConstraints[0]).toMatchObject({
      id: 'fresh-restore-joint',
      bodyASource: { sourceKey: 'body:30', revision: 1 },
      bodyBSource: { sourceKey: 'body:31', revision: 1 },
    });
    source.dispose();
    fresh.dispose();
  });

  it('clears explicit mass residue when switching to automatic density policy', async () => {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) {
      expect(RAPIER.code).toBe('wasm-load-failed');
      return;
    }
    const pw = createRapier3DPhysicsWorld(RAPIER);
    addBody(pw, 40, [0, 0, 0]);
    const explicit = pw.prepareDerivedShapeCandidate({
      ...compoundCandidate(40, 1),
      massProperties: {
        mode: 'explicit',
        mass: 10,
        centerOfMass: [0, 0, 0],
        principalInertia: [1, 1, 1],
      },
    });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(pw.admitDerivedShapeCandidate(explicit.value).ok).toBe(true);
    pw.step(1 / 60);
    const automatic = pw.prepareDerivedShapeCandidate({
      ...compoundCandidate(40, 2),
      massProperties: { mode: 'automatic' },
    });
    expect(automatic.ok).toBe(true);
    if (!automatic.ok) return;
    expect(pw.admitDerivedShapeCandidate(automatic.value).ok).toBe(true);
    pw.step(1 / 60);
    const switchedMass = pw.getDerivedBodyMass(40);

    const fresh = createRapier3DPhysicsWorld(RAPIER);
    addBody(fresh, 41, [0, 0, 0]);
    const freshAutomatic = fresh.prepareDerivedShapeCandidate({
      ...compoundCandidate(41, 1),
      massProperties: { mode: 'automatic' },
    });
    expect(freshAutomatic.ok).toBe(true);
    if (!freshAutomatic.ok) return;
    expect(fresh.admitDerivedShapeCandidate(freshAutomatic.value).ok).toBe(true);
    fresh.step(1 / 60);
    expect(switchedMass).toBeCloseTo(fresh.getDerivedBodyMass(41) ?? Number.NaN, 6);
    pw.dispose();
    fresh.dispose();
  });
});

describe('declared derived-physics preparation groups', () => {
  function member<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('expected fixture group member');
    return value;
  }
  async function fixture(count = 65) {
    const module = await loadRapier3D();
    if ('code' in module) throw module;
    const physics = createRapier3DPhysicsWorld(module);
    physics.setGravity(vec3.create());
    for (let entity = 1; entity <= count; entity++) addBody(physics, entity, [entity * 5, 0, 0]);
    const inputs = Array.from({ length: 33 }, (_, i) => compoundCandidate(i + 1, 1));
    return { physics, inputs };
  }

  it('prepares 33 disabled members and publishes the complete group with one geometry commit', async () => {
    const { physics, inputs } = await fixture();
    try {
      const ray = () => physics.raycast(vec3.create(4.25, 0.5, 3), vec3.create(0, 0, -1), 5);
      const prepared = physics.prepareDerivedShapeCandidates(inputs).unwrap();
      expect(prepared).toHaveLength(33);
      expect(ray()).toBeUndefined();
      for (const input of inputs)
        expect(physics.getDerivedPublication(input.entity)).toBeUndefined();
      let commits = 0;
      physics
        .admitDerivedShapeCandidates(prepared, () => {
          commits++;
          for (const input of inputs)
            expect(physics.getDerivedAdmission(input.entity)?.revision).toBe(1);
          return ok(undefined);
        })
        .unwrap();
      expect(ray()).toBeUndefined();
      physics.step(1 / 60);
      expect(commits).toBe(1);
      expect(ray()?.entity).toBe(1);
      for (const input of inputs)
        expect(physics.getDerivedPublication(input.entity)?.revision).toBe(1);
    } finally {
      physics.dispose();
    }
  });

  it('counts the complete group as one of 32 in-flight preparations', async () => {
    const { physics, inputs } = await fixture();
    try {
      const group = physics.prepareDerivedShapeCandidates(inputs).unwrap();
      const singles = Array.from({ length: 31 }, (_, i) =>
        physics.prepareDerivedShapeCandidate(compoundCandidate(i + 34, 1)).unwrap(),
      );
      expect(physics.prepareDerivedShapeCandidate(compoundCandidate(65, 1))).toMatchObject({
        ok: false,
        error: { code: 'derived-candidate-budget-exceeded' },
      });
      expect(physics.prepareDerivedShapeCandidates([compoundCandidate(65, 1)])).toMatchObject({
        ok: false,
        error: { code: 'derived-candidate-budget-exceeded' },
      });
      physics.cancelDerivedShapeCandidate(member(group[16])).unwrap();
      const replacement = physics.prepareDerivedShapeCandidate(compoundCandidate(65, 1)).unwrap();
      for (const input of inputs)
        expect(physics.getDerivedPublication(input.entity)).toBeUndefined();
      for (const single of [...singles, replacement])
        physics.cancelDerivedShapeCandidate(single).unwrap();
    } finally {
      physics.dispose();
    }
  });

  it.each([
    1, 8, 33, 128,
  ])('counts preparation credits once for a %i-member group at the last available slot', async (count) => {
    const { physics } = await fixture(31 + count);
    const candidates = (physics as unknown as { derivedCandidates: Map<string, unknown> })
      .derivedCandidates;
    const values = candidates.values.bind(candidates);
    let scans = 0;
    let visits = 0;
    let enumeration: ReturnType<typeof vi.spyOn> | undefined;
    try {
      for (let entity = 1; entity <= 31; entity++)
        physics.prepareDerivedShapeCandidate(compoundCandidate(entity, 1)).unwrap();
      enumeration = vi.spyOn(candidates, 'values').mockImplementation(function* (): Generator<
        unknown,
        undefined,
        unknown
      > {
        scans++;
        for (const record of values()) {
          visits++;
          yield record;
        }
      });
      const inputs = Array.from({ length: count }, (_, index) => compoundCandidate(index + 32, 1));
      const prepared = physics.prepareDerivedShapeCandidates(inputs).unwrap();
      enumeration.mockRestore();
      physics.admitDerivedShapeCandidates(prepared).unwrap();
      physics.step(1 / 60);
      for (const input of inputs)
        expect(physics.getDerivedPublication(input.entity)?.revision).toBe(1);
      expect({ scans, visits }).toEqual({ scans: 1, visits: 31 });
    } finally {
      enumeration?.mockRestore();
      physics.dispose();
    }
  });

  it('recounts preparation credits when the first retained group member was invalidated', async () => {
    const { physics } = await fixture(2);
    const candidates = (physics as unknown as { derivedCandidates: Map<string, unknown> })
      .derivedCandidates;
    const values = candidates.values.bind(candidates);
    let scans = 0;
    let invalidated = false;
    const enumeration = vi.spyOn(candidates, 'values').mockImplementation(function* (): Generator<
      unknown,
      undefined,
      unknown
    > {
      scans++;
      yield* values();
    });
    try {
      const colliders = physics.raw.colliders.len();
      const replacement = {
        ...compoundCandidate(2, 1),
        get sourceKey() {
          if (!invalidated) {
            invalidated = true;
            physics.invalidateDerivedShapeCandidates('input-invalidated');
          }
          return 'body:2';
        },
      };
      const prepared = physics
        .prepareDerivedShapeCandidates([compoundCandidate(1, 1), replacement])
        .unwrap();
      enumeration.mockRestore();
      expect(scans).toBe(2);
      expect(physics.admitDerivedShapeCandidates(prepared).ok).toBe(false);
      expect(physics.getDerivedPublication(1)).toBeUndefined();
      physics.cancelDerivedShapeCandidate(member(prepared[1])).unwrap();
      expect(physics.raw.colliders.len()).toBe(colliders);
      const retry = physics
        .prepareDerivedShapeCandidates([compoundCandidate(1, 1), compoundCandidate(2, 1)])
        .unwrap();
      physics.admitDerivedShapeCandidates(retry).unwrap();
      physics.step(1 / 60);
      expect(physics.getDerivedPublication(1)?.revision).toBe(1);
      expect(physics.getDerivedPublication(2)?.revision).toBe(1);
    } finally {
      enumeration.mockRestore();
      physics.dispose();
    }
  });

  it.each([
    'single',
    'subset',
    'mixed',
    'duplicate',
  ] as const)('refuses %s admission of a declared group without losing the complete preparation', async (kind) => {
    const { physics, inputs } = await fixture();
    try {
      const group = physics.prepareDerivedShapeCandidates(inputs).unwrap();
      const other = physics.prepareDerivedShapeCandidate(compoundCandidate(34, 1)).unwrap();
      const result =
        kind === 'single'
          ? physics.admitDerivedShapeCandidate(member(group[0]))
          : physics.admitDerivedShapeCandidates(
              kind === 'subset'
                ? group.slice(1)
                : kind === 'mixed'
                  ? [...group, other]
                  : [...group.slice(0, -1), member(group[0])],
            );
      expect(result).toMatchObject({ ok: false, error: { code: 'derived-candidate-invalid' } });
      physics.admitDerivedShapeCandidates(group).unwrap();
      physics.step(1 / 60);
      for (const input of inputs)
        expect(physics.getDerivedPublication(input.entity)?.revision).toBe(1);
      expect(physics.getDerivedPublication(34)).toBeUndefined();
      physics.cancelDerivedShapeCandidate(other).unwrap();
    } finally {
      physics.dispose();
    }
  });

  it.each([
    'missing-body',
    'duplicate-body',
    'invalid-shape',
  ] as const)('cleans all disabled members after a late %s preparation refusal', async (kind) => {
    const { physics, inputs } = await fixture();
    try {
      const count = physics.raw.colliders.len();
      const invalid =
        kind === 'missing-body'
          ? compoundCandidate(99, 1)
          : kind === 'duplicate-body'
            ? member(inputs[0])
            : {
                ...compoundCandidate(34, 1),
                shapes: [
                  {
                    id: 'bad',
                    revision: 1,
                    kind: 'convex-compound' as const,
                    pieces: [new Float32Array([NaN, 0, 0])],
                  },
                ],
              };
      expect(physics.prepareDerivedShapeCandidates([...inputs, invalid]).ok).toBe(false);
      expect(physics.raw.colliders.len()).toBe(count);
      const retry = physics.prepareDerivedShapeCandidates(inputs).unwrap();
      physics.cancelDerivedShapeCandidate(member(retry[0])).unwrap();
      expect(physics.raw.colliders.len()).toBe(count);
    } finally {
      physics.dispose();
    }
  });

  it('keeps the 8 MiB aggregate byte bound for declared preparation groups', async () => {
    const { physics, inputs } = await fixture();
    try {
      const count = physics.raw.colliders.len();
      const heavy = inputs.map((input) => ({
        ...input,
        bodyType: 'static' as const,
        shapes: [
          {
            kind: 'heightfield' as const,
            id: 'surface',
            revision: 1,
            rows: 256,
            columns: 256,
            heights: new Float32Array(257 * 257),
            scale: [1, 1, 1] as const,
            origin: [0, 0, 0] as const,
          },
        ],
      }));
      expect(physics.prepareDerivedShapeCandidates(heavy)).toMatchObject({
        ok: false,
        error: { code: 'derived-candidate-budget-exceeded', detail: { reason: 'in-flight' } },
      });
      expect(physics.raw.colliders.len()).toBe(count);
      const retry = physics.prepareDerivedShapeCandidates(inputs).unwrap();
      physics.cancelDerivedShapeCandidate(member(retry[0])).unwrap();
      expect(physics.raw.colliders.len()).toBe(count);
    } finally {
      physics.dispose();
    }
  });

  it('refuses a roster above 4096 before allocating any native geometry', async () => {
    const { physics, inputs } = await fixture();
    try {
      const count = physics.raw.colliders.len();
      expect(
        physics.prepareDerivedShapeCandidates(
          Array.from({ length: 4097 }, () => member(inputs[0])),
        ),
      ).toMatchObject({ ok: false, error: { code: 'derived-candidate-invalid' } });
      expect(physics.raw.colliders.len()).toBe(count);
    } finally {
      physics.dispose();
    }
  });

  it('unwinds prior disabled members when a later input attempts native reentry', async () => {
    const { physics, inputs } = await fixture();
    try {
      const count = physics.raw.colliders.len();
      const reentrant = {
        ...compoundCandidate(34, 1),
        get sourceKey() {
          physics.step(1 / 60);
          return 'body:34';
        },
      };
      expect(() => physics.prepareDerivedShapeCandidates([...inputs, reentrant])).toThrow(
        'cannot reenter',
      );
      expect(physics.raw.colliders.len()).toBe(count);
      const retry = physics.prepareDerivedShapeCandidates(inputs).unwrap();
      physics.cancelDerivedShapeCandidate(member(retry[0])).unwrap();
    } finally {
      physics.dispose();
    }
  });

  it('releases earlier disabled colliders after a native failure in member 33', async () => {
    const { physics, inputs } = await fixture();
    const create = physics.raw.createCollider.bind(physics.raw);
    try {
      const count = physics.raw.colliders.len();
      let creations = 0;
      physics.raw.createCollider = (...args: unknown[]) => {
        if (++creations === 65) throw new Error('late native preparation failure');
        return create(...args);
      };
      expect(physics.prepareDerivedShapeCandidates(inputs)).toMatchObject({
        ok: false,
        error: { code: 'derived-backend-failed' },
      });
      expect(physics.raw.colliders.len()).toBe(count);
      physics.raw.createCollider = create;
      const retry = physics.prepareDerivedShapeCandidates(inputs).unwrap();
      physics.cancelDerivedShapeCandidate(member(retry[0])).unwrap();
      expect(physics.raw.colliders.len()).toBe(count);
    } finally {
      physics.raw.createCollider = create;
      physics.dispose();
    }
  });

  it('rolls back the first 32 members after member 33 fails following native mass mutation', async () => {
    const { physics, inputs } = await fixture();
    try {
      for (const input of inputs) {
        physics
          .admitDerivedShapeCandidate(physics.prepareDerivedShapeCandidate(input).unwrap())
          .unwrap();
        physics.step(1 / 60);
      }
      const before = inputs.map((input) => physics.getDerivedPublication(input.entity));
      const count = physics.raw.colliders.len();
      physics.raw.bodies.forEach(
        (body: {
          userData?: number;
          setAdditionalMassProperties: (...args: unknown[]) => void;
        }) => {
          if (body.userData !== 33) return;
          const setMass = body.setAdditionalMassProperties.bind(body);
          let once = true;
          body.setAdditionalMassProperties = (...args) => {
            setMass(...args);
            if (once) {
              once = false;
              throw new Error('late native mass failure');
            }
          };
        },
      );
      const next = physics
        .prepareDerivedShapeCandidates(inputs.map((input) => ({ ...input, revision: 2 })))
        .unwrap();
      let geometryCalled = false;
      physics
        .admitDerivedShapeCandidates(next, () => {
          geometryCalled = true;
          return ok(undefined);
        })
        .unwrap();
      physics.step(1 / 60);
      expect(geometryCalled).toBe(false);
      expect(inputs.map((input) => physics.getDerivedPublication(input.entity))).toEqual(before);
      expect(physics.raw.colliders.len()).toBe(count);
      for (const input of inputs)
        expect(physics.getDerivedFailure(input.entity)?.recovery).toBe('old-state-retained');
    } finally {
      physics.dispose();
    }
  });

  it('rolls back all 33 native members when paired geometry refuses', async () => {
    const { physics, inputs } = await fixture();
    try {
      for (const input of inputs) {
        physics
          .admitDerivedShapeCandidate(physics.prepareDerivedShapeCandidate(input).unwrap())
          .unwrap();
        physics.step(1 / 60);
      }
      const before = inputs.map((input) => physics.getDerivedPublication(input.entity));
      const count = physics.raw.colliders.len();
      const next = physics
        .prepareDerivedShapeCandidates(
          inputs.map((input) => ({ ...input, revision: 2, shapes: [] })),
        )
        .unwrap();
      physics.admitDerivedShapeCandidates(next, () => err(new Error('geometry refused'))).unwrap();
      physics.step(1 / 60);
      expect(inputs.map((input) => physics.getDerivedPublication(input.entity))).toEqual(before);
      expect(physics.raw.colliders.len()).toBe(count);
      for (const input of inputs)
        expect(physics.getDerivedFailure(input.entity)?.recovery).toBe('old-state-retained');
    } finally {
      physics.dispose();
    }
  });
});

describe('type-only derived body preparations', () => {
  function first<T>(values: readonly T[]): T {
    const value = values[0];
    if (value === undefined) throw Error('missing fixture value');
    return value;
  }
  async function fixture(count = 2) {
    const RAPIER = await loadRapier3D();
    if ('code' in RAPIER) throw RAPIER;
    const counted = rapierWithCreationCounter(RAPIER);
    const pw = createRapier3DPhysicsWorld(counted.module as Rapier3DModule);
    const entities = Array.from({ length: count }, (_, index) => index + 1);
    for (const entity of entities) {
      addBody(pw, entity, [entity * 10, 0, 0]);
      const candidate = pw.prepareDerivedShapeCandidate(compoundCandidate(entity, 1)).unwrap();
      pw.admitDerivedShapeCandidate(candidate).unwrap();
    }
    pw.step(1 / 60);
    const inputs = (bodyType: RigidBodyType) =>
      entities.map((entity) => {
        const publication = pw.getDerivedPublication(entity);
        if (!publication) throw Error('missing accepted body');
        return { publication, bodyType };
      });
    return { RAPIER, pw, counted, entities, inputs };
  }

  it('keeps entities, exact geometry revisions and native handles through atomic type changes', async () => {
    const { pw, counted, entities, inputs } = await fixture();
    try {
      const before = counted.counts.colliders;
      const shapes = entities.map((entity) => pw.getDerivedShapes(entity));
      const prepared = pw.prepareDerivedBodyTypeCandidates(inputs('static')).unwrap();
      expect(counted.counts.colliders).toBe(before);
      expect(entities.map((entity) => pw.getDerivedBodyType(entity))).toEqual([
        'dynamic',
        'dynamic',
      ]);
      let commits = 0;
      pw.admitDerivedShapeCandidates(prepared, () => {
        commits++;
        for (const entity of entities) expect(pw.getDerivedAdmission(entity)?.revision).toBe(1);
        expect(() => pw.getDerivedBodyType(entities[0] as number)).toThrow();
        return ok(undefined);
      }).unwrap();
      expect(commits).toBe(0);
      pw.step(1 / 60);
      expect(commits).toBe(1);
      expect(entities.map((entity) => pw.getDerivedBodyType(entity))).toEqual(['static', 'static']);
      expect(entities.map((entity) => pw.getDerivedShapes(entity))).toEqual(shapes);
      expect(entities.map((entity) => pw.getDerivedPublication(entity)?.revision)).toEqual([1, 1]);
      expect(counted.counts.colliders).toBe(before);
      const entity = first(entities);
      const hit = pw.raycast(vec3.create(entity * 10 - 0.5, 0.5, 3), vec3.create(0, 0, -1), 5);
      expect(hit?.entity).toBe(entity);
      const wake = pw.prepareDerivedBodyTypeCandidates(inputs('dynamic')).unwrap();
      pw.admitDerivedShapeCandidates(wake).unwrap();
      pw.step(1 / 60);
      expect(entities.map((entity) => pw.getDerivedBodyType(entity))).toEqual([
        'dynamic',
        'dynamic',
      ]);
      expect(pw.getDerivedBodyMass(entity)).toBeCloseTo(2);
      expect(counted.counts.colliders).toBe(before);
      pw.raw.bodies.forEach((body: { userData: number; sleep: () => void }) => {
        if (body.userData === entity) body.sleep();
      });
      const motion = pw.getDerivedMotion(entity);
      if (motion === undefined) throw Error('missing retained motion');
      pw.applyDerivedImpulse({
        entity,
        sourceKey: `body:${entity}`,
        revision: 1,
        impulse: [2, 0, 0],
        point: motion.centerOfMass,
      }).unwrap();
      expect(pw.getDerivedMotion(entity)?.linearVelocity[0]).toBeCloseTo(1);
      pw.step(1 / 60);
      expect(pw.getDerivedMotion(entity)?.centerOfMass[0]).toBeGreaterThan(motion.centerOfMass[0]);
    } finally {
      pw.dispose();
    }
  });

  it('cancels the complete type-only group without deleting accepted colliders', async () => {
    const { pw, counted, entities, inputs } = await fixture();
    try {
      const before = counted.counts.colliders;
      const publication = pw.getDerivedPublication(entities[0] as number);
      const nativeSize = pw.raw.colliders.len();
      const prepared = pw.prepareDerivedBodyTypeCandidates(inputs('static')).unwrap();
      pw.cancelDerivedShapeCandidate(first(prepared)).unwrap();
      expect(pw.raw.colliders.len()).toBe(nativeSize);
      expect(pw.getDerivedPublication(entities[0] as number)).toBe(publication);
      expect(pw.getDerivedBodyType(entities[0] as number)).toBe('dynamic');
      expect(counted.counts.colliders).toBe(before);
    } finally {
      pw.dispose();
    }
  });

  it('requires exact owned receipts and rejects copies, foreign worlds and partial rosters', async () => {
    const own = await fixture(),
      foreign = await fixture();
    try {
      const inputs = own.inputs('static');
      expect(
        own.pw.prepareDerivedBodyTypeCandidates([
          { ...first(inputs), publication: { ...first(inputs).publication } },
        ]).ok,
      ).toBe(false);
      expect(own.pw.prepareDerivedBodyTypeCandidates(foreign.inputs('static')).ok).toBe(false);
      expect(own.pw.prepareDerivedBodyTypeCandidates([first(inputs), first(inputs)]).ok).toBe(
        false,
      );
      const prepared = own.pw.prepareDerivedBodyTypeCandidates(inputs).unwrap();
      expect(own.pw.admitDerivedShapeCandidates([first(prepared)]).ok).toBe(false);
      own.pw.cancelDerivedShapeCandidate(first(prepared)).unwrap();
    } finally {
      own.pw.dispose();
      foreign.pw.dispose();
    }
  });

  it('rolls type, mass and all accepted colliders back when the paired callback refuses', async () => {
    const { pw, entities, inputs } = await fixture();
    try {
      const old = entities.map((entity) => pw.getDerivedPublication(entity));
      const size = pw.raw.colliders.len();
      const prepared = pw.prepareDerivedBodyTypeCandidates(inputs('static')).unwrap();
      pw.admitDerivedShapeCandidates(prepared, () => err(new Error('policy refused'))).unwrap();
      pw.step(1 / 60);
      expect(entities.map((entity) => pw.getDerivedBodyType(entity))).toEqual([
        'dynamic',
        'dynamic',
      ]);
      expect(entities.map((entity) => pw.getDerivedPublication(entity))).toEqual(old);
      expect(pw.getDerivedRecoveryState()).toBe('ready');
      expect(pw.raw.colliders.len()).toBe(size);
      expect(pw.getDerivedBodyMass(entities[0] as number)).toBeCloseTo(2);
      expect(pw.getDerivedFailure(entities[0] as number)?.recovery).toBe('old-state-retained');
    } finally {
      pw.dispose();
    }
  });

  it('rejects replaced geometry while retaining the newer publication and native colliders', async () => {
    const { pw, entities, inputs } = await fixture(1);
    try {
      const entity = first(entities);
      const prepared = pw.prepareDerivedBodyTypeCandidates(inputs('static')).unwrap();
      const replacement = pw.prepareDerivedShapeCandidate(compoundCandidate(entity, 2)).unwrap();
      pw.admitDerivedShapeCandidate(replacement).unwrap();
      pw.step(1 / 60);
      const current = pw.getDerivedPublication(entity);
      const size = pw.raw.colliders.len();
      expect(pw.admitDerivedShapeCandidates(prepared).ok).toBe(false);
      expect(pw.getDerivedPublication(entity)).toBe(current);
      expect(pw.raw.colliders.len()).toBe(size);
      expect(pw.getDerivedBodyType(entity)).toBe('dynamic');
    } finally {
      pw.dispose();
    }
  });

  it('isolates public token mutation and refuses missing native shapes before the callback', async () => {
    const { pw, entities, inputs } = await fixture(1);
    try {
      const prepared = pw.prepareDerivedBodyTypeCandidates(inputs('static')).unwrap();
      const input = first(prepared).input;
      const shape = first(input.shapes);
      if (shape.kind !== 'convex-compound') throw Error('unexpected shape');
      first(shape.pieces)[0] = NaN;
      pw.admitDerivedShapeCandidates(prepared).unwrap();
      pw.step(1 / 60);
      expect(pw.getDerivedBodyType(first(entities))).toBe('static');
      const stale = pw.prepareDerivedBodyTypeCandidates(inputs('dynamic')).unwrap();
      let handle: number | undefined;
      pw.raw.colliders.forEach(
        (collider: {
          handle: number;
          parent: () => { userData: number } | null;
          translation: () => { x: number };
        }) => {
          if (
            collider.parent()?.userData === first(entities) &&
            collider.translation().x > first(entities) * 10 + 1
          )
            handle = collider.handle;
        },
      );
      if (handle === undefined) throw Error('missing derived collider');
      pw.raw.removeCollider(pw.raw.getCollider(handle), false);
      let commits = 0;
      pw.admitDerivedShapeCandidates(stale, () => {
        commits++;
        return ok(undefined);
      }).unwrap();
      pw.step(1 / 60);
      expect(commits).toBe(0);
      expect(pw.getDerivedBodyType(first(entities))).toBe('static');
    } finally {
      pw.dispose();
    }
  });

  it('bounds input iteration and releases a group invalidated by a caller getter', async () => {
    const { pw, entities, inputs } = await fixture();
    try {
      const source = inputs('static');
      const poisoned = [...source];
      Object.defineProperty(poisoned, 1, {
        get() {
          pw.invalidateDerivedShapeCandidates('caller invalidation');
          return source[1];
        },
      });
      expect(pw.prepareDerivedBodyTypeCandidates(poisoned).ok).toBe(false);
      expect(entities.map((entity) => pw.getDerivedBodyType(entity))).toEqual([
        'dynamic',
        'dynamic',
      ]);
      const bounded = [...source];
      Object.defineProperty(bounded, Symbol.iterator, {
        value() {
          throw Error('custom iterator must not run');
        },
      });
      const prepared = pw.prepareDerivedBodyTypeCandidates(bounded).unwrap();
      pw.cancelDerivedShapeCandidate(first(prepared)).unwrap();
    } finally {
      pw.dispose();
    }
  });

  it.each([
    false,
    true,
  ])('refuses cancellation after native commit before publication (policy=%s)', async (policy) => {
    const { pw, inputs } = await fixture(1);
    try {
      const prepared = policy
        ? pw.prepareDerivedBodyTypeCandidates(inputs('static')).unwrap()
        : pw.prepareDerivedShapeCandidates([compoundCandidate(1, 2)]).unwrap();
      const finalizer = vi.spyOn(pw, 'finalizeDerivedFixedStep').mockImplementation(() => {});
      try {
        pw.admitDerivedShapeCandidates(prepared).unwrap();
        pw.step(1 / 60);
        const size = pw.raw.colliders.len();
        expect(pw.cancelDerivedShapeCandidate(first(prepared)).ok).toBe(false);
        expect(pw.raw.colliders.len()).toBe(size);
      } finally {
        finalizer.mockRestore();
      }
      pw.finalizeDerivedFixedStep();
      expect(pw.getDerivedPublication(1)?.candidateId).toBe(first(prepared).candidateId);
    } finally {
      pw.dispose();
    }
  });

  it('preserves the existing uncertain-callback recovery boundary for type-only updates', async () => {
    const { pw, inputs } = await fixture(1);
    try {
      const size = pw.raw.colliders.len();
      const prepared = pw.prepareDerivedBodyTypeCandidates(inputs('static')).unwrap();
      pw.admitDerivedShapeCandidates(prepared, () => {
        throw Error('uncertain policy writes');
      }).unwrap();
      pw.step(1 / 60);
      expect(pw.getDerivedRecoveryState()).toBe('rebuild-required');
      expect(pw.getDerivedFailure(1)?.recovery).toBe('rebuild-required');
      expect(pw.raw.colliders.len()).toBe(size);
    } finally {
      pw.dispose();
    }
  });
});
