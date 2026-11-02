import type { Texture } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { STANDARD_CLUSTER_TEST_ABI } from '../../__tests__/cluster-test-abi';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../../gpu-texture-usage';
import type { DirectLightSnapshot } from '../../light-buffer-layout';
import { createStandardClusterLayout } from '../../pipeline/standard-lighting/layout';
import { standardClusterTextureLayout } from '../../pipeline/standard-lighting/texture';
import { ClusterTextureTable } from '../cluster-texture-table';
import {
  type ClusterWorkConformanceState,
  captureClusterWorkSample,
  readClusterWorkObservation,
} from '../cluster-work-conformance';

function point(x: number): DirectLightSnapshot {
  return {
    kind: 'point',
    position: new Float32Array([x, 1, 0]),
    color: new Float32Array([1, 1, 1]),
    intensity: 1,
    invRangeSquared: 0.01,
  } as unknown as DirectLightSnapshot;
}

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const layout = standardClusterTextureLayout(
    createStandardClusterLayout(STANDARD_CLUSTER_TEST_ABI.directLightSlot.capacity, {
      x: 1,
      y: 1,
      z: 1,
    }),
    STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize,
    { width: 8, height: 2 },
  );
  const texture = device
    .createTexture({
      label: 'cluster-texture-table-test',
      size: { width: layout.width, height: layout.height, depthOrArrayLayers: 1 },
      format: 'rgba32uint',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap() as Texture;
  const writeTexture = vi.spyOn(device.queue, 'writeTexture');
  const table = new ClusterTextureTable(layout.width, layout.height, 4);
  return { device, layout, table, texture, writeTexture };
}

describe('ClusterTextureTable', () => {
  it('packs and uploads only changed host rows after the initial write', async () => {
    const { device, layout, table, texture, writeTexture } = await fixture();
    const local = [{ source: point(1) }, { source: point(2) }];
    const clusterGrid = new Uint32Array([2, 2]);
    const lightIndices = new Uint32Array([0, 1]);
    const expectedUsedRows = Math.ceil(
      (layout.indexOffset + lightIndices.length) / (layout.width * 4),
    );
    const expectedRowBytes = layout.width * 16;
    const write = (lights = local, grid = clusterGrid) =>
      table.write({
        device,
        texture,
        layout,
        local: lights,
        projectorSlot: undefined,
        clusterGrid: grid,
        lightIndices,
        lightIndexCount: lightIndices.length,
        slotLayout: STANDARD_CLUSTER_TEST_ABI.directLightSlot,
      });

    expect(write().ok).toBe(true);
    const coldInspection = table.inspect();
    expect(Object.isFrozen(coldInspection)).toBe(true);
    expect(coldInspection).toEqual({
      packedLightSlots: 2,
      uploadedBytes: 2 * layout.width * 16,
      usedRows: expectedUsedRows,
      rowBytes: expectedRowBytes,
    });
    expect(writeTexture).toHaveBeenCalledTimes(1);
    expect(writeTexture.mock.calls[0]?.[3]).toEqual({
      width: layout.width,
      height: 2,
      depthOrArrayLayers: 1,
    });
    expect(writeTexture.mock.calls[0]?.[0]).toMatchObject({ origin: { x: 0, y: 0, z: 0 } });

    writeTexture.mockClear();
    expect(write().ok).toBe(true);
    expect(table.inspect()).toEqual({
      packedLightSlots: 0,
      uploadedBytes: 0,
      usedRows: expectedUsedRows,
      rowBytes: expectedRowBytes,
    });
    expect(writeTexture).not.toHaveBeenCalled();

    const firstLight = local[0];
    if (firstLight === undefined) throw new Error('Expected first local light');
    const moved = [firstLight, { source: point(20) }];
    expect(write(moved).ok).toBe(true);
    expect(table.inspect()).toEqual({
      packedLightSlots: 1,
      uploadedBytes: layout.width * 16,
      usedRows: expectedUsedRows,
      rowBytes: expectedRowBytes,
    });
    expect(writeTexture).toHaveBeenCalledTimes(1);
    expect(writeTexture.mock.calls[0]?.[3]).toEqual({
      width: layout.width,
      height: 1,
      depthOrArrayLayers: 1,
    });
    expect(writeTexture.mock.calls[0]?.[0]).toMatchObject({ origin: { x: 0, y: 0, z: 0 } });

    writeTexture.mockClear();
    const changedGrid = new Uint32Array([3, 2]);
    expect(write(moved, changedGrid).ok).toBe(true);
    expect(table.inspect()).toEqual({
      packedLightSlots: 0,
      uploadedBytes: layout.width * 16,
      usedRows: expectedUsedRows,
      rowBytes: expectedRowBytes,
    });
    expect(writeTexture).toHaveBeenCalledTimes(1);
  });

  it('retries the complete host region after a failed texture write', async () => {
    const { device, layout, table, texture, writeTexture } = await fixture();
    const local = [{ source: point(1) }];
    const clusterGrid = new Uint32Array([1, 1]);
    const lightIndices = new Uint32Array([0]);
    const expectedUsedRows = Math.ceil(
      (layout.indexOffset + lightIndices.length) / (layout.width * 4),
    );
    const expectedRowBytes = layout.width * 16;
    const write = () =>
      table.write({
        device,
        texture,
        layout,
        local,
        projectorSlot: undefined,
        clusterGrid,
        lightIndices,
        lightIndexCount: lightIndices.length,
        slotLayout: STANDARD_CLUSTER_TEST_ABI.directLightSlot,
      });

    writeTexture.mockReturnValueOnce(
      err(
        new RhiError({
          code: 'device-lost',
          expected: 'Cluster texture upload succeeds',
          hint: 'restore the device and retry',
        }),
      ),
    );
    expect(write().ok).toBe(false);
    expect(write().ok).toBe(true);
    expect(table.inspect()).toEqual({
      packedLightSlots: 0,
      uploadedBytes: 2 * layout.width * 16,
      usedRows: expectedUsedRows,
      rowBytes: expectedRowBytes,
    });
    expect(writeTexture).toHaveBeenCalledTimes(2);
  });

  it('reports bytes accepted before a later dirty row fails', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const layout = {
      width: 1,
      height: 3,
      gridOffset: 0,
      indexOffset: 12,
    } as unknown as ReturnType<typeof standardClusterTextureLayout>;
    const texture = device
      .createTexture({
        label: 'cluster-texture-partial-write-test',
        size: { width: layout.width, height: layout.height, depthOrArrayLayers: 1 },
        format: 'rgba32uint',
        usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      })
      .unwrap() as Texture;
    const table = new ClusterTextureTable(layout.width, layout.height, 0);
    const writeTexture = vi.spyOn(device.queue, 'writeTexture');
    const write = (clusterGrid: Uint32Array) =>
      table.write({
        device,
        texture,
        layout,
        local: [],
        projectorSlot: undefined,
        clusterGrid,
        lightIndices: new Uint32Array(),
        lightIndexCount: 0,
        slotLayout: STANDARD_CLUSTER_TEST_ABI.directLightSlot,
      });

    const initial = write(new Uint32Array([1, 0, 0, 0, 0, 0, 0, 0, 1]));
    expect(initial.ok).toBe(true);
    writeTexture.mockClear();
    writeTexture.mockReturnValueOnce(ok(undefined));
    writeTexture.mockReturnValueOnce(
      err(
        new RhiError({
          code: 'device-lost',
          expected: 'the later dirty Cluster row upload succeeds',
          hint: 'restore the device and retry the complete host region',
        }),
      ),
    );

    const partial = write(new Uint32Array([2, 0, 0, 0, 0, 0, 0, 0, 2]));
    expect(partial.ok).toBe(false);
    expect(writeTexture).toHaveBeenCalledTimes(2);
    expect(writeTexture.mock.calls[0]?.[0]).toMatchObject({ origin: { x: 0, y: 0, z: 0 } });
    expect(writeTexture.mock.calls[1]?.[0]).toMatchObject({ origin: { x: 0, y: 2, z: 0 } });
    expect(table.inspect()).toEqual({
      packedLightSlots: 0,
      uploadedBytes: 16,
      usedRows: 3,
      rowBytes: 16,
    });

    const conformance: ClusterWorkConformanceState = { enabled: true };
    captureClusterWorkSample(conformance, {
      frameNumber: 4,
      viewEntityKey: 9,
      deviceGeneration: 2,
      graphGeneration: 7,
      clusterTransportGeneration: 3,
      clusterUsedRows: table.inspect().usedRows,
      clusterRowBytes: table.inspect().rowBytes,
      transport: 'cpu-texture',
      scope: 'cluster-texture-host-regions',
      packedLightSlots: table.inspect().packedLightSlots,
      acceptedWriteBytes: table.inspect().uploadedBytes,
      writeSucceeded: partial.ok,
      ...(!partial.ok ? { errorCode: partial.error.code } : {}),
    });
    expect(readClusterWorkObservation(conformance, 2)).toMatchObject({
      status: 'captured',
      invocations: 1,
      acceptedWriteBytes: 16,
      writeSucceeded: false,
      clusterUsedRows: 3,
      clusterRowBytes: 16,
      errorCode: 'device-lost',
    });
  });
});
