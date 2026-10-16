import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createGpuPassTimingSession } from '../record/gpu-pass-timing/session.js';
import type { FrameReceipt } from '../render-contract.js';
import { createGpuPassTimingObservationStore } from '../renderer.js';

async function createNullDevice(): Promise<RhiNullDevice> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  return (await adapter.requestDevice()).unwrap() as RhiNullDevice;
}

function receipt(frameId: number): FrameReceipt {
  return {
    frameId,
    deviceGeneration: 1,
    presentation: 'ready',
    completed: Promise.resolve(ok(undefined)),
  } as FrameReceipt;
}

describe('GPU pass timing RhiNull refusal and exact-zero evidence', () => {
  it('keeps the real RhiNull draw path free of timing resources and commands', async () => {
    const device = await createNullDevice();
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const output = graph
      .createTexture('output', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
      .unwrap();
    const outputView = graph.view(output).unwrap();
    graph
      .addRasterPass('scene', {
        accesses: [{ resource: outputView, usage: 'color-attachment' }],
        colorAttachments: [{ view: outputView, loadOp: 'clear', storeOp: 'store' }],
        encode: ({ pass }) => pass.draw(3, 1, 0, 0),
      })
      .unwrap();

    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const querySetsBefore = device.bookkeeper
      .allRecords()
      .filter((record) => record.kind === 'QuerySet');
    const encoder = device.createCommandEncoder({ label: 'rhi-null-off' }).unwrap();
    expect(compiled.execute({ encoder }).ok).toBe(true);
    const commandBuffer = encoder.finish().unwrap();
    expect(device.queue.submit([commandBuffer]).ok).toBe(true);

    expect(device.totalDrawCount).toBe(1);
    expect(device.framePassNames).toEqual(['scene']);
    expect(
      device.bookkeeper.allRecords().filter((record) => record.kind === 'QuerySet'),
    ).toHaveLength(querySetsBefore.length);
    expect(
      device.bookkeeper.allRecords().filter((record) => record.kind === 'Buffer'),
    ).toHaveLength(0);
    expect((await compiled.retire()).ok).toBe(true);
  });

  it('refuses opt-in before allocation and keeps repeated recovery attempts side-effect free', async () => {
    const device = await createNullDevice();
    const before = device.bookkeeper.recordCount();
    const first = createGpuPassTimingSession(device, { retentionFrames: 8 });
    const second = createGpuPassTimingSession(device, { retentionFrames: 8 });

    expect(first).toMatchObject({
      ok: false,
      error: { code: 'timestamp-period-unavailable' },
    });
    expect(second).toMatchObject({
      ok: false,
      error: { code: 'timestamp-period-unavailable' },
    });
    expect(device.bookkeeper.recordCount()).toBe(before);
    expect(device.bookkeeper.allRecords().some((record) => record.kind === 'QuerySet')).toBe(false);
  });

  it('reports unavailable observations without tick or duration fields', async () => {
    const store = createGpuPassTimingObservationStore({
      retentionFrames: 8,
      currentDeviceGeneration: () => 1,
    });
    const current = receipt(1);
    store.register(current, async () => ({
      status: 'unavailable',
      reason: {
        code: 'timestamp-query-unsupported',
        expected: 'the active device exposes timestamp-query',
        hint: 'use a backend that supports timestamp-query',
        detail: {},
      },
      capability: { timestampQuery: false, timestampPeriodNanoseconds: null },
    }));

    const observed = await store.observe(current, { include: ['timings'] });
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    expect(observed.value.timings).toMatchObject({
      status: 'unavailable',
      reason: { code: 'timestamp-query-unsupported' },
    });
    expect(observed.value.timings).not.toHaveProperty('tick');
    expect(observed.value.timings).not.toHaveProperty('durationNanoseconds');
    expect(JSON.stringify(observed.value)).not.toContain('durationNanoseconds');
  });

  it('marks a RhiNull artifact as refused rather than manufacturing GPU evidence', async () => {
    const validatorModulePath = '../../bench/gpu-pass-timing/validator.js';
    const { validateGpuPassTimingReport } = await import(validatorModulePath);
    const refused = validateGpuPassTimingReport({
      schemaVersion: '1.0',
      benchmark: 'render-gpu-pass-timing',
      source: { sourceHead: '0'.repeat(40), package: '@forgeax/engine-render' },
      runner: { name: 'rhi-null-test', version: '1', os: 'test', browser: null },
      backend: {
        kind: 'null',
        adapter: 'RhiNull',
        driver: 'none',
        browser: 'none',
        realGpu: false,
      },
    });

    expect(refused).toMatchObject({ ok: false, error: { code: 'artifact-not-real-gpu' } });
  });
});
