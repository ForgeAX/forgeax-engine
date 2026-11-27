import { createProfiler } from '@forgeax/engine-profiler';
import type {
  CompiledRenderGraph,
  RenderGraphFrame,
  RenderGraphPassExecution,
} from '@forgeax/engine-render-graph';
import { describe, expect, it } from 'vitest';
import type { RenderPassCpuIdentityCapture } from '../../render-contract';
import { createRenderWorld, pinRenderProfileSession } from '../../world/render-world';
import {
  createRenderGraphPassInstrumentation,
  finalizeRenderPassCpuIdentityCapture,
  graphExecutionProfilePhase,
  graphExecutionProfilePhases,
  graphPassTimingViewId,
} from '../frame-targets';
import type { GpuPassTimingCapture } from '../gpu-pass-timing/session';
import type { RenderSystemInternals } from '../render-context';

describe('graph pass view identity', () => {
  it('prepares a single profiling phase for a physical raster batch', () => {
    const rasterBatch = ['skybox', 'main', 'transparent'];
    const passes = rasterBatch.map((name) => ({ name, kind: 'raster' as const, rasterBatch }));
    expect(graphExecutionProfilePhases({ passes }, 'primary')).toEqual([
      graphExecutionProfilePhase({
        owner: 'primary',
        pass: { name: rasterBatch.join(' + '), kind: 'raster' },
      }),
    ]);
  });
  it('keeps shared and composition passes viewless even in a view-scoped context', () => {
    expect(graphPassTimingViewId({ owner: 'shared', requested: 9, inherited: 41 })).toBeUndefined();
    expect(graphPassTimingViewId({ owner: 'composition', inherited: 41 })).toBeUndefined();
  });

  it('lets ordinary view passes inherit their camera identity and capture passes use an explicit face', () => {
    expect(graphPassTimingViewId({ owner: 'view-7', inherited: 41 })).toBe(41);
    expect(graphPassTimingViewId({ owner: 'view-7', requested: 12, inherited: 41 })).toBe(12);
    expect(graphPassTimingViewId({ owner: 'capture', requested: 56, inherited: 41 })).toBe(56);
    expect(graphPassTimingViewId({ owner: 'capture', inherited: 41 })).toBeUndefined();
  });

  it('freezes declaration manifests derived from an immutable compiled graph', () => {
    const native = {
      name: 'shadow-select-3',
      kind: 'compute',
      profileName: 'shadow-select',
    } as const;
    const passes = [
      { executionIndex: 0, name: 'first', kind: 'raster' as const },
      { executionIndex: 1, name: 'copy', kind: 'copy' as const },
      {
        executionIndex: 2,
        name: 'group',
        kind: 'subgraph' as const,
        nativeProfilePasses: [native],
      },
    ] as const;
    const phases = graphExecutionProfilePhases({ passes }, 'view-7');

    expect(phases).toEqual([
      graphExecutionProfilePhase({ owner: 'view-7', pass: passes[0] }),
      graphExecutionProfilePhase({ owner: 'view-7', pass: passes[1] }),
      graphExecutionProfilePhase({ owner: 'view-7', pass: native }),
    ]);
    expect(Object.isFrozen(phases)).toBe(true);
  });

  it.each([
    { owner: 'shared', requested: 9, inherited: 41, viewEntity: 7, expected: undefined },
    {
      owner: 'composition',
      requested: undefined,
      inherited: 41,
      viewEntity: 7,
      expected: undefined,
    },
    { owner: undefined, requested: undefined, inherited: 41, viewEntity: 7, expected: 41 },
    { owner: 'capture', requested: 56, inherited: 41, viewEntity: 7, expected: 56 },
  ])('uses the same view identity for CPU rows and GPU timing identities: $owner', ({
    owner,
    requested,
    inherited,
    viewEntity,
    expected,
  }) => {
    const pass = {
      executionIndex: 0,
      name: 'identity-pass',
      kind: 'copy',
    } as RenderGraphPassExecution;
    const phaseOwner = owner ?? `view-${viewEntity}`;
    const phase = graphExecutionProfilePhase({ owner: phaseOwner, pass });
    const profiler = createProfiler({ phaseCatalog: { app: [], render: [phase] } });
    const started = profiler.startCapture({ frameLimit: 1, eventLimit: 8, detail: 'passes' });
    if (!started.ok) throw new Error(started.error.code);
    const session = started.value;
    expect(session.beginFrame(1).ok).toBe(true);

    const world = createRenderWorld();
    const restoreProfilePin = pinRenderProfileSession(world, session);
    const cpuIdentityCapture: RenderPassCpuIdentityCapture = {
      entries: [],
      instrumentationAccepted: false,
      complete: true,
    };
    const deviceScope = { generation: 3 };
    const root = {
      profiler,
      renderWorld: world,
      renderPassCpuIdentityCapture: cpuIdentityCapture,
    };
    const viewContext = { root, deviceScope, gpuPassTimingViewId: inherited };
    const gpuIdentities: { readonly viewId?: number }[] = [];
    const gpuCapture = {
      recordPass(identity: { readonly viewId?: number }) {
        gpuIdentities.push(identity);
        return {
          querySet: {},
          beginningOfPassWriteIndex: 0,
          endOfPassWriteIndex: 1,
        };
      },
    } as unknown as GpuPassTimingCapture;
    const internals = {
      ...root,
      viewContext,
      viewEntity,
      gpuPassTimingCapture: gpuCapture,
    } as unknown as RenderSystemInternals;
    const graph = {
      inspect: () => ({ generation: 4, passes: [pass] }),
    } as unknown as CompiledRenderGraph<RenderGraphFrame>;
    const instrumentation = createRenderGraphPassInstrumentation({
      internals,
      graph,
      ...(owner === undefined ? {} : { owner }),
      ...(requested === undefined ? {} : { viewId: requested }),
    });
    const scope = instrumentation?.begin(pass, {} as never);
    scope?.endPass?.();
    restoreProfilePin();

    expect(cpuIdentityCapture.entries[0]?.viewId).toBe(expected);
    expect(cpuIdentityCapture.instrumentationAccepted).toBe(true);
    expect(cpuIdentityCapture.complete).toBe(true);
    expect(gpuIdentities[0]?.viewId).toBe(expected);
    expect(session.endFrame().ok).toBe(true);
    expect(session.finish().ok).toBe(true);
  });

  it('uses the record-context World pin when raw graph internals do not own the profiler', () => {
    const pass = {
      executionIndex: 0,
      name: 'record-context-pass',
      kind: 'raster',
    } as RenderGraphPassExecution;
    const phase = graphExecutionProfilePhase({ owner: 'primary', pass });
    const profiler = createProfiler({ phaseCatalog: { app: [], render: [phase] } });
    const started = profiler.startCapture({ frameLimit: 1, eventLimit: 8, detail: 'passes' });
    if (!started.ok) throw new Error(started.error.code);
    const session = started.value;
    expect(session.beginFrame(1).ok).toBe(true);
    const world = createRenderWorld();
    const restoreProfilePin = pinRenderProfileSession(world, session);
    const cpuIdentityCapture: RenderPassCpuIdentityCapture = {
      entries: [],
      instrumentationAccepted: false,
      complete: true,
    };
    const root = { renderPassCpuIdentityCapture: cpuIdentityCapture };
    const viewContext = { root, renderWorld: world, profiler };
    const internals = {
      viewContext,
      deviceScope: { generation: 5 },
    } as unknown as RenderSystemInternals;
    const graph = {
      inspect: () => ({ generation: 7, passes: [pass] }),
    } as unknown as CompiledRenderGraph<RenderGraphFrame>;

    const instrumentation = createRenderGraphPassInstrumentation({ internals, graph });
    const scope = instrumentation?.begin(pass, {} as never);
    scope?.endPass?.();
    restoreProfilePin();

    expect(cpuIdentityCapture.entries).toHaveLength(1);
    expect(cpuIdentityCapture.instrumentationAccepted).toBe(true);
    expect(cpuIdentityCapture.complete).toBe(true);
    expect(session.endFrame().ok).toBe(true);
    expect(session.finish().ok).toBe(true);
  });

  it('keeps a graph pass pinned to completed capture A when capture B starts before recording', () => {
    const pass = {
      executionIndex: 0,
      name: 'resume-after-capture-switch',
      kind: 'compute',
    } as RenderGraphPassExecution;
    const phase = graphExecutionProfilePhase({ owner: 'primary', pass });
    const profiler = createProfiler({ phaseCatalog: { app: [], render: [phase] } });
    const captureAResult = profiler.startCapture({
      frameLimit: 1,
      eventLimit: 8,
      detail: 'passes',
    });
    if (!captureAResult.ok) throw new Error(captureAResult.error.code);
    const captureA = captureAResult.value;
    expect(captureA.beginFrame(1).ok).toBe(true);
    expect(captureA.endFrame().ok).toBe(true);
    expect(captureA.finish().ok).toBe(true);

    const captureBResult = profiler.startCapture({
      frameLimit: 1,
      eventLimit: 8,
      detail: 'passes',
    });
    if (!captureBResult.ok) throw new Error(captureBResult.error.code);
    const captureB = captureBResult.value;
    expect(captureB.beginFrame(2).ok).toBe(true);
    const world = createRenderWorld();
    const restoreProfilePin = pinRenderProfileSession(world, captureA);
    const cpuIdentityCapture: RenderPassCpuIdentityCapture = {
      entries: [],
      instrumentationAccepted: false,
      complete: true,
    };
    const root = { renderPassCpuIdentityCapture: cpuIdentityCapture };
    const internals = {
      viewContext: { root, renderWorld: world, profiler },
      deviceScope: { generation: 8 },
    } as unknown as RenderSystemInternals;
    const graph = {
      inspect: () => ({ generation: 9, passes: [pass] }),
    } as unknown as CompiledRenderGraph<RenderGraphFrame>;

    const instrumentation = createRenderGraphPassInstrumentation({ internals, graph });
    const scope = instrumentation?.begin(pass, {} as never);
    scope?.endPass?.();
    restoreProfilePin();

    expect(cpuIdentityCapture.entries).toHaveLength(0);
    expect(cpuIdentityCapture.complete).toBe(false);
    expect(captureB.endFrame().ok).toBe(true);
    const captureBExport = captureB.finish();
    expect(captureBExport.ok).toBe(true);
    if (captureBExport.ok) expect(captureBExport.value.records).toHaveLength(0);
  });

  it('marks a captured receipt identity incomplete when the pinned session is absent', () => {
    const pass = {
      executionIndex: 0,
      name: 'missing-pinned-session',
      kind: 'copy',
    } as RenderGraphPassExecution;
    const cpuIdentityCapture: RenderPassCpuIdentityCapture = {
      entries: [],
      instrumentationAccepted: false,
      complete: true,
    };
    const world = createRenderWorld();
    const restoreProfilePin = pinRenderProfileSession(world, undefined);
    const root = { renderPassCpuIdentityCapture: cpuIdentityCapture };
    const internals = {
      viewContext: { root, renderWorld: world },
    } as unknown as RenderSystemInternals;
    const graph = {
      inspect: () => ({ generation: 10, passes: [pass] }),
    } as unknown as CompiledRenderGraph<RenderGraphFrame>;

    expect(createRenderGraphPassInstrumentation({ internals, graph })).toBeUndefined();
    expect(cpuIdentityCapture.entries).toHaveLength(0);
    expect(cpuIdentityCapture.instrumentationAccepted).toBe(false);
    expect(cpuIdentityCapture.complete).toBe(false);
    restoreProfilePin();
  });
});

describe('graph pass CPU identity completeness', () => {
  it('rejects an empty sidecar when the same receipt timing capture executed a pass', () => {
    const identityCapture: RenderPassCpuIdentityCapture = {
      entries: [],
      instrumentationAccepted: true,
      complete: true,
    };

    finalizeRenderPassCpuIdentityCapture({
      identityCapture,
      passTimingCapture: { frameId: 9, nextExecutionIndex: 1 },
      receiptFrameId: 9,
    });

    expect(identityCapture.complete).toBe(false);
  });

  it('keeps an accepted zero-pass CPU-only graph complete', () => {
    const identityCapture: RenderPassCpuIdentityCapture = {
      entries: [],
      instrumentationAccepted: true,
      complete: true,
    };

    finalizeRenderPassCpuIdentityCapture({ identityCapture, receiptFrameId: 10 });

    expect(identityCapture.complete).toBe(true);
  });

  it('marks a collector incomplete when no pass instrumentation accepted it', () => {
    const identityCapture: RenderPassCpuIdentityCapture = {
      entries: [],
      instrumentationAccepted: false,
      complete: true,
    };

    finalizeRenderPassCpuIdentityCapture({ identityCapture, receiptFrameId: 11 });

    expect(identityCapture.complete).toBe(false);
  });

  it('does not borrow an execution count from a different timing frame', () => {
    const identityCapture: RenderPassCpuIdentityCapture = {
      entries: [],
      instrumentationAccepted: true,
      complete: true,
    };

    finalizeRenderPassCpuIdentityCapture({
      identityCapture,
      passTimingCapture: { frameId: 12, nextExecutionIndex: 1 },
      receiptFrameId: 13,
    });

    expect(identityCapture.complete).toBe(true);
  });
});
