import { DerivedPhysicsError, type PhysicsConstraintInput } from '@forgeax/engine-physics';
import { err, ok, type Result } from '@forgeax/engine-types';

export function validateConstraintInput(
  input: PhysicsConstraintInput,
): Result<PhysicsConstraintInput, DerivedPhysicsError> {
  const finiteVector = (value: readonly number[]): boolean =>
    value.length === 3 && value.every(Number.isFinite);
  if (
    typeof input.id !== 'string' ||
    input.id.trim().length === 0 ||
    !Number.isInteger(input.revision) ||
    input.revision < 0 ||
    !Number.isInteger(input.bodyA) ||
    !Number.isInteger(input.bodyB) ||
    input.bodyA === input.bodyB ||
    !finiteVector(input.anchorA) ||
    !finiteVector(input.anchorB)
  ) {
    return err(
      new DerivedPhysicsError(
        'derived-constraint-invalid',
        'constraint identity, revision, endpoint bodies, and anchors are valid',
        'supply two distinct live bodies and finite local anchors',
        { constraintId: input.id },
      ),
    );
  }
  if (input.kind === 'spring') {
    if (
      !Number.isFinite(input.restLength) ||
      input.restLength < 0 ||
      !Number.isFinite(input.stiffness) ||
      input.stiffness < 0 ||
      !Number.isFinite(input.damping) ||
      input.damping < 0
    ) {
      return err(
        new DerivedPhysicsError(
          'derived-constraint-invalid',
          'spring rest length, stiffness, and damping are finite and non-negative',
          'repair spring tuning before native creation',
          { constraintId: input.id },
        ),
      );
    }
  } else if (
    !finiteVector(input.axis) ||
    Math.hypot(input.axis[0], input.axis[1], input.axis[2]) < 1e-6 ||
    (input.limits !== undefined &&
      (!Number.isFinite(input.limits[0]) ||
        !Number.isFinite(input.limits[1]) ||
        input.limits[0] > input.limits[1]))
  ) {
    return err(
      new DerivedPhysicsError(
        'derived-constraint-invalid',
        'hinge axis is non-zero and optional limits are ordered finite values',
        'normalize the hinge axis and set minLimit <= maxLimit',
        { constraintId: input.id },
      ),
    );
  }
  return ok(input);
}
