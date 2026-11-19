import type { FrameReceipt, Renderer, RenderFrameInput } from '@forgeax/engine-render';
import type { EncodedTape, RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  drawSurfaceManagedMediumFrame,
  type SurfaceManagedMediumCapture,
  type SurfaceManagedMediumStage,
} from './surface-standard-pipeline.runtime-fixture';

function captureHost(presentations: FrameReceipt['presentation'][] = ['ready']) {
  const events: string[] = [];
  let frameId = 0;
  const renderer = {
    inspect: () => ({ frame: { frameId }, marker: `inspection-${frameId}` }),
    requestObservation: vi.fn(() => ok(undefined)),
    observe: vi.fn(async () => ok({ observations: [] })),
    draw: vi.fn(() => {
      frameId++;
      events.push(`draw-${frameId}`);
      return ok({
        frameId,
        deviceGeneration: 1,
        graphGeneration: 7,
        presentation: presentations[frameId - 1],
        observationDomains: ['linear-hdr'],
        completed: Promise.resolve().then(() => {
          events.push(`completed-${frameId}`);
          return ok(undefined);
        }),
      });
    }),
  } as unknown as Renderer;
  let captures = 0;
  const tapes: EncodedTape[] = [];
  const recorder = {
    captureFrame: vi.fn(() => {
      captures++;
      events.push(`arm-${captures}`);
      const tape = {
        bytes: new Uint8Array([captures]),
        digest: `digest-${captures}`,
      } as EncodedTape;
      tapes.push(tape);
      return Promise.resolve(ok(tape));
    }),
    frameBoundary: vi.fn(async () => {
      events.push('boundary');
      return ok(undefined);
    }),
  } satisfies Pick<RecorderAttachment, 'captureFrame' | 'frameBoundary'>;
  const completedFrame = vi.fn<SurfaceManagedMediumCapture['completedFrame']>(() => {
    events.push(`evidence-${frameId}`);
  });
  return { renderer, recorder, completedFrame, events, tapes };
}

const request = {} as RenderFrameInput;
const stage: SurfaceManagedMediumStage = {
  renderPath: 'forward',
  geometryLane: 'automatic',
  phase: 'baseline',
};

describe('managed medium completed frame evidence', () => {
  it.each([
    'baseline',
    'live-probe',
    'retirement',
  ] as const)('keeps the original %s tape/digest and same completed frame inspection', async (phase) => {
    const host = captureHost();
    const receipt = await drawSurfaceManagedMediumFrame(
      host.renderer,
      request,
      { ...stage, phase },
      host,
    );
    const evidence = host.completedFrame.mock.calls[0]?.[0];
    expect(evidence?.receipt).toBe(receipt);
    expect(evidence?.tape).toBe(host.tapes[0]);
    expect(evidence?.inspection).toMatchObject({ marker: 'inspection-1' });
    expect(evidence?.stage.phase).toBe(phase);
    expect(host.events.indexOf('arm-1')).toBeLessThan(host.events.indexOf('draw-1'));
    expect(host.events.indexOf('completed-1')).toBeLessThan(host.events.indexOf('evidence-1'));
    expect(host.renderer.requestObservation).toHaveBeenCalledWith(['linear-hdr']);
  });

  it('discards the preparation picture and captures the actual ready retry', async () => {
    const host = captureHost(['pending', 'ready']);
    const receipt = await drawSurfaceManagedMediumFrame(host.renderer, request, stage, host);
    expect(host.recorder.captureFrame).toHaveBeenCalledTimes(2);
    expect(host.completedFrame).toHaveBeenCalledTimes(1);
    expect(host.completedFrame.mock.calls[0]?.[0]).toMatchObject({
      receipt: { frameId: 2 },
      tape: { digest: 'digest-2' },
      inspection: { marker: 'inspection-2' },
    });
    expect(receipt.frameId).toBe(2);
    expect(host.renderer.observe).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...stage, renderPath: 'deferred' as const },
    { ...stage, geometryLane: 'direct' as const },
    { ...stage, phase: 'standard' as const },
    { ...stage, phase: 'restored' as const },
  ])('leaves non-representative pictures outside capture: %j', async (other) => {
    const host = captureHost();
    await drawSurfaceManagedMediumFrame(host.renderer, request, other, host);
    expect(host.recorder.captureFrame).not.toHaveBeenCalled();
    expect(host.completedFrame).not.toHaveBeenCalled();
    expect(host.renderer.requestObservation).toHaveBeenCalledWith(['linear-hdr']);
  });

  it('leaves ordinary observation unchanged when diagnostics are absent', async () => {
    const host = captureHost();
    await drawSurfaceManagedMediumFrame(host.renderer, request, stage);
    expect(host.recorder.captureFrame).not.toHaveBeenCalled();
    expect(host.renderer.requestObservation).toHaveBeenCalledWith(['linear-hdr']);
  });

  it('does not publish evidence after a failed original GPU completion', async () => {
    const host = captureHost();
    const failure = new Error('original GPU completion failed');
    host.renderer.draw = () =>
      ok({
        frameId: 1,
        presentation: 'ready',
        completed: Promise.resolve({ ok: false, error: failure }),
      } as FrameReceipt);
    await expect(drawSurfaceManagedMediumFrame(host.renderer, request, stage, host)).rejects.toBe(
      failure,
    );
    expect(host.completedFrame).not.toHaveBeenCalled();
  });
});
