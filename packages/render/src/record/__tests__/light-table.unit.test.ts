import { type Buffer, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { STANDARD_CLUSTER_TEST_ABI } from '../../__tests__/cluster-test-abi';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_STORAGE } from '../../gpu-usage';
import type { DirectLightSnapshot } from '../../light-buffer-layout';
import { LightTable } from '../light-table';

function point(x: number): DirectLightSnapshot {
  return {
    kind: 'point',
    position: new Float32Array([x, 1, 0]),
    color: new Float32Array([1, 1, 1]),
    intensity: 1,
    invRangeSquared: 0.01,
  } as unknown as DirectLightSnapshot;
}

async function table() {
  const slotBytes = STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize;
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const buffer = device
    .createBuffer({
      label: 'light-table-test',
      size: 64 * slotBytes,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    })
    .unwrap() as Buffer;
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  return {
    owner: new LightTable(device, buffer, STANDARD_CLUSTER_TEST_ABI.directLightSlot),
    writes,
  };
}

function spot(x: number): DirectLightSnapshot {
  return {
    kind: 'spot',
    position: new Float32Array([x, 1, 0]),
    color: new Float32Array([1, 1, 1]),
    direction: new Float32Array([0, -1, 0]),
    intensity: 1,
    invRangeSquared: 0.01,
    cosInner: 0.9,
    cosOuter: 0.8,
    shadowAtlasTile: -1,
  } as unknown as DirectLightSnapshot;
}

describe('LightTable', () => {
  it('uploads nothing on steady frames and one record when one light changes', async () => {
    const { owner, writes } = await table();
    const lights = Array.from({ length: 32 }, (_, index) => ({ source: point(index) }));
    owner.write(lights, undefined).unwrap();
    expect(owner.uploadedBytes).toBe(32 * STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize);
    const coldInspection = owner.inspect();
    expect(Object.isFrozen(coldInspection)).toBe(true);
    expect(coldInspection).toEqual({
      packedSlots: 32,
      uploadedBytes: 32 * STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize,
    });
    expect(writes).toHaveBeenCalledTimes(1);

    writes.mockClear();
    for (let frame = 0; frame < 3; frame += 1) {
      owner.write(lights, undefined).unwrap();
      expect(owner.uploadedBytes).toBe(0);
      expect(owner.inspect()).toEqual({ packedSlots: 0, uploadedBytes: 0 });
    }
    expect(writes).not.toHaveBeenCalled();

    // The light owner replaces only the moved light's record.
    const moved = lights.map((light, index) => (index === 17 ? { source: point(99) } : light));
    owner.write(moved, undefined).unwrap();
    expect(owner.uploadedBytes).toBe(STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize);
    expect(owner.inspect()).toEqual({
      packedSlots: 1,
      uploadedBytes: STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize,
    });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]?.[1]).toBe(17 * STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize);

    // A new record with identical bytes writes nothing.
    writes.mockClear();
    owner
      .write(
        moved.map((light, index) => (index === 3 ? { source: point(3) } : light)),
        undefined,
      )
      .unwrap();
    expect(writes).not.toHaveBeenCalled();
    expect(owner.inspect()).toEqual({ packedSlots: 1, uploadedBytes: 0 });
  });

  it('counts changed-identity packing even when bytes match, and retries failed writes', async () => {
    const { owner, writes } = await table();
    const original = [{ source: point(4) }];
    owner.write(original, undefined).unwrap();
    expect(owner.inspect()).toEqual({
      packedSlots: 1,
      uploadedBytes: STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize,
    });

    const identicalBytes = [{ source: point(4) }];
    owner.write(identicalBytes, undefined).unwrap();
    expect(owner.inspect()).toEqual({ packedSlots: 1, uploadedBytes: 0 });
    expect(writes).toHaveBeenCalledTimes(1);

    const changedBytes = [{ source: point(8) }];
    writes.mockReturnValueOnce(
      err(
        new RhiError({
          code: 'device-lost',
          expected: 'light table upload succeeds',
          hint: 'restore the device and retry',
        }),
      ),
    );
    const failed = owner.write(changedBytes, undefined);
    expect(failed.ok).toBe(false);
    expect(owner.inspect()).toEqual({ packedSlots: 1, uploadedBytes: 0 });

    owner.write(changedBytes, undefined).unwrap();
    expect(owner.inspect()).toEqual({
      packedSlots: 1,
      uploadedBytes: STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize,
    });
    expect(writes).toHaveBeenCalledTimes(3);
  });

  it('retains bytes accepted by an earlier disjoint range when a later range fails', async () => {
    const { owner, writes } = await table();
    const original = [{ source: point(0) }, { source: point(1) }, { source: point(2) }];
    owner.write(original, undefined).unwrap();
    writes.mockClear();
    writes.mockReturnValueOnce(ok(undefined));
    writes.mockReturnValueOnce(
      err(
        new RhiError({
          code: 'device-lost',
          expected: 'the later disjoint light range succeeds',
          hint: 'restore the device and retry the incomplete light range',
        }),
      ),
    );
    const unchanged = original[1];
    if (unchanged === undefined) throw new Error('Expected middle light to remain unchanged');

    const failed = owner.write(
      [{ source: point(10) }, unchanged, { source: point(20) }],
      undefined,
    );
    expect(failed.ok).toBe(false);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(writes.mock.calls.map((call) => call[1])).toEqual([
      0,
      2 * STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize,
    ]);
    expect(owner.inspect()).toEqual({
      packedSlots: 2,
      uploadedBytes: STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize,
    });
  });

  it('rewrites the two slots whose projector selection moved', async () => {
    const { owner, writes } = await table();
    const lights = Array.from({ length: 8 }, (_, index) => ({ source: spot(index) }));
    owner.write(lights, 2).unwrap();
    writes.mockClear();
    owner.write(lights, 5).unwrap();
    const offsets = writes.mock.calls.map((call) => call[1]);
    expect(offsets).toEqual([
      2 * STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize,
      5 * STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize,
    ]);
    expect(owner.uploadedBytes).toBe(2 * STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize);
  });

  it('coalesces neighbouring changed slots into one range', async () => {
    const { owner, writes } = await table();
    const lights = Array.from({ length: 8 }, (_, index) => ({ source: point(index) }));
    owner.write(lights, undefined).unwrap();
    writes.mockClear();
    const changed = lights.map((light, index) =>
      index >= 3 && index <= 5 ? { source: point(index + 50) } : light,
    );
    owner.write(changed, undefined).unwrap();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(owner.uploadedBytes).toBe(3 * STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize);
  });
});
