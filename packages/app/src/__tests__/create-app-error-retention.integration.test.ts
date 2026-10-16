import { Update, World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { RhiError } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../create-app';
import type { AppDispatchError } from '../types';
import { testPlatform } from './platform-fixture';

function makeRenderer(): {
  readonly renderer: Renderer;
  readonly draw: ReturnType<typeof vi.fn>;
  readonly emit: (error: RhiError) => void;
} {
  const draw = vi.fn(() => ({ ok: true as const, value: undefined }));
  let listener: ((event: { readonly kind: 'error'; readonly error: RhiError }) => void) | undefined;
  const renderer = {
    state: () => 'alive' as const,
    backend: 'webgpu' as const,
    ready: Promise.resolve({ ok: true as const, value: undefined }),
    draw,
    attach: () => ({ ok: true as const, value: { dispose: () => undefined } }),
    attachWorld: () => ({ ok: true as const, value: undefined }),
    detachWorld: () => undefined,
    subscribe: (next: (event: { readonly kind: 'error'; readonly error: RhiError }) => void) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
    onLost: () => () => undefined,
    dispose: () => undefined,
  } as unknown as Renderer;
  return { renderer, draw, emit: (error) => listener?.({ kind: 'error', error }) };
}

function installFaultingSystem(world: World, cause: Error): void {
  world
    .addSystem(Update, {
      name: 'retention-faulting-update',
      queries: [],
      fn: () => {
        throw cause;
      },
    })
    .unwrap();
}

async function createPausedApp(world: World, renderer: Renderer, silenceUnhandledErrors = true) {
  const result = await createApp({
    platform: testPlatform(),
    renderer,
    world,
    silenceUnhandledErrors,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  result.value.start().unwrap();
  result.value.pause().unwrap();
  return result.value;
}

describe('createApp error retention', () => {
  it('retains a real frame/update system failure through the main dispatch owner', async () => {
    const cause = new Error('boom');
    const world = new World();
    installFaultingSystem(world, cause);
    const { renderer, draw } = makeRenderer();
    const app = await createPausedApp(world, renderer);
    let observed: AppDispatchError | undefined;
    app.onError((error) => {
      observed = error;
    });

    const frame = app.stepFrame(1 / 60);

    expect(frame.ok).toBe(false);
    if (frame.ok) return;
    expect(frame.error.code).toBe('app-system-update-failed');
    if (frame.error.code !== 'app-system-update-failed') return;
    const updateError = frame.error.detail.cause as {
      readonly code?: string;
      readonly detail?: { readonly cause?: unknown };
    };
    expect(updateError.code).toBe('system-failed');
    expect(updateError.detail?.cause).toBe(cause);
    expect(observed).toBe(frame.error);
    expect(app.lastError).toBe(frame.error);
    expect(world.execution.health).toBe('poisoned');
    expect(world.inspect().systems.map((system) => system.name)).toContain(
      'retention-faulting-update',
    );
    expect(draw).not.toHaveBeenCalled();
  });

  it('retains the same structured failure when console fallback is the only observer', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const world = new World();
    installFaultingSystem(world, new Error('unobserved boom'));
    const { renderer } = makeRenderer();
    const app = await createPausedApp(world, renderer, false);

    const frame = app.stepFrame(1 / 60);

    expect(frame.ok).toBe(false);
    if (!frame.ok) {
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(frame.error);
      expect(app.lastError).toBe(frame.error);
    }
    consoleError.mockRestore();
  });

  it('preserves renderer device-loss identity and retention', async () => {
    const world = new World();
    const { renderer, emit } = makeRenderer();
    const app = await createPausedApp(world, renderer);
    let observed: AppDispatchError | undefined;
    app.onError((error) => {
      observed = error;
    });
    const deviceLoss = new RhiError({
      code: 'device-lost',
      expected: 'the test device remains available',
      hint: 'rebuild the renderer after device recovery',
    });

    emit(deviceLoss);

    expect(observed).toBe(deviceLoss);
    expect(app.lastError).toBe(deviceLoss);
    expect(app.execution.report().fault).toBeNull();
    expect(app.execution.report().world.health).toBe('healthy');
  });
});
