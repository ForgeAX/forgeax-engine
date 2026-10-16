import { describe, expect, it } from 'vitest';
import {
  adoptBackendDevice,
  DeviceScope,
  type LifecycleResourceSpec,
  LifecycleTransaction,
} from '../device/device-scope';

function spec(
  kind: LifecycleResourceSpec<unknown>['kind'],
  order: string[],
  index: number,
  failAt?: number,
): LifecycleResourceSpec<unknown> {
  return {
    kind,
    create: () => {
      if (failAt === index) throw new Error(`create-${kind}`);
      order.push(`create:${kind}`);
      return { kind };
    },
    cleanup: () => {
      order.push(`cleanup:${kind}`);
    },
  };
}

describe('DeviceScope lifecycle transaction', () => {
  it('retires its backend device after scoped GPU resources, once', () => {
    const scope = DeviceScope.create(2, 'renderer');
    const order: string[] = [];
    scope._adopt('device', { id: 'device' }, () => {
      order.push('device');
    });
    scope._adopt('buffer', { id: 'buffer' }, () => {
      order.push('buffer');
    });

    scope.dispose();
    scope.dispose();

    expect(order).toEqual(['buffer', 'device']);
    expect(scope.state).toBe('disposed');
  });

  it('adopts backend device retirement only when the backend supplies a disposer', () => {
    const device = { id: 'device' };
    const scope = DeviceScope.create(3, 'renderer');
    const retired: unknown[] = [];
    adoptBackendDevice(scope, device, (value) => {
      retired.push(value);
    });
    expect(scope.resourceDelta()).toBe(1);
    scope.dispose();
    expect(retired).toEqual([device]);

    const unmanaged = DeviceScope.create(4, 'renderer');
    adoptBackendDevice(unmanaged, {}, undefined);
    expect(unmanaged.resourceDelta()).toBe(0);
    unmanaged.dispose();
  });

  it('does not retain a late LUT resource after recovery disposal', async () => {
    const scope = DeviceScope.create(40, 'renderer');
    let resolveCreate: ((value: { id: string }) => void) | undefined;
    const transaction = new LifecycleTransaction(scope);
    transaction.add({
      kind: 'texture',
      create: () => new Promise<{ id: string }>((resolve) => (resolveCreate = resolve)),
      cleanup: () => undefined,
    });
    const pending = transaction.commit();
    scope.dispose();
    resolveCreate?.({ id: 'late-lut' });
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(scope.resourceDelta()).toBe(0);
    expect(scope.state).toBe('disposed');
  });

  it('rolls back the first N-1 resources in reverse order and keeps the primary error', async () => {
    const scope = DeviceScope.create(7, 'renderer');
    const order: string[] = [];
    const transaction = new LifecycleTransaction(scope, { failureAt: 4 });
    transaction.add(spec('listener', order, 1));
    transaction.add(spec('surface', order, 2));
    transaction.add(spec('shader', order, 3));
    transaction.add(spec('pipeline', order, 4, 4));

    const result = await transaction.commit();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.primary.code).toBe('lifecycle-construction-failed');
      expect(result.error.primary.detail.owner).toBe('renderer');
      expect(result.error.cleanupFailures).toEqual([]);
      expect(result.error.receipt.generation).toBe(7);
    }
    expect(order).toEqual([
      'create:listener',
      'create:surface',
      'create:shader',
      'cleanup:shader',
      'cleanup:surface',
      'cleanup:listener',
    ]);
    expect(scope.resourceDelta()).toBe(0);
    expect(scope.state).toBe('active');
  });

  it('collects cleanup failures without changing the primary error or resource delta', async () => {
    const scope = DeviceScope.create(8, 'renderer');
    const transaction = new LifecycleTransaction(scope, { failureAt: 3 });
    transaction.add({
      kind: 'buffer',
      create: () => ({ id: 'buffer' }),
      cleanup: () => {
        throw new Error('buffer-cleanup');
      },
    });
    transaction.add({
      kind: 'texture',
      create: () => ({ id: 'texture' }),
      cleanup: () => undefined,
    });
    transaction.add({
      kind: 'binding',
      create: () => {
        throw new Error('binding-create');
      },
      cleanup: () => undefined,
    });

    const result = await transaction.commit();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.primary.detail.operation).toBe('create');
      expect(result.error.primary.detail.resourceKind).toBe('binding');
      expect(result.error.cleanupFailures).toHaveLength(1);
      expect(result.error.cleanupFailures[0]?.resourceKind).toBe('buffer');
    }
    expect(scope.resourceDelta()).toBe(0);
  });

  it('publishes a replacement only after complete success and retires the old scope', async () => {
    const current = DeviceScope.create(10, 'renderer');
    const oldRef = current.ref('shader', { id: 'old' });

    const replacementResult = await current.replace(11, [
      {
        kind: 'shader',
        create: () => ({ id: 'new' }),
        cleanup: () => undefined,
      },
    ]);

    expect(replacementResult.ok).toBe(true);
    if (replacementResult.ok) {
      expect(current.state).toBe('retired');
      expect(replacementResult.value.state).toBe('active');
      expect(replacementResult.value.parent).toBe(current);
      expect(oldRef.isStale(replacementResult.value)).toBe(true);
    }
  });

  it('keeps the current scope active when replacement construction is lost', async () => {
    const current = DeviceScope.create(20, 'renderer');
    const result = await current.replace(21, [
      {
        kind: 'surface',
        create: () => {
          throw new Error('replacement-loss');
        },
        cleanup: () => undefined,
      },
    ]);

    expect(result.ok).toBe(false);
    expect(current.state).toBe('active');
    expect(current.generation).toBe(20);
    expect(current.resourceDelta()).toBe(0);
  });

  it('makes dispose win over an in-flight construction and terminalizes pending work', async () => {
    const scope = DeviceScope.create(30, 'renderer');
    let resolveCreate: ((value: { id: string }) => void) | undefined;
    const transaction = new LifecycleTransaction(scope);
    transaction.add({
      kind: 'post-effect',
      create: () => new Promise<{ id: string }>((resolve) => (resolveCreate = resolve)),
      cleanup: () => undefined,
    });

    const pending = transaction.commit();
    scope.dispose();
    resolveCreate?.({ id: 'late' });
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(scope.state).toBe('disposed');
    expect(scope.resourceDelta()).toBe(0);
  });

  it('runs an adopted cleanup once across repeated scope termination', async () => {
    const scope = DeviceScope.create(31, 'renderer');
    let cleanupCount = 0;
    const transaction = new LifecycleTransaction(scope);
    transaction.add({
      kind: 'pipeline',
      create: () => ({ id: 'candidate-pipeline' }),
      cleanup: () => {
        cleanupCount += 1;
      },
    });

    const result = await transaction.commit();

    expect(result.ok).toBe(true);
    scope.retire();
    scope.dispose();
    scope.abandon();
    expect(cleanupCount).toBe(1);
  });
});

it('detaches terminal child scopes while retaining pending ownership', () => {
  const parent = DeviceScope.create(1, 'renderer');
  const pending = parent.createChild('pending');
  let cleaned = 0;
  pending._adopt('buffer', {}, () => {
    cleaned += 1;
  });
  pending.beginRetire();
  for (let index = 0; index < 300; index += 1) {
    for (const action of ['retire', 'abandon', 'dispose'] as const) {
      const child = parent.createChild(action);
      child._adopt('buffer', {}, () => {
        cleaned += 1;
      });
      child[action]();
      child[action]();
    }
  }
  expect(parent.childrenSnapshot).toEqual([pending]);
  expect(cleaned).toBe(900);
  pending.retire();
  expect(parent.childrenSnapshot).toEqual([]);
  parent.dispose();
  expect(cleaned).toBe(901);
});
