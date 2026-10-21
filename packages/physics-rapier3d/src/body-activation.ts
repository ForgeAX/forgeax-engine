import { ManagedPhysicsError, type ManagedPhysicsFailure } from '@forgeax/engine-physics';
import { err, ok, type Result } from '@forgeax/engine-types';

export type BodyActivationCommand = 'wake' | 'sleep';
interface NativeBodyActivation {
  wakeUp(): void;
  sleep(): void;
}

/** Same command fence and owner lookup for both activation transitions. No native handle escapes. */
export function changeBodyActivation(
  entity: number,
  command: BodyActivationCommand,
  unavailable: boolean,
  bodyForEntity: () => NativeBodyActivation | undefined,
  invalidateContacts: () => void,
): Result<void, ManagedPhysicsFailure> {
  if (unavailable)
    return err(
      new ManagedPhysicsError('managed-physics-unavailable', {
        reason: `body ${command} requires a healthy PhysicsWorld outside native execution and admission`,
      }),
    );
  if (!Number.isSafeInteger(entity) || entity < 0)
    return err(new ManagedPhysicsError('managed-body-missing', { entity }));
  const body = bodyForEntity();
  if (!body) return err(new ManagedPhysicsError('managed-body-missing', { entity }));
  try {
    invalidateContacts();
    if (command === 'wake') body.wakeUp();
    else body.sleep();
    return ok(undefined);
  } catch (cause) {
    return err(
      new ManagedPhysicsError('managed-physics-failed', {
        reason: String(cause),
        recovery: 'rebuild-required',
      }),
    );
  }
}

/** Read both Native joint sets under the same live-owner/command fence. */
export function readBodyConstraintCount(
  entity: number,
  unavailable: boolean,
  bodyForEntity: () => { readonly handle: number } | undefined,
  visit: (handle: number, count: () => void) => void,
): Result<number, ManagedPhysicsFailure> {
  if (unavailable)
    return err(
      new ManagedPhysicsError('managed-physics-unavailable', {
        reason:
          'body constraint read requires a healthy PhysicsWorld outside native execution and admission',
      }),
    );
  if (!Number.isSafeInteger(entity) || entity < 0)
    return err(new ManagedPhysicsError('managed-body-missing', { entity }));
  const body = bodyForEntity();
  if (body === undefined) return err(new ManagedPhysicsError('managed-body-missing', { entity }));
  try {
    let count = 0;
    visit(body.handle, () => {
      count++;
    });
    if (!Number.isSafeInteger(count))
      throw new Error('Native body constraint count exceeded safe integer range');
    return ok(count);
  } catch (cause) {
    return err(
      new ManagedPhysicsError('managed-physics-failed', {
        reason: String(cause),
        recovery: 'rebuild-required',
      }),
    );
  }
}
