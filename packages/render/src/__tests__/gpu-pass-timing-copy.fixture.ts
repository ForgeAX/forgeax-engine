import { attachRecorder, decodeTape } from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { summarizeGpuPassTimingIntervals } from '../record/gpu-pass-timing/parser';
import {
  createGpuPassTimingSession,
  type GpuPassTimingSessionOptions,
} from '../record/gpu-pass-timing/session';

export async function verifyCopyTimingMarkers(): Promise<void> {
  const recorder = attachRecorder(gpu).unwrap();
  const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] })).unwrap();
  const source = device.createBuffer({ size: 256, usage: 0x04 | 0x08 }).unwrap();
  const destination = device.createBuffer({ size: 256, usage: 0x04 | 0x08 }).unwrap();
  const readback = device.createBuffer({ size: 256, usage: 0x01 | 0x08 }).unwrap();
  let moduleCount = 0;
  const immediate = recorder.backend.createShaderModuleImmediate;
  assert(immediate);
  const dependencies: GpuPassTimingSessionOptions = {
    shaderModuleFactory: {
      createShaderModule: (descriptor) => {
        moduleCount += 1;
        return immediate(device, descriptor);
      },
    },
  };
  let session = createGpuPassTimingSession(device, { maxPassesPerFrame: 4 }, dependencies).unwrap();
  let captured: ReturnType<typeof recorder.captureFrame> | undefined;
  try {
    for (let frameId = 1; frameId <= 60; frameId += 1) {
      if (frameId === 60) {
        captured = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
      }
      const capture = session
        .beginFrame({ frameId, deviceGeneration: 0, graphGeneration: frameId < 31 ? 0 : 1 })
        .unwrap();
      const expectedBytes = new Uint8Array(256).fill(frameId);
      device.queue.writeBuffer(source, 0, expectedBytes).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const names = frameId < 31 ? ['first', 'interior', 'last'] : ['first', 'last'];
      for (const [executionIndex, passName] of names.entries()) {
        const identity = { passName, passKind: 'copy' as const, executionIndex };
        capture.recordPass(identity);
        capture.copyBoundaryBefore(identity, encoder);
        encoder.copyBufferToBuffer(source, 0, destination, 0, 256);
        capture.copyBoundaryAfter(identity, encoder);
      }
      capture.encodeTail(encoder).unwrap();
      encoder.copyBufferToBuffer(destination, 0, readback, 0, 256);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      capture.markSubmitted(device.queue.onSubmittedWorkDone());
      const observed = (await capture.observe()).unwrap();
      const mapped = (await readback.mapAsync(0x01)).unwrap();
      expect(new Uint8Array(mapped.getMappedRange().unwrap())).toEqual(expectedBytes);
      mapped.unmap();
      const coverage = summarizeGpuPassTimingIntervals(
        observed.passes,
        observed.timestampPeriodNanoseconds,
      ).unwrap();
      expect(coverage.sumNanoseconds).toBeGreaterThanOrEqual(coverage.unionNanoseconds);
      expect(coverage.envelopeNanoseconds).toBeGreaterThanOrEqual(coverage.unionNanoseconds);
      expect(observed.passes).toHaveLength(names.length);
      for (const entry of observed.passes) {
        expect(entry.status, JSON.stringify(entry)).toBe('measured');
        if (entry.status === 'measured') {
          expect(entry.measurementSource).toBe('copy-boundary-envelope');
          expect(BigInt(entry.endTick)).toBeGreaterThanOrEqual(BigInt(entry.beginningTick));
          if (entry.endTick === entry.beginningTick)
            expect(entry.timerResolution).toBe('equal-ticks');
        }
      }
    }
    expect(moduleCount).toBe(1);
    // A zero-work frame and a missing owner query use the same real query pool.
    const empty = session
      .beginFrame({ frameId: 61, deviceGeneration: 0, graphGeneration: 2 })
      .unwrap();
    const emptyEncoder = device.createCommandEncoder().unwrap();
    empty.encodeTail(emptyEncoder).unwrap();
    device.queue.submit([emptyEncoder.finish().unwrap()]).unwrap();
    empty.markSubmitted(device.queue.onSubmittedWorkDone());
    expect((await empty.observe()).unwrap().passes).toEqual([]);
    const missing = session
      .beginFrame({ frameId: 62, deviceGeneration: 0, graphGeneration: 2 })
      .unwrap();
    const identity = {
      passName: 'owned-elsewhere',
      passKind: 'compute' as const,
      executionIndex: 0,
    };
    missing.recordPass(identity);
    missing.markOwnerConflict(identity);
    const missingEncoder = device.createCommandEncoder().unwrap();
    missing.encodeTail(missingEncoder).unwrap();
    device.queue.submit([missingEncoder.finish().unwrap()]).unwrap();
    missing.markSubmitted(device.queue.onSubmittedWorkDone());
    expect((await missing.observe()).unwrap().passes).toMatchObject([
      { status: 'unmeasured', reason: { code: 'timestamp-owner-conflict' } },
    ]);
    session.dispose();
    expect(session.beginFrame({ frameId: 63, deviceGeneration: 1, graphGeneration: 3 }).ok).toBe(
      false,
    );
    // Reconstruct the timing owner on the same physical device. This proves
    // pool reclamation/readmission; it does not simulate native device loss.
    session = createGpuPassTimingSession(device, { maxPassesPerFrame: 4 }, dependencies).unwrap();
    const recovered = session
      .beginFrame({ frameId: 63, deviceGeneration: 1, graphGeneration: 3 })
      .unwrap();
    const recoveredEncoder = device.createCommandEncoder().unwrap();
    const recoveredIdentity = {
      passName: 'recovered-copy',
      passKind: 'copy' as const,
      executionIndex: 0,
    };
    recovered.recordPass(recoveredIdentity);
    recovered.copyBoundaryBefore(recoveredIdentity, recoveredEncoder);
    recoveredEncoder.copyBufferToBuffer(source, 0, destination, 0, 256);
    recovered.copyBoundaryAfter(recoveredIdentity, recoveredEncoder);
    recovered.encodeTail(recoveredEncoder).unwrap();
    device.queue.submit([recoveredEncoder.finish().unwrap()]).unwrap();
    recovered.markSubmitted(device.queue.onSubmittedWorkDone());
    expect((await recovered.observe()).unwrap()).toMatchObject({
      deviceGeneration: 1,
      graphGeneration: 3,
      passes: [{ status: 'measured', measurementSource: 'copy-boundary-envelope' }],
    });
    expect(moduleCount).toBe(2);
    session.dispose();
    (await recorder.frameBoundary()).unwrap();
    assert(captured);
    const encoded = (await captured).unwrap();
    const tape = decodeTape(encoded.bytes).unwrap();
    const queryResources = [
      ...tape.bootstrap.filter((resource) => resource.kind === 'query-set'),
      ...tape.events.filter((event) => event.kind === 'createQuerySet'),
    ];
    const destroyed = tape.events.filter((event) => event.kind === 'destroyQuerySet');
    expect(queryResources.length).toBeGreaterThan(0);
    expect(destroyed).toHaveLength(queryResources.length);
    expect(tape.events.some((event) => event.kind === 'resolveQuerySet')).toBe(true);
  } finally {
    session.dispose();
    device.destroyBuffer(source).unwrap();
    device.destroyBuffer(destination).unwrap();
    device.destroyBuffer(readback).unwrap();
    (await recorder.dispose()).unwrap();
  }
}
