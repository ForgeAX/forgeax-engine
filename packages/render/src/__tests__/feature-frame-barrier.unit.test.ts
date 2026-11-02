import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createRenderFeatureHost, type RenderFeatureFrameInput } from '../features/host';
import type { RenderFeature } from '../features/types';
import type { RenderSystemInternals } from '../record/render-context';
import { stageRecordedFeatureGraph } from '../world/feature-systems';
import { awaitsRenderRecord } from '../world/graph-systems';
import { endRenderFrame, renderSubmission } from '../world/render-world';
import { stageFeatureFrame } from './feature-frame-driver';
import { type FrameRecording, submitFrameRecordings } from './frame-recording-driver';

async function fixture(failure: 'none' | 'record' | 'finish' | 'submit') {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const encoder = device.createCommandEncoder().unwrap();
  // RenderRecord opens the submission encoder this fixture inspects.
  vi.spyOn(device, 'createCommandEncoder').mockReturnValue(ok(encoder) as never);
  const events: string[] = [];
  const feature: RenderFeature<number> = {
    identity: 'frame.transaction',
    extract: ({ views }) => {
      events.push(`extract:${views.length}`);
      return ok(1);
    },
    plan: (_data, { views }) =>
      ok({
        work: [
          { scope: 'frame', resources: [], passes: [] },
          ...views.map((view) => ({ scope: { view: view.identity }, resources: [], passes: [] })),
        ],
        sourceFeedback: 'consumed',
      }),
    onFrameSubmitted: () => {
      events.push('feature-submit');
    },
    onSourceFrameSubmitted: () => {
      events.push('source-ack');
    },
    onFrameAborted: () => {
      events.push('feature-abort');
    },
  };
  const host = createRenderFeatureHost([feature as RenderFeature<unknown>]).unwrap();
  const internals = {
    device,
    canvas: { width: 1, height: 1 },
    errorRegistry: { fire() {} },
    renderWorld: host.world,
  } as unknown as RenderSystemInternals;
  const finish = vi.spyOn(encoder, 'finish');
  const submit = vi.spyOn(device.queue, 'submit');
  if (failure === 'finish')
    finish.mockReturnValue({ ok: false, error: { code: 'test-finish' } } as never);
  if (failure === 'submit')
    submit.mockReturnValue({ ok: false, error: { code: 'test-submit' } } as never);
  const input = (identity: string): RenderFeatureFrameInput => ({
    identity,
    render: true,
    worlds: [],
    owner: 0,
    frameNumber: 1,
    caps: device.caps,
  });
  // RenderPrepare seals the frame's Feature batch before any view records.
  const stage = (identities: readonly string[]) => {
    const outcome = stageFeatureFrame(host, identities.map(input));
    if (outcome.kind !== 'sealed') throw new Error(`Feature frame ${outcome.kind}`);
    return outcome.batch;
  };
  function* view(identity: string, batch: ReturnType<typeof stage>): FrameRecording {
    const prepared = batch.views.get(identity);
    if (prepared?.errors.length) throw prepared.errors[0];
    yield { kind: 'shared-work', internals, sceneInputs: false };
    // The view's graph compiles in RenderRecord, before any view encodes.
    if (awaitsRenderRecord(host.world)) yield { kind: 'compile', world: host.world };
    events.push(`record:${identity}`);
    if (failure === 'record' && identity === 'b') return false;
    const submitted = yield { reportError() {} };
    if (submitted.ok) {
      stageRecordedFeatureGraph(host.world, {
        kind: 'empty',
        frame: renderSubmission(host.world).frame,
        generation: renderSubmission(host.world).generation,
        view: undefined,
        plans: prepared?.plans ?? [],
      });
      events.push(`commit:${identity}`);
    } else events.push(`abort:${identity}`);
    return submitted.ok;
  }
  const views = (identities: readonly string[]) => {
    const batch = stage(identities);
    return identities.map((identity) => view(identity, batch));
  };
  // RenderCommit/RenderCleanup settle the frame after its submission published.
  const record = (identities: readonly string[]) => {
    try {
      return submitFrameRecordings(
        { world: host.world, device, rendererInternals: internals },
        views(identities),
      );
    } finally {
      endRenderFrame(host.world);
    }
  };
  return { record, events, finish, submit, host };
}

describe('Renderer feature frame barrier', () => {
  it('extracts the complete roster once and acknowledges the source once after one submit', async () => {
    const f = await fixture('none');
    expect(f.record(['a', 'b'])).toBe(true);
    expect(f.events).toEqual([
      'extract:2',
      'record:a',
      'record:b',
      'commit:a',
      'commit:b',
      'feature-submit',
      'source-ack',
    ]);
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(f.submit).toHaveBeenCalledTimes(1);
    f.host.dispose();
  });
  it.each([
    'record',
    'finish',
    'submit',
  ] as const)('aborts shared consumption when %s fails', async (failure) => {
    const f = await fixture(failure);
    if (failure === 'submit')
      expect(() => f.record(['a', 'b'])).toThrowError(
        expect.objectContaining({
          code: 'frame-submit-rejected',
          detail: expect.objectContaining({
            operation: 'draw',
            stage: 'submit',
            accepted: false,
            cause: expect.objectContaining({ code: 'test-submit' }),
          }),
        }),
      );
    else expect(f.record(['a', 'b'])).toBe(false);
    expect(f.events.filter((event) => event === 'extract:2')).toHaveLength(1);
    expect(f.events.filter((event) => event === 'feature-abort')).toHaveLength(1);
    expect(f.events).not.toContain('source-ack');
    expect(f.events).not.toContain('feature-submit');
    expect(f.events).toContain('abort:a');
    f.host.dispose();
  });
});
