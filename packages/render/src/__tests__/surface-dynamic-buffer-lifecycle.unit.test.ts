import type {
  BindGroup,
  BindGroupDescriptor,
  Buffer,
  BufferDescriptor,
  Result,
  RhiError as RhiErrorType,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue, rhi } from '@forgeax/engine-rhi-null';
import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { deriveMaterialDynamicInputLayout, err } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
import { GPU_BUFFER_USAGE_STORAGE } from '../gpu-usage';
import { buildSurfaceDirectInstancesBindGroupLayout } from '../pbr-pipeline';
import { ReadonlyDynamicInputPage } from '../surface/dynamic-input';
import { standardPbrInputs } from './gpu-driven-production-fixture';

class DeferredQueue extends RhiNullQueue {
  readonly pendingFences: Array<() => void> = [];
  readonly writtenBuffers: Buffer[] = [];
  failNextWrite = false;

  override writeBuffer(
    buffer: Buffer,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number,
    size?: number,
  ): Result<void, RhiErrorType> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'the candidate Surface buffer upload succeeds',
          hint: 'retry the owner upload after the queue write is available',
        }),
      );
    }
    const written = super.writeBuffer(buffer, bufferOffset, data, dataOffset, size);
    if (written.ok) this.writtenBuffers.push(buffer);
    return written;
  }

  override onSubmittedWorkDone(): Promise<undefined> {
    return new Promise((resolve) => {
      this.pendingFences.push(() => resolve(undefined));
    });
  }

  async drain(): Promise<void> {
    for (const resolve of this.pendingFences.splice(0)) resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

class LifecycleDevice extends RhiNullDevice {
  readonly createdBuffers: Buffer[] = [];
  readonly destroyCalls: Buffer[] = [];
  readonly bindGroupDescriptors: BindGroupDescriptor[] = [];
  failNextBindGroup = false;

  override createBuffer(desc: BufferDescriptor): Result<Buffer, RhiErrorType> {
    const created = super.createBuffer(desc);
    if (created.ok) this.createdBuffers.push(created.value);
    return created;
  }

  override destroyBuffer(buffer: Buffer): Result<void, RhiErrorType> {
    this.destroyCalls.push(buffer);
    return super.destroyBuffer(buffer);
  }

  override createBindGroup(desc: BindGroupDescriptor): Result<BindGroup, RhiErrorType> {
    this.bindGroupDescriptors.push(desc);
    if (this.failNextBindGroup) {
      this.failNextBindGroup = false;
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'the candidate Surface bind group rebuild succeeds',
          hint: 'retry the Surface page replacement after the bind group is available',
        }),
      );
    }
    return super.createBindGroup(desc);
  }
}

function createLifecycleDevice(queue: DeferredQueue): LifecycleDevice {
  return new LifecycleDevice(
    queue,
    (bookkeeper, device) => new RhiNullCommandEncoder(bookkeeper, device),
  );
}

const dynamicSchema = {
  name: 'surfaceEvents',
  fields: [{ name: 'strength', type: 'f32' as const }],
  maxRecords: 4,
  maxDomains: 1,
  maxPageBytes: 256,
  maxBindings: 1,
  maxEventsPerSample: 1,
};
const dynamicLayout = deriveMaterialDynamicInputLayout(dynamicSchema).unwrap();
const surfaceReceipt = {
  ...createStandardPbrArtifactReceipt(),
  surface: {
    model: 'single-layer-medium' as const,
    module: 'forgeax::single-layer-medium',
    inputAbi: 'SingleLayerMediumSurfaceInput',
    outputAbi: 'SingleLayerMediumSurfaceData',
    passes: ['nearest-layer', 'color'] as const,
    dynamicInput: {
      layout: dynamicLayout,
      group: 3,
      binding: 3,
      readOnly: true as const,
      accessor: `read_${dynamicLayout.name}`,
    },
  },
};

function page(pageId: number, strength: number): ReadonlyDynamicInputPage {
  const created = ReadonlyDynamicInputPage.create({
    sourceId: 'surface-buffer-lifecycle',
    pageId,
    schema: dynamicSchema,
  }).unwrap();
  created.writeRecord(0, { strength }).unwrap();
  return created;
}

function destroyCount(device: LifecycleDevice, buffer: Buffer): number {
  return device.destroyCalls.filter((candidate) => candidate === buffer).length;
}

const surfaceInputBuffersKey = 'surfaceInputBuffers';
const dynamicInputPageKey = 'dynamicInputPage';
const dynamicInputPageGenerationKey = 'dynamicInputPageGeneration';

describe('Surface dynamic input GPU buffer lifecycle', () => {
  it('retains A and B through pending fences, drains them once, and keeps failed C replacement valid', async () => {
    const queue = new DeferredQueue();
    const device = createLifecycleDevice(queue);
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const inputs = standardPbrInputs(device, shader, viewLayout);
    const pipelineState = inputs.standardPbrPipelineState;
    const baseArtifact = inputs.standardPbrArtifact;
    expect(pipelineState).toBeDefined();
    expect(baseArtifact).toBeDefined();
    if (pipelineState === undefined || baseArtifact === undefined) return;
    const visibleBuffer = device
      .createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
      .unwrap();
    const probeBlendRecordBuffer = device
      .createBuffer({ size: 4096, usage: GPU_BUFFER_USAGE_STORAGE })
      .unwrap();
    const adapter = MaterialAbiRasterAdapter.create({
      device,
      pipelineState,
      artifact: { ...baseArtifact, receipt: surfaceReceipt },
      visibleBuffer,
      probeBlendRecordBuffer,
    }).unwrap();
    const allocationAtCreate = adapter.resourceAllocation;
    expect(allocationAtCreate).toMatchObject({
      unit: 'engine-allocation-bytes',
      physicalResidency: 'unknown',
      liveBytes: expect.any(Number),
      peakBytes: expect.any(Number),
      pendingRetirementBytes: 0,
      pendingRetirementCount: 0,
      failedAllocationRollbacks: 0,
    });
    expect(allocationAtCreate.liveBytes).toBeGreaterThan(0);
    expect(allocationAtCreate.peakBytes).toBeGreaterThanOrEqual(allocationAtCreate.liveBytes);
    const emptyFrameRanges: readonly [] = [];
    const prepare = (inputPage: ReadonlyDynamicInputPage): void => {
      const prepared = adapter.ensureSurfaceDynamicInput(
        {
          page: inputPage,
          ranges: [],
          projectionRevision: 1,
          frameTime: 0,
        },
        1,
        0,
        dynamicLayout,
        1,
        emptyFrameRanges,
      );
      expect(prepared).toMatchObject({ ok: true });
      expect(adapter.commitSurfaceDynamicInput()).toMatchObject({ ok: true });
    };

    const initial = adapter.surfaceDynamicInputBuffer;
    const pageA = page(1, 1);
    prepare(pageA);
    const bufferA = adapter.surfaceDynamicInputBuffer;
    expect(bufferA).not.toBe(initial);
    expect(device.bookkeeper.isDestroyed(initial)).toBe(false);
    const allocationAfterPageA = adapter.resourceAllocation;
    expect(allocationAfterPageA.successfulAllocationCount).toBeGreaterThan(
      allocationAtCreate.successfulAllocationCount,
    );
    expect(allocationAfterPageA.liveBytes).toBeGreaterThan(allocationAtCreate.liveBytes);
    expect(allocationAfterPageA.peakBytes).toBeGreaterThanOrEqual(allocationAfterPageA.liveBytes);

    const surfaceBuffers = adapter[surfaceInputBuffersKey];
    const pageAState = {
      buffer: adapter.surfaceDynamicInputBuffer,
      bindGroup: adapter.instancesFrameGroup,
      page: adapter[dynamicInputPageKey],
      pageGeneration: adapter[dynamicInputPageGenerationKey],
      bufferSize: adapter.surfaceDynamicInputBufferSize,
      contentRevision: pageA.contentRevision,
      bufferGeneration: pageA.bufferGeneration,
      deviceGeneration: pageA.deviceGeneration,
      uploadedRevision: pageA.uploadedRevision,
      lastUploadedBytes: pageA.lastUploadedBytes,
    };
    const pageB = page(2, 2);
    const buffersBeforeFailure = device.createdBuffers.length;
    device.failNextBindGroup = true;
    const failedBindGroupReplacement = adapter.ensureSurfaceDynamicInput(
      { page: pageB, ranges: [], projectionRevision: 1, frameTime: 0 },
      1,
      0,
      dynamicLayout,
      1,
      emptyFrameRanges,
    );
    expect(failedBindGroupReplacement).toMatchObject({
      ok: false,
      error: {
        code: 'rhi-descriptor-invalid',
        expected: 'the candidate Surface bind group rebuild succeeds',
      },
    });
    expect(device.failNextBindGroup).toBe(false);
    expect(device.createdBuffers).toHaveLength(buffersBeforeFailure + 1);
    const failedBindGroupCandidate = device.createdBuffers.at(-1);
    expect(failedBindGroupCandidate).toBeDefined();
    if (failedBindGroupCandidate !== undefined) {
      expect(queue.writtenBuffers).toContain(failedBindGroupCandidate);
      expect(destroyCount(device, failedBindGroupCandidate)).toBe(1);
      expect(surfaceBuffers.has(failedBindGroupCandidate)).toBe(false);
      expect(device.bookkeeper.isDestroyed(failedBindGroupCandidate)).toBe(true);
    }
    const allocationAfterBindFailure = adapter.resourceAllocation;
    expect(allocationAfterBindFailure.liveBytes).toBe(allocationAfterPageA.liveBytes);
    expect(allocationAfterBindFailure.failedAllocationRollbacks).toBeGreaterThanOrEqual(1);
    expect(allocationAfterBindFailure.failedAllocationRollbackBytes).toBeGreaterThan(0);
    expect(adapter.surfaceDynamicInputBuffer).toBe(pageAState.buffer);
    expect(adapter.instancesFrameGroup).toBe(pageAState.bindGroup);
    expect(adapter[dynamicInputPageKey]).toBe(pageAState.page);
    expect(adapter[dynamicInputPageGenerationKey]).toBe(pageAState.pageGeneration);
    expect(adapter.surfaceDynamicInputBufferSize).toBe(pageAState.bufferSize);
    expect(pageA).toMatchObject({
      contentRevision: pageAState.contentRevision,
      bufferGeneration: pageAState.bufferGeneration,
      deviceGeneration: pageAState.deviceGeneration,
      uploadedRevision: pageAState.uploadedRevision,
      lastUploadedBytes: pageAState.lastUploadedBytes,
    });
    expect(pageB.uploadedRevision).toBe(0);
    expect(device.bookkeeper.isDestroyed(bufferA)).toBe(false);

    prepare(pageB);
    const bufferB = adapter.surfaceDynamicInputBuffer;
    expect(bufferB).not.toBe(bufferA);
    expect(adapter[dynamicInputPageKey]).toBe(pageB);
    expect(adapter[dynamicInputPageGenerationKey]).toBe(pageB.bufferGeneration);
    expect(device.bookkeeper.isDestroyed(initial)).toBe(false);
    expect(device.bookkeeper.isDestroyed(bufferA)).toBe(false);
    const allocationWithPendingPages = adapter.resourceAllocation;
    expect(allocationWithPendingPages.pendingRetirementCount).toBeGreaterThan(0);
    expect(allocationWithPendingPages.pendingRetirementBytes).toBeGreaterThan(0);
    expect(allocationWithPendingPages.peakBytes).toBeGreaterThanOrEqual(
      allocationWithPendingPages.liveBytes + allocationWithPendingPages.pendingRetirementBytes,
    );
    await queue.drain();
    expect(destroyCount(device, initial)).toBe(1);
    expect(destroyCount(device, bufferA)).toBe(1);
    expect(adapter.surfaceDynamicInputBuffer).toBe(bufferB);
    expect(surfaceBuffers.has(bufferA)).toBe(false);
    expect(pageB.uploadedRevision).toBe(pageB.contentRevision);
    const allocationAfterFirstFence = adapter.resourceAllocation;
    expect(allocationAfterFirstFence.pendingRetirementBytes).toBe(0);
    expect(allocationAfterFirstFence.pendingRetirementCount).toBe(0);
    expect(allocationAfterFirstFence.retiredBytes).toBeGreaterThan(0);

    const pageC = page(3, 3);
    prepare(pageC);
    const bufferC = adapter.surfaceDynamicInputBuffer;
    expect(bufferC).not.toBe(bufferB);
    expect(device.bookkeeper.isDestroyed(initial)).toBe(true);
    expect(device.bookkeeper.isDestroyed(bufferA)).toBe(true);
    expect(device.bookkeeper.isDestroyed(bufferB)).toBe(false);

    await queue.drain();
    expect(destroyCount(device, initial)).toBe(1);
    expect(destroyCount(device, bufferB)).toBe(1);
    expect(surfaceBuffers.has(initial)).toBe(false);
    expect(surfaceBuffers.has(bufferA)).toBe(false);
    expect(surfaceBuffers.has(bufferB)).toBe(false);

    const pageD = page(4, 4);
    prepare(pageD);
    const bufferD = adapter.surfaceDynamicInputBuffer;
    const allocationBeforeWriteFailure = adapter.resourceAllocation;
    await queue.drain();
    expect(destroyCount(device, bufferC)).toBe(1);
    expect(surfaceBuffers.has(bufferC)).toBe(false);

    pageD.writeRecord(0, { strength: 5 }).unwrap();
    queue.failNextWrite = true;
    const failedStableWrite = adapter.ensureSurfaceDynamicInput(
      { page: pageD, ranges: [], projectionRevision: 1, frameTime: 0 },
      1,
      0,
      dynamicLayout,
      1,
      emptyFrameRanges,
    );
    expect(failedStableWrite).toMatchObject({ ok: false });
    expect(adapter.surfaceDynamicInputBuffer).toBe(bufferD);
    expect(device.bookkeeper.isDestroyed(bufferD)).toBe(false);
    expect(pageD.uploadedRevision).toBeLessThan(pageD.contentRevision);
    prepare(pageD);

    const pageE = page(5, 5);
    const candidateBeforeFailure = device.createdBuffers.at(-1);
    expect(candidateBeforeFailure).toBeDefined();
    queue.failNextWrite = true;
    const failedReplacement = adapter.ensureSurfaceDynamicInput(
      { page: pageE, ranges: [], projectionRevision: 1, frameTime: 0 },
      1,
      0,
      dynamicLayout,
      1,
      emptyFrameRanges,
    );
    expect(failedReplacement).toMatchObject({ ok: false });
    expect(adapter.surfaceDynamicInputBuffer).toBe(bufferD);
    expect(device.bookkeeper.isDestroyed(bufferD)).toBe(false);
    const failedCandidate = device.createdBuffers.at(-1);
    expect(failedCandidate).toBeDefined();
    if (failedCandidate !== undefined) expect(destroyCount(device, failedCandidate)).toBe(1);
    const allocationAfterWriteFailure = adapter.resourceAllocation;
    expect(allocationAfterWriteFailure.liveBytes).toBe(allocationBeforeWriteFailure.liveBytes);
    expect(allocationAfterWriteFailure.failedAllocationRollbacks).toBeGreaterThanOrEqual(
      allocationAfterBindFailure.failedAllocationRollbacks + 1,
    );
    expect(allocationAfterWriteFailure.failedAllocationRollbackBytes).toBeGreaterThan(
      allocationAfterBindFailure.failedAllocationRollbackBytes,
    );

    const callsBeforeDispose = device.destroyCalls.length;
    adapter.dispose();
    const callsAfterFirstDispose = device.destroyCalls.length;
    adapter.dispose();
    expect(callsAfterFirstDispose).toBeGreaterThan(callsBeforeDispose);
    expect(device.destroyCalls.length).toBe(callsAfterFirstDispose);
    expect(adapter.resourceAllocation).toMatchObject({
      liveBytes: 0,
      pendingRetirementBytes: 0,
      pendingRetirementCount: 0,
    });
    for (const buffer of [initial, bufferA, bufferB, bufferC, bufferD]) {
      expect(destroyCount(device, buffer)).toBe(1);
    }
  });

  it('binds the producer Probe buffer for non-zero offsets and rejects an unmatched offset', async () => {
    const queue = new DeferredQueue();
    const device = createLifecycleDevice(queue);
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const viewLayout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const inputs = standardPbrInputs(device, shader, viewLayout);
    const pipelineState =
      inputs.standardPbrPipelineState === undefined
        ? undefined
        : {
            ...inputs.standardPbrPipelineState,
            surfaceDirectInstancesBindGroupLayout: buildSurfaceDirectInstancesBindGroupLayout(
              device,
              { storageBuffer: true },
            ),
          };
    const baseArtifact = inputs.standardPbrArtifact;
    expect(pipelineState).toBeDefined();
    expect(baseArtifact).toBeDefined();
    if (pipelineState === undefined || baseArtifact === undefined) return;
    const visibleBuffer = device
      .createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
      .unwrap();
    const probeBuffer = device
      .createBuffer({ size: 4096, usage: GPU_BUFFER_USAGE_STORAGE })
      .unwrap();
    const adapter = MaterialAbiRasterAdapter.create({
      device,
      pipelineState,
      artifact: { ...baseArtifact, receipt: surfaceReceipt },
      visibleBuffer,
      probeBlendRecordBuffer: probeBuffer,
    }).unwrap();
    const inputPage = page(11, 11);
    const directMember = [
      {
        frameIndex: 0,
        directMember: { worldId: 7, entityKey: 8, drawItemIndex: 9, instanceOrdinal: 0 },
      },
    ] as const;
    expect(
      adapter.ensureSurfaceDynamicInput(
        { page: inputPage, ranges: [], projectionRevision: 1, frameTime: 0 },
        1,
        0,
        dynamicLayout,
        1,
        directMember,
      ),
    ).toMatchObject({ ok: true });
    expect(adapter.commitSurfaceDynamicInput()).toMatchObject({ ok: true });
    const instanceBuffer = device
      .createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
      .unwrap();
    const bindGroupsBeforeDraw = device.bindGroupDescriptors.length;
    const resolved = adapter.directSurfaceInstances({
      worldId: 7,
      entityKey: 8,
      drawItemIndex: 9,
      instanceCount: 1,
      instanceBuffer,
      probeBuffer,
      probeOffset: 2304,
    });
    expect(resolved).toMatchObject({ ok: true, value: { dynamicOffsets: [2304] } });
    expect(device.bindGroupDescriptors).toHaveLength(bindGroupsBeforeDraw + 1);
    const descriptor = device.bindGroupDescriptors.at(-1);
    expect(descriptor?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: 1,
          resource: expect.objectContaining({
            value: expect.objectContaining({ buffer: probeBuffer }),
          }),
        }),
      ]),
    );
    const noProbeAdapter = MaterialAbiRasterAdapter.create({
      device,
      pipelineState,
      artifact: baseArtifact,
      visibleBuffer,
    }).unwrap();
    expect(
      noProbeAdapter.ensureSurfaceDynamicInput(
        { page: inputPage, ranges: [], projectionRevision: 1, frameTime: 0 },
        1,
        0,
        dynamicLayout,
        1,
        directMember,
      ),
    ).toMatchObject({ ok: true });
    expect(noProbeAdapter.commitSurfaceDynamicInput()).toMatchObject({ ok: true });
    const bindGroupsBeforeMissing = device.bindGroupDescriptors.length;
    const missingProbe = noProbeAdapter.directSurfaceInstances({
      worldId: 7,
      entityKey: 8,
      drawItemIndex: 9,
      instanceCount: 1,
      instanceBuffer,
      probeOffset: 2304,
    });
    expect(missingProbe).toMatchObject({
      ok: false,
      error: {
        code: 'rhi-descriptor-invalid',
        expected: 'a non-zero direct Surface Probe offset has its matched producer Probe buffer',
      },
    });
    expect(device.bindGroupDescriptors).toHaveLength(bindGroupsBeforeMissing);
    adapter.dispose();
    noProbeAdapter.dispose();
  });
});
