import { expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { runtimeAssets } from '../internal';

it('retains merged range evidence with exact versions and drops it with their leases', () => {
  const assets = new AssetRegistry();
  const handle = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 8, height: 8 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array(256),
    })
    .unwrap();
  const records = runtimeAssets(assets),
    first = records.pin(handle).unwrap();
  assets
    .writeRange(handle, {
      origin: { x: 1, y: 2 },
      size: { width: 2, height: 1 },
      data: new Uint8Array(8).fill(3),
    })
    .unwrap();
  assets
    .writeRange(handle, {
      origin: { x: 3, y: 2 },
      size: { width: 1, height: 1 },
      data: new Uint8Array(4).fill(7),
    })
    .unwrap();
  const second = records.pin(handle).unwrap();
  expect(second.delta).toMatchObject({
    from: first.revision,
    fields: [],
    ranges: [
      { path: ['data'], byteOffset: 68, byteLength: 8 },
      { path: ['data'], byteOffset: 76, byteLength: 4 },
    ],
  });
  const held = second.retain();
  second.dispose();
  first.dispose();
  expect(records.inspect().snapshots).toBe(1);
  assets.update(handle, { data: new Uint8Array(256).fill(9) }).unwrap();
  const third = records.pin(handle).unwrap();
  expect(third.delta).toMatchObject({ from: held.revision, fields: ['data'] });
  held.dispose();
  third.dispose();
  expect(records.inspect().snapshots).toBe(0);
  const latest = records.pin(handle).unwrap();
  expect(latest.delta).toBeUndefined();
  latest.dispose();
  assets.dispose();
});

it('keeps range evidence when pin admission fails and later retries after more writes', () => {
  const assets = new AssetRegistry({ limits: { maxSnapshots: 2 } });
  const value = {
    kind: 'texture' as const,
    shape: { viewDimension: '2d' as const, extent: { width: 8, height: 8 } },
    format: 'rgba8unorm' as const,
    colorSpace: 'linear' as const,
    mips: { kind: 'none' as const },
    data: new Uint8Array(256),
  };
  const handle = assets.create(value).unwrap(),
    other = assets.create(value).unwrap(),
    records = runtimeAssets(assets);
  const first = records.pin(handle).unwrap(),
    blocker = records.pin(other).unwrap();
  assets
    .writeRange(handle, {
      origin: { x: 1, y: 0 },
      size: { width: 1, height: 1 },
      data: new Uint8Array(4).fill(3),
    })
    .unwrap();
  expect(records.pin(handle)).toMatchObject({
    ok: false,
    error: { code: 'asset-budget-exceeded' },
  });
  blocker.dispose();
  assets
    .writeRange(handle, {
      origin: { x: 4, y: 0 },
      size: { width: 1, height: 1 },
      data: new Uint8Array(4).fill(9),
    })
    .unwrap();
  const next = records.pin(handle).unwrap();
  expect(next.delta).toMatchObject({
    from: first.revision,
    fields: [],
    ranges: [
      { byteOffset: 4, byteLength: 4 },
      { byteOffset: 16, byteLength: 4 },
    ],
  });
  next.dispose();
  first.dispose();
  expect(records.inspect().snapshots).toBe(0);
  assets.dispose();
});
