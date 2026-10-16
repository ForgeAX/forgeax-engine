import type { App } from '@forgeax/engine-app';
import { describe, expect, it } from 'vitest';
import { createPreviewInspection } from '../preview-inspection';

describe('Preview renderer recovery inspection', () => {
  it('exposes renderer-owned capability, limit and pending completion facts', () => {
    const capabilities = {
      backendKind: 'webgpu',
      compute: true,
      storageBuffer: false,
    };
    const limits = { maxStorageBuffersPerShaderStage: 0 };
    const pendingCompletions = [
      {
        frameId: 2,
        deviceGeneration: 1,
        presentation: 'ready',
        queue: 'pending',
        reflection: 'not-required',
      },
    ];
    const app = {
      assets: {},
      execution: { report: () => ({ fault: null }) },
      renderer: {
        inspect: () => ({
          state: 'alive',
          surface: 'available',
          capabilities,
          limits,
          frame: {
            frameId: 2,
            deviceGeneration: 1,
            pendingCompletionCount: 1,
            pendingCompletions,
          },
          features: [],
        }),
      },
    } as unknown as App;

    const { inspection } = createPreviewInspection(app, () => undefined);

    expect(inspection.renderer.health()).toEqual({
      reason: 'alive',
      recoverable: false,
      surface: 'available',
      capabilities,
      limits,
      frame: {
        frameId: 2,
        deviceGeneration: 1,
        pendingCompletionCount: 1,
        pendingCompletions,
      },
      features: [],
    });
  });

  it('prefers actual Render Worker facts over the Host renderer device', () => {
    const workerCapabilities = {
      backendKind: 'wgpu-webgl2',
      compute: false,
      storageBuffer: false,
    };
    const workerLimits = { maxStorageBuffersPerShaderStage: 0 };
    const fault = {
      source: 'runtime',
      code: 'device-operation-failed',
      expected: 'the active device generation completes the renderer-owned operation',
      hint: 'inspect the structured cause',
      detail: { cause: { code: 'standard-cluster-transport-unavailable' } },
      partialWrite: false,
      retryable: false,
    };
    const app = {
      assets: {},
      execution: {
        report: () => ({
          fault,
          render: {
            epoch: 3,
            state: 'failed',
            submittedFrame: 5,
            completedFrame: 2,
            capabilities: workerCapabilities,
            limits: workerLimits,
          },
        }),
      },
      renderer: {
        inspect: () => ({
          state: 'alive',
          surface: 'available',
          capabilities: { backendKind: 'webgpu', compute: true, storageBuffer: true },
          limits: { maxStorageBuffersPerShaderStage: 8 },
          frame: { frameId: 8, deviceGeneration: 1 },
          features: [],
        }),
      },
    } as unknown as App;

    const { inspection } = createPreviewInspection(app, () => undefined);

    expect(inspection.renderer.health()).toMatchObject({
      reason: 'failed',
      capabilities: workerCapabilities,
      limits: workerLimits,
      frame: {
        epoch: 3,
        submittedFrame: 5,
        completedFrame: 2,
      },
      lastError: fault,
    });
  });

  it('exposes live frame receipt progress for Preview teardown diagnosis', () => {
    const frame = {
      submitted: 3,
      completed: 2,
      inFlight: 1,
      highWater: 2,
      throttledTicks: 0,
    };
    const app = {
      assets: {},
      execution: { report: () => ({ frame }) },
    } as unknown as App;

    const { inspection } = createPreviewInspection(app, () => undefined);

    expect(inspection.frameProgress()).toEqual(frame);
  });

  it('constructs the registrar without publishing a partially started App', () => {
    const host = globalThis as Record<string, unknown>;
    const previous = host.__forgeaxPreviewInspection;
    delete host.__forgeaxPreviewInspection;
    const cleanups: Array<() => void> = [];
    try {
      const { inspection } = createPreviewInspection({ assets: {} } as App, (cleanup) =>
        cleanups.push(cleanup),
      );
      expect(host.__forgeaxPreviewInspection).toBeUndefined();
      // The Preview startup owner publishes this object only after native roots activate.
      host.__forgeaxPreviewInspection = inspection;
      for (const cleanup of cleanups) cleanup();
      expect(host.__forgeaxPreviewInspection).toBeUndefined();
    } finally {
      if (previous === undefined) delete host.__forgeaxPreviewInspection;
      else host.__forgeaxPreviewInspection = previous;
    }
  });

  it('preserves the renderer error identity and nested structured detail', async () => {
    const app = {
      assets: {},
      execution: { report: () => ({ fault: null }) },
      renderer: {
        inspect: () =>
          ({
            state: 'device-lost',
            surface: 'available',
            frame: { frameId: 4, deviceGeneration: 2 },
            features: [],
          }) as never,
        recover: async () =>
          ({
            ok: false,
            error: {
              code: 'recovery-failed',
              expected: 'a replacement generation publishes atomically',
              hint: 'inspect detail and retry after repairing the owner',
              detail: {
                phase: 'compile-graph',
                cause: {
                  code: 'shader-compile-failed',
                  detail: { compiler: { messages: [{ line: 7, message: 'invalid binding' }] } },
                },
                cleanupFailures: [],
              },
            },
          }) as never,
      },
    } as unknown as App;

    const { inspection } = createPreviewInspection(app, () => undefined);
    const result = await inspection.renderer.recover();

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'recovery-failed',
        expected: 'a replacement generation publishes atomically',
        hint: 'inspect detail and retry after repairing the owner',
        detail: {
          phase: 'compile-graph',
          cause: {
            code: 'shader-compile-failed',
            detail: { compiler: { messages: [{ line: 7, message: 'invalid binding' }] } },
          },
          cleanupFailures: [],
        },
      },
    });
  });

  it('retains RHI capture timeout progress in the browser inspection result', async () => {
    const app = {
      assets: {},
      rhiCapture: {
        captureFrame: async () => ({
          ok: false,
          error: {
            code: 'capture-timeout',
            expected: 'the bounded frame snapshot completes',
            hint: 'inspect the last resource read',
            detail: {
              stage: 'snapshot',
              timeoutMs: 30_000,
              totalResources: 17,
              completedResources: 3,
              skippedResources: 0,
              currentHandleId: 'texture:17',
              currentKind: 'texture',
              currentSizeBytes: 1_048_576,
              elapsedMs: 30_001,
            },
          },
        }),
      },
    } as unknown as App;

    const { inspection } = createPreviewInspection(app, () => undefined);
    const result = await inspection.captureFrame();

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'rhi-capture-failed',
        expected: 'the bounded frame snapshot completes',
        hint: 'inspect the last resource read',
        detail: {
          cause: 'capture-timeout',
          capture: {
            stage: 'snapshot',
            timeoutMs: 30_000,
            totalResources: 17,
            completedResources: 3,
            skippedResources: 0,
            currentHandleId: 'texture:17',
            currentKind: 'texture',
            currentSizeBytes: 1_048_576,
            elapsedMs: 30_001,
          },
        },
      },
    });
  });

  it('retains detached bounded Renderer completion stages and actual App frame counters', () => {
    const pendingCompletions = Array.from({ length: 8 }, (_, index) => ({
      frameId: index + 5,
      deviceGeneration: 2,
      presentation: 'ready',
      queue: index === 7 ? 'pending' : 'fulfilled',
      reflection: index === 7 ? 'pending' : 'not-required',
    }));
    const frame = {
      frameId: 12,
      deviceGeneration: 2,
      pendingCompletionCount: 12,
      pendingCompletions,
    };
    const executionFrame = {
      submitted: 2,
      completed: 0,
      inFlight: 2,
      highWater: 2,
      throttledTicks: 137,
    };
    const app = {
      assets: {},
      renderer: {
        inspect: () => ({ state: 'alive', surface: 'available', frame, features: [] }),
      },
      execution: { report: () => ({ frame: executionFrame }) },
    } as unknown as App;
    const { inspection } = createPreviewInspection(app, () => undefined);
    const health = inspection.renderer.health();
    expect(health).toEqual({
      reason: 'alive',
      recoverable: false,
      surface: 'available',
      frame,
      executionFrame,
      features: [],
    });
    const newest = pendingCompletions.at(-1);
    if (newest === undefined) throw new Error('Missing newest completion fixture');
    newest.queue = 'fulfilled';
    newest.reflection = 'fulfilled';
    pendingCompletions.pop();
    frame.pendingCompletionCount = 0;
    executionFrame.completed = 2;
    executionFrame.inFlight = 0;
    expect(health).toMatchObject({
      frame: {
        pendingCompletionCount: 12,
        pendingCompletions: expect.arrayContaining([
          {
            frameId: 12,
            deviceGeneration: 2,
            presentation: 'ready',
            queue: 'pending',
            reflection: 'pending',
          },
        ]),
      },
      executionFrame: {
        submitted: 2,
        completed: 0,
        inFlight: 2,
        highWater: 2,
        throttledTicks: 137,
      },
    });
    expect(
      (health as { frame: { pendingCompletions: unknown[] } }).frame.pendingCompletions,
    ).toHaveLength(8);
  });

  it('projects actual backend and engine health without inventing App loop state', () => {
    const app = {
      assets: {},
      renderer: {
        inspect: () => ({
          state: 'alive',
          surface: 'available',
          frame: { frameId: 2, deviceGeneration: 0 },
          features: [],
          capabilities: { backendKind: 'webgpu' },
        }),
      },
      execution: { report: () => ({ engine: { health: 'idle' } }) },
    } as unknown as App;
    const { inspection } = createPreviewInspection(app, () => undefined);
    expect(inspection.renderer.health()).toEqual(
      expect.objectContaining({ backendKind: 'webgpu', executionEngineHealth: 'idle' }),
    );
  });

  it('keeps legacy renderer health when optional completion facts or App report are absent', () => {
    const app = {
      assets: {},
      renderer: {
        inspect: () => ({
          state: 'alive',
          surface: 'available',
          frame: { frameId: 2, deviceGeneration: 0 },
          features: ['actual-feature'],
        }),
      },
    } as unknown as App;
    const { inspection } = createPreviewInspection(app, () => undefined);
    expect(inspection.renderer.health()).toEqual({
      reason: 'alive',
      recoverable: false,
      surface: 'available',
      frame: { frameId: 2, deviceGeneration: 0 },
      features: ['actual-feature'],
    });
  });
});
