import { readFileSync } from 'node:fs';
import { type Context, createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { combineSmokeErrors, createSmokeCleanup } from '../../scripts/smoke-resource-cleanup.mjs';

type CleanupName = 'attachment' | 'device' | 'renderer' | 'target';

type CleanupSource = {
  name: CleanupName;
  position: number;
  expression: string;
};

type FakeDevice = { destroy: () => void };
type FakeTexture = { destroy: () => void };
type FakeAdapter = { requestDevice: (...args: unknown[]) => Promise<FakeDevice> };

type FakeSmokeScope = {
  sharedDevice: FakeDevice | undefined;
  navigator: { gpu: { device: FakeDevice } };
  originalRequestAdapter: (...args: unknown[]) => Promise<FakeAdapter | null>;
  renderTarget: FakeTexture | undefined;
  renderer: { dispose: () => Promise<{ ok: true } | { ok: false; error: Error }> };
  attachment: { value: { dispose: () => void } };
};

function readSmokeSourceContract() {
  const source = readFileSync(new URL('../../scripts/smoke-dawn.mjs', import.meta.url), 'utf8');
  const sourceFile = ts.createSourceFile(
    'smoke-dawn.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const cleanups: CleanupSource[] = [];
  let requestAdapterExpression: string | undefined;

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(sourceFile) === 'smokeCleanup.own' &&
      node.arguments[0] !== undefined &&
      ts.isArrowFunction(node.arguments[0])
    ) {
      const expression = node.arguments[0];
      const body = expression.body.getText(sourceFile);
      let name: CleanupName | undefined;
      if (body.includes('sharedDevice?.destroy?.()')) name = 'device';
      else if (body.includes('target?.destroy?.()') && body.includes('renderTarget = undefined'))
        name = 'target';
      else if (body.includes('await renderer.dispose()')) name = 'renderer';
      else if (body.includes('attachment.value.dispose()')) name = 'attachment';
      if (name)
        cleanups.push({
          name,
          position: node.getStart(sourceFile),
          expression: expression.getText(sourceFile),
        });
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(sourceFile) === 'gpu.requestAdapter' &&
      ts.isArrowFunction(node.right)
    ) {
      requestAdapterExpression = node.right.getText(sourceFile);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { source, cleanups, requestAdapterExpression };
}

const smokeSourceContract = readSmokeSourceContract();

function createFakeSmokeFixture(deviceDestroy?: () => void) {
  const events: string[] = [];
  let rawDeviceDestroyCount = 0;
  let externalDeviceDestroyCount = 0;
  const rawDevice: FakeDevice = {
    destroy() {
      rawDeviceDestroyCount += 1;
      events.push('raw-device.destroy');
      deviceDestroy?.();
    },
  };
  const externalDevice: FakeDevice = {
    destroy() {
      externalDeviceDestroyCount += 1;
      events.push('external-device.destroy');
    },
  };
  const target: FakeTexture = {
    destroy() {
      events.push('canvas-target.destroy');
    },
  };
  const adapter: FakeAdapter = {
    async requestDevice() {
      return rawDevice;
    },
  };
  const scope = createContext({
    sharedDevice: undefined as FakeDevice | undefined,
    navigator: { gpu: { device: externalDevice } },
    originalRequestAdapter: async () => adapter,
    renderTarget: target as FakeTexture | undefined,
    renderer: {
      async dispose() {
        events.push('renderer.dispose');
        return { ok: true as const };
      },
    },
    attachment: {
      value: {
        dispose() {
          events.push('attachment.dispose');
        },
      },
    },
  }) as unknown as FakeSmokeScope;

  return {
    scope,
    events,
    rawDevice,
    get rawDeviceDestroyCount() {
      return rawDeviceDestroyCount;
    },
    get externalDeviceDestroyCount() {
      return externalDeviceDestroyCount;
    },
  };
}

function evaluateSourceCallback(expression: string, scope: FakeSmokeScope) {
  return runInContext(`(${expression})`, scope as unknown as Context) as () => void | Promise<void>;
}

function sourceCleanups(scope: FakeSmokeScope, names: CleanupName[]) {
  return smokeSourceContract.cleanups
    .filter(({ name }) => names.includes(name))
    .sort((a, b) => a.position - b.position)
    .map(({ expression }) => evaluateSourceCallback(expression, scope));
}

async function captureRequestDevice(scope: FakeSmokeScope, deviceOptions: unknown) {
  const expression = smokeSourceContract.requestAdapterExpression;
  if (expression === undefined) throw new Error('smoke requestAdapter wrapper was not found');
  const requestAdapter = runInContext(`(${expression})`, scope as unknown as Context) as (
    ...args: unknown[]
  ) => Promise<FakeAdapter | null>;
  const adapter = await requestAdapter({ powerPreference: 'low-power' });
  if (adapter === null) throw new Error('fake adapter was not returned');
  return adapter.requestDevice(deviceOptions);
}

describe('volumetric fog smoke cleanup', () => {
  it('releases owned resources in reverse order after a failure and preserves cleanup errors', async () => {
    const releases: string[] = [];
    const primaryError = new Error('renderer setup failed');
    const cleanupError = new Error('readback release failed');
    const cleanup = createSmokeCleanup();
    cleanup.own(() => releases.push('globals'));
    cleanup.own(() => releases.push('device'));
    cleanup.own(() => releases.push('target'));
    cleanup.own(() => releases.push('world context'));
    cleanup.own(() => releases.push('manifest URL'));
    cleanup.own(() => releases.push('renderer'));
    cleanup.own(() => releases.push('attachment'));
    cleanup.own(() => {
      releases.push('readback');
      throw cleanupError;
    });

    let primaryFailure: { error: unknown } | undefined;
    let cleanupErrors: unknown[] = [];
    try {
      throw primaryError;
    } catch (error) {
      primaryFailure = { error };
    } finally {
      cleanupErrors = await cleanup.dispose();
    }
    const combined = combineSmokeErrors(primaryFailure, cleanupErrors);

    expect(releases).toEqual([
      'readback',
      'attachment',
      'renderer',
      'manifest URL',
      'world context',
      'target',
      'device',
      'globals',
    ]);
    expect(cleanupErrors).toEqual([cleanupError]);
    expect(combined).toBeInstanceOf(AggregateError);
    expect((combined as AggregateError).errors).toEqual([primaryError, cleanupError]);
    expect((combined as AggregateError).cause).toBe(primaryError);
    expect(await cleanup.dispose()).toEqual([]);
    expect(releases).toHaveLength(8);
  });

  it('returns the original failure unchanged when cleanup succeeds', async () => {
    const primaryError = new Error('Fox fixture setup failed');
    const cleanup = createSmokeCleanup();
    const released: string[] = [];
    cleanup.own(() => released.push('renderer'));

    let primaryFailure: { error: unknown } | undefined;
    let cleanupErrors: unknown[] = [];
    try {
      throw primaryError;
    } catch (error) {
      primaryFailure = { error };
    } finally {
      cleanupErrors = await cleanup.dispose();
    }

    expect(cleanupErrors).toEqual([]);
    expect(combineSmokeErrors(primaryFailure, cleanupErrors)).toBe(primaryError);
    expect(released).toEqual(['renderer']);
  });

  it('destroys only the intercepted raw device after attachment, renderer, and target retirement', async () => {
    expect(smokeSourceContract.requestAdapterExpression).toBeDefined();
    expect(smokeSourceContract.cleanups.map(({ name }) => name).sort()).toEqual([
      'attachment',
      'device',
      'renderer',
      'target',
    ]);
    expect(smokeSourceContract.source).not.toContain('rendererOwnsDevice');

    const fixture = createFakeSmokeFixture();
    const interceptedDevice = await captureRequestDevice(fixture.scope, { label: 'smoke-owned' });
    expect(interceptedDevice).toBe(fixture.rawDevice);
    expect(fixture.scope.sharedDevice).toBe(fixture.rawDevice);
    const cleanup = createSmokeCleanup();
    for (const release of sourceCleanups(fixture.scope, [
      'device',
      'target',
      'renderer',
      'attachment',
    ])) {
      cleanup.own(release);
    }

    expect(await cleanup.dispose()).toEqual([]);
    expect(fixture.events).toEqual([
      'attachment.dispose',
      'renderer.dispose',
      'canvas-target.destroy',
      'raw-device.destroy',
    ]);
    expect(fixture.rawDeviceDestroyCount).toBe(1);
    expect(fixture.externalDeviceDestroyCount).toBe(0);
    expect(await cleanup.dispose()).toEqual([]);
    expect(fixture.rawDeviceDestroyCount).toBe(1);
  });

  it('releases a captured device after construction fails before renderer ownership exists', async () => {
    const fixture = createFakeSmokeFixture();
    await captureRequestDevice(fixture.scope, { label: 'smoke-owned' });
    const cleanup = createSmokeCleanup();
    for (const release of sourceCleanups(fixture.scope, ['device', 'target'])) cleanup.own(release);
    const primaryError = new Error('renderer construction failed');
    const cleanupErrors = await cleanup.dispose();

    expect(fixture.events).toEqual(['canvas-target.destroy', 'raw-device.destroy']);
    expect(fixture.rawDeviceDestroyCount).toBe(1);
    expect(combineSmokeErrors({ error: primaryError }, cleanupErrors)).toBe(primaryError);
  });

  it('continues device release after renderer disposal fails and keeps the original cause', async () => {
    const fixture = createFakeSmokeFixture();
    await captureRequestDevice(fixture.scope, { label: 'smoke-owned' });
    const rendererError = new Error('renderer scope dispose failed');
    fixture.scope.renderer = {
      async dispose() {
        fixture.events.push('renderer.dispose');
        return { ok: false, error: rendererError };
      },
    };
    const cleanup = createSmokeCleanup();
    for (const release of sourceCleanups(fixture.scope, [
      'device',
      'target',
      'renderer',
      'attachment',
    ])) {
      cleanup.own(release);
    }
    const primaryError = new Error('smoke frame failed');
    const cleanupErrors = await cleanup.dispose();
    const combined = combineSmokeErrors({ error: primaryError }, cleanupErrors);

    expect(fixture.events).toEqual([
      'attachment.dispose',
      'renderer.dispose',
      'canvas-target.destroy',
      'raw-device.destroy',
    ]);
    expect(fixture.rawDeviceDestroyCount).toBe(1);
    expect(combined).toBeInstanceOf(AggregateError);
    expect((combined as AggregateError).cause).toBe(primaryError);
    expect((combined as AggregateError).errors[1]).toMatchObject({ cause: rendererError });
  });

  it('does not retry a failing raw device destroy when cleanup is disposed repeatedly', async () => {
    const destroyError = new Error('raw device destroy failed');
    const fixture = createFakeSmokeFixture(() => {
      throw destroyError;
    });
    await captureRequestDevice(fixture.scope, { label: 'smoke-owned' });
    const cleanup = createSmokeCleanup();
    for (const release of sourceCleanups(fixture.scope, [
      'device',
      'target',
      'renderer',
      'attachment',
    ])) {
      cleanup.own(release);
    }
    const primaryError = new Error('smoke assertion failed');
    const cleanupErrors = await cleanup.dispose();
    const combined = combineSmokeErrors({ error: primaryError }, cleanupErrors);

    expect(fixture.events).toEqual([
      'attachment.dispose',
      'renderer.dispose',
      'canvas-target.destroy',
      'raw-device.destroy',
    ]);
    expect(fixture.rawDeviceDestroyCount).toBe(1);
    expect(combined).toBeInstanceOf(AggregateError);
    expect((combined as AggregateError).errors).toEqual([primaryError, destroyError]);
    expect((combined as AggregateError).cause).toBe(primaryError);
    expect(await cleanup.dispose()).toEqual([]);
    expect(fixture.rawDeviceDestroyCount).toBe(1);
  });
});
