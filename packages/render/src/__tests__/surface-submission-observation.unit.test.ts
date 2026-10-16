import { describe, expect, it } from 'vitest';
import {
  decodeSurfaceIndirectParameters,
  SurfaceSubmissionObservationOwner,
} from '../surface/submission-observation';

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function isMainViewIdentity(value: string): value is 'main:0' {
  return value === 'main:0';
}

describe('SurfaceSubmissionObservationOwner', () => {
  it('does not publish an encoded command when recording or submit aborts', () => {
    const owner = new SurfaceSubmissionObservationOwner(() => 2);
    const aborted = owner.begin({
      frameId: 1,
      requestedLane: 'direct',
      deviceGeneration: 2,
      resourceGeneration: 3,
    });
    aborted.record('color', {
      kind: 'draw',
      count: 3,
      first: 0,
      instanceCount: 1,
      firstInstance: 0,
      surfaceFrameBase: 4,
      memberIds: ['["world",1,0,0]'],
      pipelineIdentity: 9,
    });
    aborted.abort();
    expect(owner.inspect()).toBeUndefined();
  });

  it('publishes only actual commands after the matching completion fence', async () => {
    let generation = 4;
    const owner = new SurfaceSubmissionObservationOwner(() => generation);
    const empty = owner.begin({
      frameId: 1,
      requestedLane: 'direct',
      deviceGeneration: generation,
      resourceGeneration: 7,
    });
    empty.submit(Promise.resolve(), 3);
    await Promise.resolve();
    expect(owner.inspect()).toBeUndefined();

    const completion = deferred();
    const direct = owner.begin({
      frameId: 2,
      requestedLane: 'direct',
      deviceGeneration: generation,
      resourceGeneration: 7,
    });
    direct.record('nearest-layer', {
      kind: 'draw-indexed',
      count: 6,
      first: 12,
      instanceCount: 2,
      firstInstance: 0,
      surfaceFrameBase: 4,
      memberIds: ['0:9:1:1', '0:9:1:2'],
      pipelineIdentity: 11,
      receiptIdentity: 'surface@7',
      receiptGeneration: 7,
    });
    direct.submit(completion.promise, 5);
    expect(owner.inspect()).toMatchObject({
      frameId: 2,
      requestedLane: 'direct',
      actualLane: 'direct',
      status: 'submitted',
    });
    completion.resolve();
    await completion.promise;
    await Promise.resolve();
    expect(owner.inspect()).toMatchObject({
      status: 'completed',
      passes: [
        {
          pass: 'nearest-layer',
          commands: [
            {
              kind: 'draw-indexed',
              programEvidence: 'producer-receipt',
              receiptIdentity: 'surface@7',
              receiptGeneration: 7,
            },
          ],
        },
      ],
    });

    generation += 1;
  });

  it('derives the GPU lane from indirect encode and rejects failed or stale completion', async () => {
    let generation = 8;
    const owner = new SurfaceSubmissionObservationOwner(() => generation);
    const rejectedFence = deferred();
    const rejected = owner.begin({
      frameId: 3,
      requestedLane: 'direct',
      deviceGeneration: generation,
      resourceGeneration: 4,
    });
    rejected.record('color', {
      kind: 'draw-indirect',
      indirectBufferIdentity: 22,
      indirectOffset: 64,
      pipelineIdentity: 33,
    });
    rejected.submit(rejectedFence.promise, 6);
    rejectedFence.reject(new Error('completion failed'));
    await rejectedFence.promise.catch(() => undefined);
    await Promise.resolve();
    expect(owner.inspect()).toMatchObject({
      status: 'submitted',
      requestedLane: 'direct',
      actualLane: 'gpu-driven',
      passes: [{ memberEvidence: 'indirect-readback-required' }],
    });

    const staleFence = deferred();
    const stale = owner.begin({
      frameId: 4,
      requestedLane: 'direct',
      deviceGeneration: generation,
      resourceGeneration: 5,
    });
    stale.record('color', {
      kind: 'draw',
      count: 3,
      first: 0,
      instanceCount: 1,
      firstInstance: 0,
      surfaceFrameBase: 0,
      memberIds: ['0:1:0:0'],
      pipelineIdentity: 44,
    });
    stale.submit(staleFence.promise, 7);
    generation += 1;
    staleFence.resolve();
    await staleFence.promise;
    await Promise.resolve();
    expect(owner.inspect()).toMatchObject({ frameId: 4, status: 'submitted' });
  });

  it('publishes the current-frame MRT fallback reason and clears it when GPU resumes', async () => {
    const owner = new SurfaceSubmissionObservationOwner(() => 1);
    const fallback = owner.begin({
      frameId: 20,
      requestedLane: 'gpu-driven',
      deviceGeneration: 1,
      resourceGeneration: 3,
    });
    fallback.setActualLaneReason('reflection-fallback-mrt');
    fallback.record('color', {
      kind: 'draw',
      count: 3,
      first: 0,
      instanceCount: 1,
      firstInstance: 0,
      surfaceFrameBase: 0,
      memberIds: ['fallback'],
      pipelineIdentity: 1,
    });
    fallback.submit(Promise.resolve(), 2);
    await Promise.resolve();
    expect(owner.inspect()).toMatchObject({
      frameId: 20,
      requestedLane: 'gpu-driven',
      actualLane: 'direct',
      actualLaneReason: 'reflection-fallback-mrt',
      status: 'completed',
    });

    const resumed = owner.begin({
      frameId: 21,
      requestedLane: 'gpu-driven',
      deviceGeneration: 1,
      resourceGeneration: 4,
    });
    resumed.record('color', {
      kind: 'draw-indirect',
      indirectBufferIdentity: 8,
      indirectOffset: 0,
      pipelineIdentity: 2,
    });
    resumed.submit(Promise.resolve(), 3);
    await Promise.resolve();
    expect(owner.inspect()).toMatchObject({
      frameId: 21,
      requestedLane: 'gpu-driven',
      actualLane: 'gpu-driven',
      status: 'completed',
    });
    expect(owner.inspect()).not.toHaveProperty('actualLaneReason');
  });

  it('does not let an older completion overwrite the newest frame', async () => {
    const owner = new SurfaceSubmissionObservationOwner(() => 3);
    const oldFence = deferred();
    const old = owner.begin({
      frameId: 10,
      requestedLane: 'direct',
      deviceGeneration: 3,
      resourceGeneration: 1,
    });
    old.record('color', {
      kind: 'draw',
      count: 3,
      first: 0,
      instanceCount: 1,
      firstInstance: 0,
      surfaceFrameBase: 0,
      memberIds: ['0:1:0:0'],
      pipelineIdentity: 1,
    });
    old.submit(oldFence.promise, 1);

    const current = owner.begin({
      frameId: 11,
      requestedLane: 'gpu-driven',
      deviceGeneration: 3,
      resourceGeneration: 2,
    });
    current.record('color', {
      kind: 'draw-indexed-indirect',
      indirectBufferIdentity: 2,
      indirectOffset: 32,
      pipelineIdentity: 3,
    });
    current.submit(Promise.resolve(), 2);
    await Promise.resolve();
    await Promise.resolve();
    oldFence.resolve();
    await oldFence.promise;
    await Promise.resolve();
    expect(owner.inspect()).toMatchObject({ frameId: 11, status: 'completed' });
  });

  it('binds same-generation GPU members to recording frame and indirect ranges', async () => {
    const owner = new SurfaceSubmissionObservationOwner(() => 1);
    const submit = async (frameId: number, indirectOffset: number) => {
      const candidate = owner.begin({
        frameId,
        requestedLane: 'gpu-driven',
        deviceGeneration: 1,
        resourceGeneration: 7,
      });
      for (const pass of ['nearest-layer', 'color'] as const) {
        candidate.record(pass, {
          kind: 'draw-indirect',
          indirectBufferIdentity: 2,
          indirectOffset,
          pipelineIdentity: 3,
          receiptIdentity: `surface@${frameId}`,
          receiptGeneration: frameId,
        });
      }
      candidate.submit(Promise.resolve(), 1);
      await Promise.resolve();
      await Promise.resolve();
      return candidate.gpuReadbackSnapshot();
    };

    const frameA = await submit(10, 0);
    const frameB = await submit(11, 32);
    if (frameA === undefined || frameB === undefined) {
      throw new Error('expected submitted GPU readback snapshots');
    }
    if (!isMainViewIdentity(frameB.viewIdentity)) {
      throw new Error(`expected main view recording, got ${frameB.viewIdentity}`);
    }
    const frameBViewIdentity = frameB.viewIdentity;
    owner.publishGpuMembers(
      { recording: frameA, memberIds: ['frame-a-member'] },
      { frameId: 11, deviceGeneration: 1 },
    );
    expect(owner.inspect()?.passes[0]?.memberIds).toBeUndefined();

    owner.publishGpuMembers(
      {
        recording: { ...frameB, viewIdentity: 'secondary:0' },
        memberIds: ['wrong-view'],
      },
      { frameId: 11, deviceGeneration: 1 },
    );
    owner.publishGpuMembers(
      { recording: frameB, memberIds: ['wrong-device'] },
      { frameId: 11, deviceGeneration: 2 },
    );
    owner.publishGpuMembers(
      {
        recording: { ...frameB, passes: [...frameB.passes].reverse() },
        memberIds: ['wrong-pass-order'],
      },
      { frameId: 11, deviceGeneration: 1 },
    );
    expect(owner.inspect()?.passes[0]?.memberIds).toBeUndefined();

    owner.publishGpuMembers(
      {
        recording: {
          ...frameB,
          passes: frameB.passes.map((pass) => ({
            ...pass,
            ranges: pass.ranges.map((range) => ({ ...range, indirectOffset: 64 })),
          })),
        },
        memberIds: ['wrong-range'],
      },
      { frameId: 11, deviceGeneration: 1 },
    );
    expect(owner.inspect()?.passes[0]?.memberIds).toBeUndefined();

    owner.publishGpuMembers(
      {
        recording: frameB,
        memberIds: ['frame-b-member'],
        indirectParameters: frameB.passes.flatMap((pass) =>
          pass.ranges.map((range) => ({
            sequence: frameB.sequence,
            frameId: frameB.frameId,
            deviceGeneration: frameB.deviceGeneration,
            resourceGeneration: frameB.resourceGeneration,
            viewIdentity: frameBViewIdentity,
            pass: pass.pass,
            kind: range.kind,
            indirectBufferIdentity: range.indirectBufferIdentity,
            indirectOffset: range.indirectOffset,
            count: 6,
            first: 12,
            instanceCount: 2,
            baseVertex: -3,
            firstInstance: 4,
          })),
        ),
      },
      { frameId: 11, deviceGeneration: 1 },
    );
    const publishedPasses = owner.inspect()?.passes ?? [];
    expect(publishedPasses).toHaveLength(2);
    expect(publishedPasses[0]).toMatchObject({
      memberEvidence: 'indirect-visible-readback',
      memberIds: ['frame-b-member'],
      indirectParameters: expect.arrayContaining([
        expect.objectContaining({
          sequence: frameB.sequence,
          frameId: frameB.frameId,
          deviceGeneration: frameB.deviceGeneration,
          resourceGeneration: frameB.resourceGeneration,
          pass: 'nearest-layer',
          indirectBufferIdentity: 2,
          indirectOffset: 32,
          count: 6,
          first: 12,
          instanceCount: 2,
          baseVertex: -3,
          firstInstance: 4,
        }),
      ]),
    });
  });

  it('decodes indexed and non-indexed indirect words and rejects metadata/truncation', () => {
    const recording = {
      sequence: 12,
      frameId: 20,
      deviceGeneration: 4,
      resourceGeneration: 9,
      viewIdentity: 'main:0' as const,
      passes: [
        {
          pass: 'nearest-layer' as const,
          totalCommandCount: 1,
          savedCommandCount: 1,
          droppedCommandCount: 0,
          truncated: false,
          ranges: [
            {
              kind: 'draw-indexed-indirect' as const,
              indirectBufferIdentity: 77,
              indirectOffset: 0,
            },
          ],
        },
        {
          pass: 'color' as const,
          totalCommandCount: 1,
          savedCommandCount: 1,
          droppedCommandCount: 0,
          truncated: false,
          ranges: [
            {
              kind: 'draw-indirect' as const,
              indirectBufferIdentity: 77,
              indirectOffset: 20,
            },
          ],
        },
      ],
    };
    const bytes = new ArrayBuffer(40);
    const view = new DataView(bytes);
    view.setUint32(0, 36, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, 12, true);
    view.setInt32(12, -3, true);
    view.setUint32(16, 4, true);
    view.setUint32(20, 7, true);
    view.setUint32(24, 9, true);
    view.setUint32(28, 5, true);
    view.setUint32(32, 6, true);
    const decoded = decodeSurfaceIndirectParameters({
      bytes,
      byteOffset: 0,
      byteLength: bytes.byteLength,
      indirectBufferIdentity: 77,
      recording,
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value).toMatchObject([
        {
          sequence: 12,
          frameId: 20,
          deviceGeneration: 4,
          resourceGeneration: 9,
          pass: 'nearest-layer',
          kind: 'draw-indexed-indirect',
          indirectBufferIdentity: 77,
          indirectOffset: 0,
          count: 36,
          first: 12,
          instanceCount: 2,
          baseVertex: -3,
          firstInstance: 4,
        },
        {
          pass: 'color',
          kind: 'draw-indirect',
          indirectOffset: 20,
          count: 7,
          first: 5,
          instanceCount: 9,
          baseVertex: 0,
          firstInstance: 6,
        },
      ]);
    }
    const wrongBuffer = decodeSurfaceIndirectParameters({
      bytes,
      byteOffset: 0,
      byteLength: bytes.byteLength,
      indirectBufferIdentity: 78,
      recording,
    });
    expect(wrongBuffer).toMatchObject({
      ok: false,
      error: { code: 'indirect-readback-metadata-mismatch' },
    });
    const truncated = decodeSurfaceIndirectParameters({
      bytes,
      byteOffset: 0,
      byteLength: 36,
      indirectBufferIdentity: 77,
      recording,
    });
    expect(truncated).toMatchObject({
      ok: false,
      error: { code: 'indirect-readback-truncated' },
    });
  });

  it('marks a valid truncated command sample without publishing partial parameters', async () => {
    const owner = new SurfaceSubmissionObservationOwner(() => 1);
    const candidate = owner.begin({
      frameId: 34,
      requestedLane: 'gpu-driven',
      deviceGeneration: 1,
      resourceGeneration: 8,
    });
    for (let index = 0; index < 33; index += 1) {
      candidate.record('nearest-layer', {
        kind: 'draw-indexed-indirect',
        indirectBufferIdentity: 55,
        indirectOffset: index * 20,
        pipelineIdentity: 9,
      });
    }
    candidate.record('color', {
      kind: 'draw-indirect',
      indirectBufferIdentity: 55,
      indirectOffset: 660,
      pipelineIdentity: 10,
    });
    candidate.submit(Promise.resolve(), 3);
    await Promise.resolve();
    await Promise.resolve();
    const recording = candidate.gpuReadbackSnapshot();
    if (recording === undefined) throw new Error('expected an indirect readback snapshot');
    if (!isMainViewIdentity(recording.viewIdentity)) {
      throw new Error(`expected main view recording, got ${recording.viewIdentity}`);
    }
    const recordingViewIdentity = recording.viewIdentity;
    expect(recording.passes[0]).toMatchObject({
      pass: 'nearest-layer',
      totalCommandCount: 33,
      savedCommandCount: 32,
      droppedCommandCount: 1,
      truncated: true,
    });
    const parameters = recording.passes.flatMap((pass) =>
      pass.ranges.map((range) => ({
        sequence: recording.sequence,
        frameId: recording.frameId,
        deviceGeneration: recording.deviceGeneration,
        resourceGeneration: recording.resourceGeneration,
        viewIdentity: recordingViewIdentity,
        pass: pass.pass,
        kind: range.kind,
        indirectBufferIdentity: range.indirectBufferIdentity,
        indirectOffset: range.indirectOffset,
        count: 12,
        first: 9,
        instanceCount: 1,
        baseVertex: 4,
        firstInstance: 0,
      })),
    );
    owner.publishGpuMembers(
      { recording, memberIds: ['visible-member'], indirectParameters: parameters },
      { frameId: 34, deviceGeneration: 1 },
    );
    const published = owner.inspect();
    expect(published?.passes).toHaveLength(2);
    expect(published?.passes[0]).toMatchObject({
      memberEvidence: 'indirect-visible-readback-truncated',
      totalCommandCount: 33,
      savedCommandCount: 32,
      droppedCommandCount: 1,
      truncated: true,
    });
    expect(published?.passes[0]?.indirectParameters).toBeUndefined();
    expect(published?.passes[1]).toMatchObject({
      memberEvidence: 'indirect-visible-readback',
      indirectParameters: [expect.objectContaining({ pass: 'color', indirectOffset: 660 })],
    });

    const accepted = owner.inspect();
    owner.publishGpuMembers(0, { frameId: 34, deviceGeneration: 1 });
    owner.publishGpuMembers(
      {
        recording: { ...recording, frameId: 35, passes: recording.passes },
        memberIds: ['wrong-frame'],
      },
      { frameId: 34, deviceGeneration: 1 },
    );
    owner.publishGpuMembers(
      {
        recording: {
          ...recording,
          passes: recording.passes.map((pass) => ({
            ...pass,
            ranges: pass.ranges.map((range) => ({
              ...range,
              indirectBufferIdentity: range.indirectBufferIdentity + 1,
            })),
          })),
        },
        memberIds: ['wrong-buffer'],
        indirectParameters: parameters,
      },
      { frameId: 34, deviceGeneration: 1 },
    );
    expect(owner.inspect()).toBe(accepted);
  });

  it('keeps accepted GPU evidence when a later readback is missing or mismatched', async () => {
    const owner = new SurfaceSubmissionObservationOwner(() => 1);
    const candidate = owner.begin({
      frameId: 35,
      requestedLane: 'gpu-driven',
      deviceGeneration: 1,
      resourceGeneration: 9,
    });
    candidate.record('nearest-layer', {
      kind: 'draw-indexed-indirect',
      indirectBufferIdentity: 61,
      indirectOffset: 0,
      pipelineIdentity: 11,
    });
    candidate.record('color', {
      kind: 'draw-indirect',
      indirectBufferIdentity: 61,
      indirectOffset: 20,
      pipelineIdentity: 12,
    });
    candidate.submit(Promise.resolve(), 4);
    await Promise.resolve();
    await Promise.resolve();
    const recording = candidate.gpuReadbackSnapshot();
    if (recording === undefined) throw new Error('expected an indirect readback snapshot');
    if (!isMainViewIdentity(recording.viewIdentity)) {
      throw new Error(`expected main view recording, got ${recording.viewIdentity}`);
    }
    const recordingViewIdentity = recording.viewIdentity;

    const target = { frameId: 35, deviceGeneration: 1 };
    const beforeMissing = owner.inspect();
    owner.publishGpuMembers({ recording, memberIds: ['missing'] }, target);
    expect(owner.inspect()).toBe(beforeMissing);

    const parameters = recording.passes.flatMap((pass) =>
      pass.ranges.map((range) => ({
        sequence: recording.sequence,
        frameId: recording.frameId,
        deviceGeneration: recording.deviceGeneration,
        resourceGeneration: recording.resourceGeneration,
        viewIdentity: recordingViewIdentity,
        pass: pass.pass,
        kind: range.kind,
        indirectBufferIdentity: range.indirectBufferIdentity,
        indirectOffset: range.indirectOffset,
        count: 8,
        first: 4,
        instanceCount: 1,
        baseVertex: 2,
        firstInstance: 0,
      })),
    );
    owner.publishGpuMembers(
      { recording, memberIds: ['accepted'], indirectParameters: parameters },
      target,
    );
    const accepted = owner.inspect();
    expect(
      accepted?.passes.every((pass) => pass.memberEvidence === 'indirect-visible-readback'),
    ).toBe(true);

    owner.publishGpuMembers({ recording, memberIds: ['different'] }, target);
    expect(owner.inspect()).toBe(accepted);

    owner.publishGpuMembers(
      { recording, memberIds: ['wrong-count'], indirectParameters: [] },
      target,
    );
    expect(owner.inspect()).toBe(accepted);

    owner.publishGpuMembers(
      { recording, memberIds: ['wrong-order'], indirectParameters: [...parameters].reverse() },
      target,
    );
    expect(owner.inspect()).toBe(accepted);

    const wrongIdentity = parameters.map((parameter, index) =>
      index === 0
        ? { ...parameter, indirectBufferIdentity: parameter.indirectBufferIdentity + 1 }
        : parameter,
    );
    owner.publishGpuMembers(
      { recording, memberIds: ['wrong-identity'], indirectParameters: wrongIdentity },
      target,
    );
    expect(owner.inspect()).toBe(accepted);
  });

  it.each([
    [31, 31, 0, false],
    [32, 32, 0, false],
    [33, 32, 1, true],
  ] as const)('reports %i encoded commands as total/saved/dropped/truncated', async (total, saved, dropped, truncated) => {
    const owner = new SurfaceSubmissionObservationOwner(() => 1);
    const candidate = owner.begin({
      frameId: total,
      requestedLane: 'direct',
      deviceGeneration: 1,
      resourceGeneration: 7,
    });
    for (let index = 0; index < total; index += 1) {
      candidate.record('color', {
        kind: 'draw',
        count: 3,
        first: 0,
        instanceCount: 1,
        firstInstance: 0,
        surfaceFrameBase: index,
        memberIds: [String(index)],
        pipelineIdentity: 3,
      });
    }
    candidate.submit(Promise.resolve(), 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(owner.inspect()?.passes[0]).toMatchObject({
      commandCount: total,
      totalCommandCount: total,
      savedCommandCount: saved,
      droppedCommandCount: dropped,
      truncated,
      memberEvidence: truncated ? 'direct-command-members-truncated' : 'direct-command-members',
    });
  });

  it('derives the actual lane from a capped-out indirect command', async () => {
    const owner = new SurfaceSubmissionObservationOwner(() => 1);
    const candidate = owner.begin({
      frameId: 33,
      requestedLane: 'direct',
      deviceGeneration: 1,
      resourceGeneration: 7,
    });
    for (let index = 0; index < 32; index += 1) {
      candidate.record('color', {
        kind: 'draw',
        count: 3,
        first: 0,
        instanceCount: 1,
        firstInstance: 0,
        surfaceFrameBase: index,
        memberIds: [String(index)],
        pipelineIdentity: 3,
      });
    }
    candidate.record('color', {
      kind: 'draw-indirect',
      indirectBufferIdentity: 4,
      indirectOffset: 64,
      pipelineIdentity: 5,
    });
    candidate.submit(Promise.resolve(), 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(owner.inspect()).toMatchObject({
      actualLane: 'gpu-driven',
      passes: [
        {
          totalCommandCount: 33,
          savedCommandCount: 32,
          droppedCommandCount: 1,
          truncated: true,
          memberEvidence: 'indirect-readback-required',
        },
      ],
    });
  });

  it('keeps the selected producer receipt on each direct command', async () => {
    const owner = new SurfaceSubmissionObservationOwner(() => 1);
    const candidate = owner.begin({
      frameId: 1,
      requestedLane: 'direct',
      deviceGeneration: 1,
      resourceGeneration: 7,
    });
    for (const [surfaceFrameBase, receipt] of [
      [4, { identity: 'water-a@1', generation: 1 }],
      [8, { identity: 'water-b@3', generation: 3 }],
      [12, undefined],
    ] as const) {
      candidate.record('color', {
        kind: 'draw',
        count: 3,
        first: 0,
        instanceCount: 1,
        firstInstance: 0,
        surfaceFrameBase,
        memberIds: [`member-${surfaceFrameBase}`],
        pipelineIdentity: surfaceFrameBase,
        ...(receipt === undefined
          ? {}
          : {
              receiptIdentity: receipt.identity,
              receiptGeneration: receipt.generation,
            }),
      });
    }
    candidate.submit(Promise.resolve(), 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(owner.inspect()?.passes[0]?.commands).toMatchObject([
      {
        surfaceFrameBase: 4,
        receiptIdentity: 'water-a@1',
        receiptGeneration: 1,
        programEvidence: 'producer-receipt',
      },
      {
        surfaceFrameBase: 8,
        receiptIdentity: 'water-b@3',
        receiptGeneration: 3,
        programEvidence: 'producer-receipt',
      },
      { surfaceFrameBase: 12, programEvidence: 'missing' },
    ]);
  });
});
