import { describe, expect, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import {
  cloneDerivedPhysicsInput,
  normalizeConvexCompoundShapeInput,
  preserveCenterOfMassVelocity,
  validateMassProperties,
} from '../derived-physics';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const shape = (id = 'left') => ({
  kind: 'convex-compound' as const,
  id,
  revision: 1,
  pieces: [boxPoints([-1, 0, 0], [1, 1, 1])],
});

describe('derived physics data contract', () => {
  it('copies points and normalizes a local orientation before native preparation', () => {
    const input = shape();
    const result = normalizeConvexCompoundShapeInput({ ...input, rotation: [0, 0, 0, 2] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sourcePoints = input.pieces[0];
    if (sourcePoints === undefined) throw new Error('missing source points');
    sourcePoints[0] = 99;
    expect(result.value.kind === 'convex-compound' && result.value.pieces[0]?.[0]).toBe(-1);
    expect(result.value.rotation[3]).toBeCloseTo(1);
  });

  it('retains a validated affine source matrix as the single pose authority', () => {
    const sceneMatrix = [1, 0, 0, 0, 0.5, 2, 0, 0, 0.25, 0.3, 3, 0, 4, 5, 6, 1];
    const result = cloneDerivedPhysicsInput({
      entity: 7,
      revision: 1,
      sourceKey: 'river:7',
      bodyType: 'static',
      sourceTransform: { sceneMatrix },
      shapes: [shape()],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    sceneMatrix[4] = 99;
    expect(result.value.sourceTransform?.sceneMatrix[4]).toBe(0.5);
    const singular = [...sceneMatrix];
    singular[10] = 0;
    expect(
      cloneDerivedPhysicsInput({
        entity: 7,
        revision: 2,
        sourceKey: 'river:7',
        bodyType: 'static',
        sourceTransform: { sceneMatrix: singular },
        shapes: [shape()],
      }),
    ).toMatchObject({ ok: false, error: { code: 'derived-candidate-invalid' } });
  });

  it('rejects an independent motion snapshot when a source matrix owns the static pose', () => {
    const result = cloneDerivedPhysicsInput({
      entity: 7,
      revision: 1,
      sourceKey: 'river:7',
      bodyType: 'static',
      sourceTransform: {
        sceneMatrix: [1, 0, 0, 0, 0.5, 2, 0, 0, 0.25, 0.3, 3, 0, 4, 5, 6, 1],
      },
      motion: {
        centerOfMass: [20, 30, 40],
        linearVelocity: [1, 0, 0],
        angularVelocity: [0, 1, 0],
        rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      },
      shapes: [shape()],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'derived-candidate-invalid' },
    });
  });

  it('validates source matrices again after Native f32 quantization', () => {
    const nearlyDependent = [1, 1, 0, 0, 1 + 5e-8, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(Math.fround(requiredFixtureValue(nearlyDependent[4]))).toBe(1);
    expect(
      cloneDerivedPhysicsInput({
        entity: 7,
        revision: 1,
        sourceKey: 'river:7',
        bodyType: 'static',
        sourceTransform: { sceneMatrix: nearlyDependent },
        shapes: [shape()],
      }),
    ).toMatchObject({ ok: false, error: { code: 'derived-candidate-invalid' } });
  });

  it('rejects degenerate explicit mass', () => {
    const mass = validateMassProperties({
      mode: 'explicit',
      mass: 1,
      centerOfMass: [0, 0, 0],
      principalInertia: [1, 0, 1],
    });
    expect(mass.ok).toBe(false);
    if (!mass.ok) expect(mass.error.code).toBe('derived-mass-invalid');
  });

  it('bounds candidate counts and estimated staged bytes', () => {
    const tooManyShapes = cloneDerivedPhysicsInput({
      entity: 7,
      revision: 1,
      sourceKey: 'body:7',
      shapes: Array.from({ length: 65 }, (_, index) => shape(`shape-${index}`)),
    });
    expect(tooManyShapes.ok).toBe(false);
    if (!tooManyShapes.ok) {
      expect(tooManyShapes.error.code).toBe('derived-candidate-budget-exceeded');
    }

    const tooManyBytes = cloneDerivedPhysicsInput({
      entity: 7,
      revision: 1,
      sourceKey: 'body:7',
      shapes: [
        {
          id: 'large',
          revision: 1,
          kind: 'convex-compound',
          pieces: [new Float32Array(262_144 * 3)],
        },
      ],
    });
    expect(tooManyBytes.ok).toBe(false);
    if (!tooManyBytes.ok) expect(tooManyBytes.error.code).toBe('derived-candidate-budget-exceeded');
  });

  it('preserves linear velocity at a moved center of mass and leaves angular velocity intact', () => {
    expect(preserveCenterOfMassVelocity([1, 2, 3], [0, 0, 2], [0, 0, 0], [0, 1, 0])).toEqual([
      -1, 2, 3,
    ]);
  });
});
