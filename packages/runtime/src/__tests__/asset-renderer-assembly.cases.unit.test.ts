import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { createRenderer as createRuntimeRenderer } from '../createRenderer';
import { EngineEnvironmentError } from '../errors/environment';
import { requireRenderer } from './renderer-test-utils';

function makeMockCanvas(_options: unknown): HTMLCanvasElement {
  return { width: 64, height: 64, getContext: () => null } as unknown as HTMLCanvasElement;
}

describe('runtime renderer assembly contract', () => {
  it('returns a Result and unwraps an injected RHI renderer', async () => {
    const created = await createRuntimeRenderer(
      makeMockCanvas({ webgpu: 'context', webgl2: 'context' }),
      { rhi },
      { shaderManifestUrl: undefined },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.value.inspect().state).toBe('alive');
    expect(created.value).not.toHaveProperty('backend');
    expect(created.value).not.toHaveProperty('ready');
    expect(created.value).not.toHaveProperty('assets');
    await created.value.dispose();
  });

  it('uses the injected RHI without consulting backend auto-selection', async () => {
    const renderer = await requireRenderer(
      makeMockCanvas({ webgpu: 'context', webgl2: 'context' }),
      { rhi },
      { shaderManifestUrl: undefined },
    );
    expect(renderer.inspect().capabilities.backendKind).toBe('null');
    const unsubscribe = renderer.subscribe(() => undefined);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
    await renderer.dispose();
  });

  it('binds a World lease to a submitted frame receipt', async () => {
    const renderer = await requireRenderer(
      makeMockCanvas({ webgpu: 'context', webgl2: 'context' }),
      { rhi },
      { shaderManifestUrl: undefined },
    );
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(world.update(1 / 60).ok).toBe(true);
    const frame = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(frame.ok).toBe(true);
    if (frame.ok) {
      const observed = await renderer.observe(frame.value, { include: ['timings'] });
      expect(observed.ok).toBe(true);
    }
    await renderer.dispose();
  });

  it('reports construction failures through Result and keeps lifecycle signals public', async () => {
    const created = await createRuntimeRenderer(
      makeMockCanvas({ webgpu: 'null', webgl2: 'null' }),
      { rhi: undefined },
    );
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toBeInstanceOf(EngineEnvironmentError);

    const renderer = await requireRenderer(
      makeMockCanvas({ webgpu: 'context', webgl2: 'context' }),
      { rhi },
      { shaderManifestUrl: undefined },
    );
    const events: Array<{ kind: string; current: string | undefined }> = [];
    const unsubscribe = renderer.subscribe((event) => {
      events.push({
        kind: event.kind,
        current: event.kind === 'state-changed' ? event.current : undefined,
      });
    });

    expect(renderer.releaseSurface().ok).toBe(true);
    expect(renderer.inspect().surface).toBe('released');
    expect(renderer.restoreSurface().ok).toBe(true);
    expect(renderer.inspect().surface).toBe('available');
    const recovery = await renderer.recover();
    expect(recovery.ok).toBe(false);
    if (!recovery.ok) expect(recovery.error.code).toBe('renderer-state-invalid');

    expect((await renderer.dispose()).ok).toBe(true);
    expect(events).toContainEqual({ kind: 'state-changed', current: 'disposed' });
    unsubscribe();
    expect((await renderer.dispose()).ok).toBe(true);
  });
});
