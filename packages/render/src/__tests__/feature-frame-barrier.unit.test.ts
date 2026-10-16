import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { type FrameRecording, submitFrameRecordings } from '../assembly/frame-recording';
import { createRenderFeatureHost, type RenderFeatureFrameResult } from '../features/host';
import type { RenderFeature } from '../features/types';
import type { RenderSystemInternals } from '../record/render-context';

async function fixture(failure: 'none' | 'record' | 'finish' | 'submit') {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const encoder = device.createCommandEncoder().unwrap();
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
  } as unknown as RenderSystemInternals;
  const finish = vi.spyOn(encoder, 'finish');
  const submit = vi.spyOn(device.queue, 'submit');
  if (failure === 'finish')
    finish.mockReturnValue({ ok: false, error: { code: 'test-finish' } } as never);
  if (failure === 'submit')
    submit.mockReturnValue({ ok: false, error: { code: 'test-submit' } } as never);
  function* view(identity: string): FrameRecording {
    let prepared: RenderFeatureFrameResult | undefined;
    yield {
      kind: 'features',
      host,
      encoder,
      internals,
      input: {
        identity,
        render: true,
        worlds: [],
        owner: 0,
        frameNumber: 1,
        caps: device.caps,
      },
      accept: (result) => {
        if (result.errors.length) throw result.errors[0];
        prepared = result;
      },
    };
    events.push(`record:${identity}`);
    if (failure === 'record' && identity === 'b') return false;
    const submitted = yield { encoder, device, reportError() {} };
    if (submitted.ok) {
      prepared?.onSubmitted();
      events.push(`commit:${identity}`);
    } else {
      prepared?.onAborted();
      events.push(`abort:${identity}`);
    }
    return submitted.ok;
  }
  return { view, events, finish, submit, host };
}

describe('Renderer feature frame barrier', () => {
  it('extracts the complete roster once and acknowledges the source once after one submit', async () => {
    const f = await fixture('none');
    expect(submitFrameRecordings([f.view('a'), f.view('b')])).toBe(true);
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
      expect(() => submitFrameRecordings([f.view('a'), f.view('b')])).toThrowError(
        expect.objectContaining({
          code: 'frame-submit-rejected',
          detail: { operation: 'draw', stage: 'submit', accepted: false },
        }),
      );
    else expect(submitFrameRecordings([f.view('a'), f.view('b')])).toBe(false);
    expect(f.events.filter((event) => event === 'extract:2')).toHaveLength(1);
    expect(f.events.filter((event) => event === 'feature-abort')).toHaveLength(1);
    expect(f.events).not.toContain('source-ack');
    expect(f.events).not.toContain('feature-submit');
    expect(f.events).toContain('abort:a');
    f.host.dispose();
  });
});
