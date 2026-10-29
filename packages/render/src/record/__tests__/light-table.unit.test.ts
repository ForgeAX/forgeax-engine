import type { Buffer } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_STORAGE } from '../../gpu-usage';
import { BYTES_PER_DIRECT_LIGHT_SLOT, type DirectLightSnapshot } from '../../light-buffer-layout';
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
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const buffer = device
    .createBuffer({
      label: 'light-table-test',
      size: 64 * BYTES_PER_DIRECT_LIGHT_SLOT,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    })
    .unwrap() as Buffer;
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  return { owner: new LightTable(device, buffer), writes };
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
    expect(owner.uploadedBytes).toBe(32 * BYTES_PER_DIRECT_LIGHT_SLOT);
    expect(writes).toHaveBeenCalledTimes(1);

    writes.mockClear();
    for (let frame = 0; frame < 3; frame += 1) {
      owner.write(lights, undefined).unwrap();
      expect(owner.uploadedBytes).toBe(0);
    }
    expect(writes).not.toHaveBeenCalled();

    // The light owner replaces only the moved light's record.
    const moved = lights.map((light, index) => (index === 17 ? { source: point(99) } : light));
    owner.write(moved, undefined).unwrap();
    expect(owner.uploadedBytes).toBe(BYTES_PER_DIRECT_LIGHT_SLOT);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]?.[1]).toBe(17 * BYTES_PER_DIRECT_LIGHT_SLOT);

    // A new record with identical bytes writes nothing.
    writes.mockClear();
    owner
      .write(
        moved.map((light, index) => (index === 3 ? { source: point(3) } : light)),
        undefined,
      )
      .unwrap();
    expect(writes).not.toHaveBeenCalled();
  });

  it('rewrites the two slots whose projector selection moved', async () => {
    const { owner, writes } = await table();
    const lights = Array.from({ length: 8 }, (_, index) => ({ source: spot(index) }));
    owner.write(lights, 2).unwrap();
    writes.mockClear();
    owner.write(lights, 5).unwrap();
    const offsets = writes.mock.calls.map((call) => call[1]);
    expect(offsets).toEqual([2 * BYTES_PER_DIRECT_LIGHT_SLOT, 5 * BYTES_PER_DIRECT_LIGHT_SLOT]);
    expect(owner.uploadedBytes).toBe(2 * BYTES_PER_DIRECT_LIGHT_SLOT);
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
    expect(owner.uploadedBytes).toBe(3 * BYTES_PER_DIRECT_LIGHT_SLOT);
  });
});
