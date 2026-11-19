import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { createGpuSceneTable, writeGpuSceneTable } from '../gpu-scene-tables';

it('uploads a texture table range as a partial first line, full lines and a partial last line', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const width = Math.min(1024, device.limits.maxTextureDimension2D ?? 1024);
  const table = createGpuSceneTable(device, 'texture', 'table', width * 16 * 6).unwrap();
  expect(table.kind).toBe('texture');
  if (table.kind !== 'texture') return;
  const writes: { x: number; y: number; offset: number; width: number; height: number }[] = [];
  vi.spyOn(device.queue, 'writeTexture').mockImplementation((destination, _data, layout, size) => {
    const origin = destination.origin as { x: number; y: number };
    const extent = size as { width: number; height: number };
    writes.push({
      x: origin.x,
      y: origin.y,
      offset: layout.offset ?? 0,
      width: extent.width,
      height: extent.height,
    });
    return { ok: true, value: undefined } as never;
  });
  const source = new ArrayBuffer(width * 16 * 6);
  // Bytes [24, 4 lines + 40): texels 1 .. 4 lines + 2 (exclusive end + 3).
  const written = writeGpuSceneTable(device, table, source, 24, width * 16 * 4 + 16);
  expect(written.unwrap()).toBe((width * 4 + 3 - 1) * 16);
  expect(writes).toEqual([
    { x: 1, y: 0, offset: 16, width: width - 1, height: 1 },
    { x: 0, y: 1, offset: width * 16, width, height: 3 },
    { x: 0, y: 4, offset: width * 64, width: 3, height: 1 },
  ]);
});

it('uploads a range within one line as one write', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const table = createGpuSceneTable(device, 'texture', 'table', 4096).unwrap();
  const spy = vi.spyOn(device.queue, 'writeTexture').mockReturnValue({
    ok: true,
    value: undefined,
  } as never);
  writeGpuSceneTable(device, table, new ArrayBuffer(4096), 32, 32).unwrap();
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]?.[3]).toEqual({ width: 2, height: 1, depthOrArrayLayers: 1 });
});
