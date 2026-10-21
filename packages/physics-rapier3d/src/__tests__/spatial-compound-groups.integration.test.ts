import { vec3 } from '@forgeax/engine-math';
import type { DerivedPhysicsCandidateInput } from '@forgeax/engine-physics';
import { normalizeConvexCompoundShapeInput } from '@forgeax/engine-physics';
import { err } from '@forgeax/engine-types';
import { assert, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { GroupedContactEvents } from '../grouped-contact-events.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { spatialCompoundGroups } from '../spatial-compound-groups.js';
import { loadRapier3D } from '../wasm-loader.js';

function input(revision = 1, grouped = true, count = 67): DerivedPhysicsCandidateInput {
  return {
    entity: 2,
    revision,
    sourceKey: 'debris:2',
    bodyType: 'dynamic',
    massProperties: {
      mode: 'explicit',
      mass: 43,
      centerOfMass: [0, 0, 0],
      principalInertia: [8, 9, 10],
    },
    shapes: [
      {
        kind: 'convex-compound',
        id: 'original',
        revision,
        ...(grouped ? { nativeLayout: 'spatial-groups-16' as const } : {}),
        pieces: Array.from({ length: count }, (_, i) =>
          boxPoints([i * 2, 0, 0], [i * 2 + 1, 1, 1]),
        ),
        friction: 0.7,
        restitution: 0.2,
        collisionGroups: 0x00010001,
        solverGroups: 0x00010001,
      },
    ],
  };
}
async function fixture() {
  const R = await loadRapier3D();
  if ('code' in R) throw R;
  const physics = createRapier3DPhysicsWorld(R);
  physics.setGravity(vec3.create());
  const body = physics.raw.createRigidBody(R.RigidBodyDesc.dynamic().setCcdEnabled(true));
  body.userData = 2;
  physics.registerBody(2, body.handle);
  const publish = (value: DerivedPhysicsCandidateInput) => {
    const token = physics.prepareDerivedShapeCandidate(value).unwrap();
    physics.admitDerivedShapeCandidate(token).unwrap();
    physics.step(1 / 60);
    return token;
  };
  return { R, physics, body, publish };
}
function handles(body: {
  numColliders(): number;
  collider(i: number): { handle: number };
}): number[] {
  return Array.from({ length: body.numColliders() }, (_, i) => body.collider(i).handle).sort(
    (a, b) => a - b,
  );
}

it('partitions exact point-set references once, with bounded fallback and no hull approximation', () => {
  const pieces = (required(input().shapes[0]) as { pieces: readonly Float32Array[] }).pieces;
  const groups = required(spatialCompoundGroups(pieces));
  assert.strictEqual(groups.length, 7);
  assert(groups.every((group) => group.length <= 16));
  assert.strictEqual(new Set(groups.flat()).size, 67);
  for (const piece of pieces)
    assert.strictEqual(groups.flat().filter((value) => value === piece).length, 1);
  assert.strictEqual(spatialCompoundGroups(pieces.slice(0, 16)), undefined);
  assert.strictEqual(
    spatialCompoundGroups(Array.from({ length: 129 }, () => required(pieces[0]))),
    undefined,
  );
  const extreme = boxPoints([3e38, 0, 0], [3.1e38, 1, 1]);
  assert.strictEqual(spatialCompoundGroups(Array.from({ length: 17 }, () => extreme)), undefined);
  assert.strictEqual(
    normalizeConvexCompoundShapeInput({
      ...required(input().shapes[0]),
      nativeLayout: 'unknown',
    } as never).ok,
    false,
  );
});

it('keeps the default collider and explicit one-body mass/CCD/filter/shape publication identity', async () => {
  const { physics, body, publish } = await fixture();
  try {
    publish(input(1, false));
    const old = handles(body);
    assert.strictEqual(old.length, 1);
    const before = { mass: body.mass(), com: body.localCom(), inertia: body.principalInertia() };
    publish(input(2, true));
    assert.strictEqual(body.numColliders(), 7);
    assert.strictEqual(body.isCcdEnabled(), true);
    assert.deepEqual(
      { mass: body.mass(), com: body.localCom(), inertia: body.principalInertia() },
      before,
    );
    assert.deepEqual(physics.getDerivedPublication(2)?.shapeIds, ['original']);
    for (let i = 0; i < body.numColliders(); i++) {
      const collider = body.collider(i);
      assert.strictEqual(collider.density(), 0);
      assert.strictEqual(collider.collisionGroups(), 0x00010001);
      assert.strictEqual(collider.solverGroups(), 0x00010001);
      assert.strictEqual(collider.friction(), Math.fround(0.7));
      assert.strictEqual(collider.restitution(), Math.fround(0.2));
    }
    assert.strictEqual(physics.raw.getCollider(required(old[0])), null);
    for (const x of [0.5, 40.5, 132.5])
      assert.strictEqual(
        physics.raycast(vec3.create(x, 0.5, -2), vec3.create(0, 0, 1), 5)?.entity,
        2,
      );
    publish(input(3, false));
    assert.strictEqual(body.numColliders(), 1);
    physics.removeEntity(2);
    assert.strictEqual(physics.raw.colliders.len(), 0);
  } finally {
    physics.dispose();
  }
});

it('cancels a complete staged group and rolls back admission without changing the committed owner', async () => {
  const { physics, body, publish } = await fixture();
  try {
    publish(input(1, false));
    const before = handles(body);
    const mass = body.mass();
    const pending = physics.prepareDerivedShapeCandidate(input(2)).unwrap();
    assert.strictEqual(body.numColliders(), 8);
    assert.strictEqual(body.mass(), mass);
    physics.cancelDerivedShapeCandidate(pending).unwrap();
    assert.deepEqual(handles(body), before);
    const rejected = physics.prepareDerivedShapeCandidate(input(2)).unwrap();
    physics
      .admitDerivedShapeCandidate(rejected, () => err(new Error('injected render commit failure')))
      .unwrap();
    physics.step(1 / 60);
    assert.deepEqual(handles(body), before);
    assert.strictEqual(body.mass(), mass);
    assert.strictEqual(physics.getDerivedPublication(2)?.revision, 1);
  } finally {
    physics.dispose();
  }
});

it('removes every partially created group on a native allocation failure', async () => {
  const { physics, body, publish } = await fixture();
  try {
    publish(input(1, false));
    const before = handles(body);
    const create = physics.raw.createCollider.bind(physics.raw);
    let count = 0;
    physics.raw.createCollider = (...args: Parameters<typeof create>) => {
      if (++count === 3) throw new Error('injected third group failure');
      return create(...args);
    };
    assert.strictEqual(physics.prepareDerivedShapeCandidate(input(2)).ok, false);
    physics.raw.createCollider = create;
    assert.deepEqual(handles(body), before);
    publish(input(2));
    assert.strictEqual(body.numColliders(), 7);
  } finally {
    physics.dispose();
  }
});

it('retains every group on equal-input and type-only revisions, and replaces changed material or geometry', async () => {
  const { physics, body, publish } = await fixture();
  try {
    publish(input());
    const original = handles(body);
    publish(input(2));
    assert.deepEqual(handles(body), original);
    const publication = required(physics.getDerivedPublication(2));
    const tokens = physics
      .prepareDerivedBodyTypeCandidates([{ publication, bodyType: 'static' }])
      .unwrap();
    physics.admitDerivedShapeCandidates(tokens).unwrap();
    physics.step(1 / 60);
    assert.deepEqual(handles(body), original);
    assert.strictEqual(body.isFixed(), true);
    const changed = input(3);
    const shape = required(changed.shapes[0]);
    publish({ ...changed, shapes: [{ ...shape, friction: 0.1 }] });
    assert.strictEqual(body.numColliders(), 7);
    assert.notDeepEqual(handles(body), original);
    const active = handles(body);
    const deleted = body.collider(3).handle;
    physics.raw.removeCollider(body.collider(3), false);
    assert.strictEqual(physics.raw.colliders.contains(deleted), false);
    const newToken = physics.prepareDerivedShapeCandidate(input(4)).unwrap();
    assert.strictEqual(
      body.numColliders(),
      13,
      JSON.stringify({
        deleted,
        contains: physics.raw.colliders.contains(deleted),
        handles: handles(body),
      }),
    );
    physics.admitDerivedShapeCandidate(newToken).unwrap();
    physics.step(1 / 60);
    assert.strictEqual(
      body.numColliders(),
      7,
      JSON.stringify({
        failure: physics.getDerivedFailure(2),
        handles: handles(body),
        publication: physics.getDerivedPublication(2),
        shapes: physics.getDerivedShapes(2),
      }),
    );
    assert(active.every((handle) => physics.raw.getCollider(handle)?.handle !== handle));
  } finally {
    physics.dispose();
  }
});

it('falls back to one collider for automatic mass, static bodies and out-of-budget groups', async () => {
  const { physics, body, publish } = await fixture();
  try {
    publish(input());
    assert.strictEqual(body.numColliders(), 7);
    publish({ ...input(2), massProperties: { mode: 'automatic', density: 2 } });
    assert.strictEqual(body.numColliders(), 1);
    publish({ ...input(3), bodyType: 'static' });
    assert.strictEqual(body.numColliders(), 1);
    publish(input(4, true, 129));
    assert.strictEqual(body.numColliders(), 1);
  } finally {
    physics.dispose();
  }
});

it('coalesces logical observations across group migration, replacement and opposite native ordering', () => {
  const events = new GroupedContactEvents();
  const rows: unknown[] = [];
  const a = { entity: 1, id: 'one', grouped: true },
    b = { entity: 2, id: 'two' };
  const drain = () => events.drain(7, (...args) => rows.push(args[0]));
  assert.strictEqual(events.consume(11, 21, true, a, b), true);
  events.consume(12, 21, true, a, b);
  drain();
  assert.strictEqual(rows.length, 1);
  events.consume(11, 21, false, a, b);
  events.consume(21, 13, true, b, a);
  drain();
  assert.strictEqual(rows.length, 1);
  events.consume(12, 21, false);
  events.consume(13, 21, false);
  events.consume(14, 21, true, a, b);
  drain();
  assert.strictEqual(rows.length, 1);
  events.consume(14, 21, false);
  drain();
  assert.strictEqual(rows.length, 2);
  assert.deepEqual(rows, [
    { entityA: 1, entityB: 2, shapeA: 'one', shapeB: 'two', phase: 'started', fixedStep: 7 },
    { entityA: 1, entityB: 2, shapeA: 'one', shapeB: 'two', phase: 'stopped', fixedStep: 7 },
  ]);
  events.consume(15, 22, true, a, b);
  drain();
  events.removeEntity(1);
  assert.strictEqual(events.consume(15, 22, false), false);
  events.clear();
});

it('preserves actual logical contact observations through whole/group replacement and across groups', async () => {
  const { R, physics, body, publish } = await fixture();
  try {
    const other = physics.raw.createRigidBody(
      R.RigidBodyDesc.fixed().setTranslation(0.5, 0.5, 0.5),
    );
    other.userData = 3;
    physics.registerBody(3, other.handle);
    physics.raw.createCollider(
      R.ColliderDesc.cuboid(0.4, 0.4, 0.4)
        .setSensor(true)
        .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
      other,
    );
    const sensor = (revision: number, grouped: boolean) => {
      const value = input(revision, grouped, 33);
      return { ...value, shapes: [{ ...required(value.shapes[0]), isSensor: true }] };
    };
    publish(sensor(1, false));
    assert.strictEqual(physics.getContactObservations().length, 1);
    publish(sensor(2, true));
    assert.strictEqual(body.numColliders(), 3);
    assert.strictEqual(physics.getContactObservations().length, 1);
    other.setTranslation({ x: 60.5, y: 0.5, z: 0.5 }, true);
    physics.step(1 / 60);
    assert.strictEqual(physics.getContactObservations().length, 1);
    publish(sensor(3, false));
    assert.strictEqual(body.numColliders(), 1);
    assert.strictEqual(physics.getContactObservations().length, 1);
    other.setTranslation({ x: 200, y: 0.5, z: 0.5 }, true);
    physics.step(1 / 60);
    const stopped = physics.getContactObservations();
    assert.strictEqual(stopped.length, 2);
    assert.strictEqual(stopped[1]?.phase, 'stopped');
    assert(stopped[1]?.shapeA === 'original' || stopped[1]?.shapeB === 'original');
  } finally {
    physics.dispose();
  }
});

it('keeps both native replacement event orders equivalent once admission has seeded the old contact', () => {
  for (const oldFirst of [false, true]) {
    const events = new GroupedContactEvents(),
      rows: string[] = [];
    const a = { entity: 1, id: 'same' },
      b = { entity: 2 };
    events.seed(10, 20, a, b);
    const remove = () => events.consume(10, 20, false, a, b);
    const add = () => events.consume(11, 20, true, { ...a, grouped: true }, b);
    if (oldFirst) {
      remove();
      add();
    } else {
      add();
      remove();
    }
    events.drain(2, (event) => rows.push(event.phase));
    assert.strictEqual(rows.length, 0);
    events.consume(11, 20, false);
    events.drain(3, (event) => rows.push(event.phase));
    assert.deepEqual(rows, ['stopped']);
  }
});

it('selects a real active pair by stable spatial roster rather than native event arrival', () => {
  for (const reversed of [false, true]) {
    const ledger = new GroupedContactEvents(),
      selected: number[] = [];
    const b = { entity: 2, id: 'target' };
    const add = (index: number) =>
      ledger.consume(
        30 + index,
        50,
        true,
        { entity: 1, id: 'debris', grouped: true, groupIndex: index },
        b,
      );
    if (reversed) {
      add(5);
      add(2);
    } else {
      add(2);
      add(5);
    }
    ledger.drain(1, (_, a) => selected.push(a));
    assert.deepEqual(selected, [32]);
  }
});

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Missing fixture value');
  return value;
}
