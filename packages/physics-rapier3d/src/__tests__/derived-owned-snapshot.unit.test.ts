import type { HeightfieldShapeInput } from '@forgeax/engine-physics';
import { beforeAll, expect, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D, type Rapier3DModule } from '../wasm-loader.js';

let rapier: Rapier3DModule;
beforeAll(async () => {
  rapier = await loadRapier3D();
  if ('code' in rapier) throw rapier;
});

it('detaches a private heightfield snapshot from source and token buffers, poses and scales', () => {
  const physics = createRapier3DPhysicsWorld(rapier);
  physics.ensureBody(
    1,
    {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    { type: 0, mass: 0, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
    undefined,
  );
  const heights = new Float32Array([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
  const expected = heights.slice();
  const origin: [number, number, number] = [2, 0, 3];
  const scale: [number, number, number] = [4, 1, 2];
  const rotation: [number, number, number, number] = [0, 0, 0, 1];
  try {
    const candidate = physics
      .prepareDerivedShapeCandidate({
        entity: 1,
        sourceKey: 'heightfield',
        revision: 1,
        bodyType: 'static',
        shapes: [
          {
            kind: 'heightfield',
            id: 'ground',
            revision: 1,
            rows: 1,
            columns: 2,
            heights,
            origin,
            scale,
            rotation,
          },
        ],
      })
      .unwrap();
    const exposed = candidate.input.shapes[0];
    if (exposed?.kind !== 'heightfield') throw new Error('missing heightfield token');
    heights.fill(80);
    origin.fill(90);
    scale.fill(70);
    rotation.fill(60);
    exposed.heights.fill(100);
    if (exposed.origin === undefined) throw new Error('missing normalized origin');
    for (let axis = 0; axis < 3; axis++) {
      expect(Reflect.set(exposed.origin, axis, 120)).toBe(true);
      expect(Reflect.set(exposed.scale, axis, 130)).toBe(true);
    }
    physics.admitDerivedShapeCandidate(candidate).unwrap();
    physics.step(1 / 60);
    const stored = physics.captureDerivedPhysicsState().bodies[0]
      ?.shapes[0] as HeightfieldShapeInput;
    expect(stored.heights).toEqual(expected);
    expect(stored.origin).toEqual([2, 0, 3]);
    expect(stored.scale).toEqual([4, 1, 2]);
    expect(stored.rotation).toEqual([0, 0, 0, 1]);
    // Capturing public recovery POD must also leave the committed state isolated.
    stored.heights.fill(200);
    expect(
      (physics.captureDerivedPhysicsState().bodies[0]?.shapes[0] as HeightfieldShapeInput).heights,
    ).toEqual(expected);
  } finally {
    physics.dispose();
  }
});

it('keeps explicit mass and committed motion detached from producer and public token mutations', () => {
  const physics = createRapier3DPhysicsWorld(rapier);
  physics.ensureBody(
    1,
    {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    { type: 1, mass: 0, linearDamping: 0, angularDamping: 0, gravityScale: 0, ccdEnabled: 0 },
    undefined,
  );
  const points = boxPoints([0.6, 0, 0], [0.7, 1, 2]);
  const expectedPoints = points.slice();
  const centerOfMass: [number, number, number] = [0.65, 0.5, 1];
  const principalInertia: [number, number, number] = [1, 2, 3];
  const linearVelocity: [number, number, number] = [1, 2, 3];
  const motionCenter: [number, number, number] = [3, 4, 5];
  try {
    const candidate = physics
      .prepareDerivedShapeCandidate({
        entity: 1,
        sourceKey: 'explicit',
        revision: 1,
        bodyType: 'dynamic',
        shapes: [{ kind: 'convex-compound', id: 'solid', revision: 1, pieces: [points] }],
        massProperties: { mode: 'explicit', mass: 5, centerOfMass, principalInertia },
        motion: { centerOfMass: motionCenter, linearVelocity, angularVelocity: [0, 0, 0] },
      })
      .unwrap();
    points.fill(40);
    const exposedShape = candidate.input.shapes[0];
    if (exposedShape?.kind !== 'convex-compound' || exposedShape.pieces[0] === undefined)
      throw new Error('missing compound copy');
    exposedShape.pieces[0].fill(45);
    centerOfMass.fill(50);
    principalInertia.fill(60);
    linearVelocity.fill(70);
    motionCenter.fill(80);
    const exposedMass = candidate.input.massProperties;
    const exposedMotion = candidate.input.motion;
    if (exposedMass?.mode !== 'explicit' || exposedMotion === undefined)
      throw new Error('missing copied mass/motion');
    for (let axis = 0; axis < 3; axis++) {
      expect(Reflect.set(exposedMass.centerOfMass, axis, 100)).toBe(true);
      expect(Reflect.set(exposedMass.principalInertia, axis, 110)).toBe(true);
      expect(Reflect.set(exposedMotion.centerOfMass, axis, 120)).toBe(true);
      expect(Reflect.set(exposedMotion.linearVelocity, axis, 130)).toBe(true);
    }
    physics.admitDerivedShapeCandidate(candidate).unwrap();
    physics.step(1 / 60);
    expect(physics.getDerivedBodyMass(1)).toBeCloseTo(5, 5);
    const body = physics.captureDerivedPhysicsState().bodies[0];
    expect(body?.massProperties).toMatchObject({
      mass: 5,
      centerOfMass: [0.65, 0.5, 1],
      principalInertia: [1, 2, 3],
    });
    const capturedShape = body?.shapes[0];
    if (capturedShape?.kind !== 'convex-compound') throw new Error('missing committed compound');
    expect(capturedShape.pieces[0]).toEqual(expectedPoints);
    expect(body?.motion?.linearVelocity).toEqual([1, 2, 3]);
    expect(body?.motion?.centerOfMass[0]).toBeCloseTo(3 + 1 / 60, 5);
    expect(body?.motion?.centerOfMass[1]).toBeCloseTo(4 + 2 / 60, 5);
    expect(body?.motion?.centerOfMass[2]).toBeCloseTo(5 + 3 / 60, 5);
  } finally {
    physics.dispose();
  }
});
