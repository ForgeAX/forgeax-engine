import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { executeCompiledFrameGraph } from '../../__tests__/frame-recording-driver';
import type { RenderFeaturePlannedFrame } from '../../features/plan';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../../gpu-texture-usage';
import { createAutoExposureGraphPlan } from '../../pipeline/standard-output/auto-exposure/graph';
import { createTemporalFrameTransaction, TemporalViewHistory } from '../../temporal/frame';
import type { RenderFrameState } from '../frame-snapshot';
import { getTextureIdentity, validateGraphTargetCaptureReadback } from '../frame-snapshot';
import {
  type RenderFeatureGraphCandidate,
  renderFeatureGraphPlanSignature,
  rollbackGraphCandidate,
  updateRenderFeaturePlanRevision,
} from '../typed-frame-graph';

const captureDescriptor = {
  texture: {} as never,
  format: 'rgba16float' as const,
  size: { width: 4, height: 2 },
  usage: GPU_TEXTURE_USAGE_COPY_SRC,
  sample: 1,
};

type CaptureOverrides = {
  readonly target?: boolean;
  readonly onSubmitted?: () => void;
  readonly onPhysical?: (done: Promise<unknown>) => void;
  readonly track?: (done: Promise<void>) => void;
  readonly descriptor?: {
    readonly format?: 'rgba16float' | 'rgba8unorm';
    readonly size?: { readonly width: number; readonly height: number };
    readonly usage?: number;
  };
  readonly identity?: {
    graphGeneration: number;
    recordFrameNumber: number;
    textureIdentity: number;
  };
};

function executeCapture(overrides: CaptureOverrides = {}) {
  const errors: unknown[] = [];
  const copies: unknown[] = [];
  const texture = {} as never;
  const descriptor = { ...captureDescriptor, ...overrides.descriptor, texture };
  const graph = {
    execute: () => ok(undefined),
  };
  const frameState = {
    temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
    temporalView: new TemporalViewHistory(),
    compiledFrameGraph: {
      graph,
      topologyKey: 'synthetic-capture',
      targets: {
        graphGeneration: 7,
        getColorTargetTexture: () => (overrides.target === false ? undefined : texture),
        getColorTargetDescriptor: () => (overrides.target === false ? undefined : descriptor),
        getColorTargetView: () => undefined,
      },
    },
    frameNumber: 13,
    graphTargetCapture: {
      name: 'standard-output-color',
      buffer: {} as never,
      bytesPerRow: 256,
      width: 4,
      height: 2,
      expected: {
        format: 'rgba16float' as const,
        width: 4,
        height: 2,
        usage: GPU_TEXTURE_USAGE_COPY_SRC,
        identity: overrides.identity ?? {
          graphGeneration: 7,
          recordFrameNumber: 13,
          textureIdentity: getTextureIdentity(texture),
        },
      },
    },
  } as never;
  const encoder = {
    copyTextureToBuffer: (...args: unknown[]) => copies.push(args),
    finish: () => ok({} as never),
  } as never;
  const internals = {
    errorRegistry: { fire: (error: unknown) => errors.push(error) },
    // RenderRecord opens the submission's one encoder.
    device: {
      createCommandEncoder: () => ok(encoder),
      queue: { submit: () => ok(undefined), onSubmittedWorkDone: () => Promise.resolve() },
    },
  } as never;
  const submitted = executeCompiledFrameGraph(
    internals,
    frameState,
    { pipelineState: {} } as never,
    undefined,
    {
      ...(overrides.onSubmitted === undefined ? {} : { onSubmitted: overrides.onSubmitted }),
      ...(overrides.track === undefined ? {} : { onSubmittedWork: overrides.track }),
    },
    undefined,
    overrides.onPhysical,
  );
  return { submitted, errors, copies };
}

function failureReason(errors: readonly unknown[]): string {
  const error = errors[0] as { detail?: { error?: { message?: string } } } | undefined;
  return error?.detail?.error?.message ?? '';
}

function planned(generation: number, signature: string): RenderFeaturePlannedFrame {
  return {
    featureIdentity: 'synthetic.feature',
    scope: { view: 'main' },
    generation,
    signature,
    plan: { resources: [], passes: [] },
  };
}

describe('typed frame graph feature plan authority', () => {
  it('stashes a barrier-prepared candidate without promoting it as a submitted scene graph', () => {
    const previousGraph = {} as never;
    const candidateGraph = {} as never;
    const previousInstalled = { graph: previousGraph } as never;
    const candidateInstalled = { graph: candidateGraph } as never;
    const frameState = {
      compiledFrameGraphCandidate: {
        graph: candidateGraph,
        previous: {
          installed: previousInstalled,
          graphGeneration: 7,
          compiledGeneration: 3,
          lightingSignature: 'accepted-before-pending',
        },
      },
      compiledFrameGraph: candidateInstalled,
      graphGeneration: 8,
      compiledFrameGraphGeneration: 4,
      standardLightingGraphSignature: 'candidate-only',
      unsubmittedCompiledFrameGraph: undefined,
      retiredCompiledFrameGraphs: new Set(),
      barrelDistortionGraphResolution: 'accepted',
    } as unknown as RenderFrameState;

    rollbackGraphCandidate(frameState, true);

    expect(frameState).toMatchObject({
      compiledFrameGraph: previousInstalled,
      graphGeneration: 7,
      compiledFrameGraphGeneration: 3,
      standardLightingGraphSignature: 'accepted-before-pending',
      unsubmittedCompiledFrameGraph: {
        installed: candidateInstalled,
      },
    });
    expect(frameState.compiledFrameGraphCandidate).toBeUndefined();
  });

  it('carries auto exposure as one frame-local candidate plan', () => {
    const plan = createAutoExposureGraphPlan({ width: 17, height: 9 });
    expect(plan.candidateAvailableSameFrame).toBe(true);
    expect(plan.cpuReadbackCount).toBe(0);
    expect(plan.cpuUploadCount).toBe(0);
  });

  it('keys topology and last-known-good candidates by stable plan signature and generation', () => {
    const first = renderFeatureGraphPlanSignature([planned(1, 'plan-a')]);
    expect(renderFeatureGraphPlanSignature([planned(1, 'plan-a')])).toBe(first);
    expect(renderFeatureGraphPlanSignature([planned(1, 'plan-b')])).not.toBe(first);
    expect(renderFeatureGraphPlanSignature([planned(2, 'plan-a')])).not.toBe(first);
  });

  it('keys candidates only by producer plans', () => {
    const candidate: RenderFeatureGraphCandidate = {
      plans: [planned(1, 'plan-a')],
      fullscreenEffects: new Map(),
    };
    expect(candidate.plans).toHaveLength(1);
  });

  it('keeps the compact revision stable for equivalent plan objects', () => {
    const first = updateRenderFeaturePlanRevision(
      { revision: 0, entries: [] },
      [planned(1, 'plan-a')],
      [{ featureIdentity: 'synthetic.feature', order: 0, passes: [] }],
    );
    const equivalent = updateRenderFeaturePlanRevision(
      first,
      [planned(1, 'plan-a')],
      [{ featureIdentity: 'synthetic.feature', order: 0, passes: [] }],
    );
    expect(equivalent).toBe(first);
    expect(equivalent.revision).toBe(1);

    const changedSignature = updateRenderFeaturePlanRevision(
      equivalent,
      [planned(1, 'plan-b')],
      [{ featureIdentity: 'synthetic.feature', order: 0, passes: [] }],
    );
    expect(changedSignature.revision).toBe(2);
    expect(
      updateRenderFeaturePlanRevision(
        changedSignature,
        [planned(2, 'plan-b')],
        [{ featureIdentity: 'synthetic.feature', order: 0, passes: [] }],
      ).revision,
    ).toBe(3);
    expect(
      updateRenderFeaturePlanRevision(
        changedSignature,
        [planned(1, 'plan-b')],
        [{ featureIdentity: 'synthetic.feature', order: 1, passes: [] }],
      ).revision,
    ).toBe(3);
  });

  it('keeps execution projection out of the public planned-frame vocabulary', () => {
    const invalid: RenderFeaturePlannedFrame = {
      ...planned(1, 'plan-a'),
      // @ts-expect-error execution belongs to the graph candidate adapter, not the producer plan.
      execution: {},
    };
    void invalid;
  });

  it.each([
    ['missing target', { target: false }, 'target-not-present-in-current-graph'],
    ['format mismatch', { descriptor: { format: 'rgba8unorm' as const } }, 'descriptor-mismatch'],
    ['extent mismatch', { descriptor: { size: { width: 2, height: 2 } } }, 'extent-mismatch'],
    ['COPY_SRC missing', { descriptor: { usage: 0 } }, 'copy-src-usage-missing'],
    [
      'identity mismatch',
      { identity: { graphGeneration: 8, recordFrameNumber: 12, textureIdentity: 999 } },
      'identity-mismatch',
    ],
  ])('fails closed for capture %s', (_name, overrides, expectedReason) => {
    const result = executeCapture(overrides);
    expect(result.submitted).toBe(true);
    expect(result.copies).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(failureReason(result.errors)).toContain(`"reason":"${expectedReason}"`);
  });

  it('copies the exact target only after all capture identity and descriptor checks pass', () => {
    const result = executeCapture();
    expect(result.submitted).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.copies).toHaveLength(1);
  });

  it('keeps the submit hook on the successful commit path', () => {
    let calls = 0;
    const result = executeCapture({
      onSubmitted: () => {
        calls += 1;
      },
    });
    expect(result.submitted).toBe(true);
    expect(calls).toBe(1);
  });

  it.each([
    [
      'missing same-submit copy / untouched sentinel',
      new Uint8Array([0xa5, 0xa5, 0xa5, 0xa5]),
      new Uint8Array([0xa5, 0xa5]),
      'capture-readback-untouched-sentinel',
    ],
    ['all-empty readback', new Uint8Array(4), undefined, 'capture-readback-empty'],
    [
      'non-finite float16',
      new Uint8Array([0x01, 0x7c, 0, 0]),
      undefined,
      'capture-readback-non-finite',
    ],
  ])('returns a structured failure for %s readback', (_name, bytes, sentinel, expectedCode) => {
    const result = validateGraphTargetCaptureReadback({
      bytes,
      expectedByteLength: 4,
      ...(sentinel === undefined ? {} : { sentinel }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(expectedCode);
  });
});

it('delivers the graph physical fence to resource owners when its observation callback throws', () => {
  const failure = new Error('observation failed');
  const tracked = vi.fn();
  let fence: Promise<unknown> | undefined;
  expect(() =>
    executeCapture({
      onPhysical: (done) => {
        fence = done;
        throw failure;
      },
      track: tracked,
    }),
  ).toThrow(failure);
  expect(fence).toBeInstanceOf(Promise);
  expect(tracked).toHaveBeenCalledExactlyOnceWith(fence);
});
