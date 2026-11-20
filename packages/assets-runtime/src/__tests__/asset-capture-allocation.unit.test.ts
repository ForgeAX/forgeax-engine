import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { assetDataBytes, captureAssetDataAllocated } from '../internal/asset-data';
import { AssetRecords } from '../internal/asset-records';

describe('owned capture allocation evidence', () => {
  it('charges new containers while known cloning reuses immutable string leaves', () => {
    const input = { text: 'x'.repeat(8192), child: { flag: true, value: 3 } };
    const captured = captureAssetDataAllocated(input, 'copy');
    expect(captured.value).not.toBe(input);
    expect(captured.value.child).not.toBe(input.child);
    expect(captured.value.text).toBe(input.text);
    expect(assetDataBytes(captured.value)).toBeGreaterThan(16 * 1024);
    expect(captured.bytes).toBeGreaterThan(0);
    expect(captured.bytes).toBeLessThan(1024);
    expect(captured.reusedBy(captured.value)).toBe(captured.bytes);
    expect(captured.reusedBy({ text: input.text })).toBe(0);
  });

  it('credits only exact private buffer storage carried into the prepared result', () => {
    const input = { bytes: new Uint8Array(2048).fill(7) };
    const captured = captureAssetDataAllocated(input, 'copy');
    expect(captured.value.bytes.buffer).not.toBe(input.bytes.buffer);
    expect(captured.bytes).toBeGreaterThan(2048);
    expect(captured.reusedBy({ other: new DataView(captured.value.bytes.buffer) })).toBe(2048);
    expect(captured.reusedBy({ other: new Uint8Array(2048).fill(7) })).toBe(0);
    expect(captured.reusedBy({ first: captured.value.bytes, second: captured.value.bytes })).toBe(
      2048,
    );
    input.bytes[0] = 9;
    expect(captured.value.bytes[0]).toBe(7);
  });

  it('does not manufacture copying or sharing evidence for a shallow-frozen mutable binary', () => {
    const input = Object.freeze({ bytes: new Uint8Array(2048) });
    const copied = captureAssetDataAllocated(input, 'copy');
    expect(copied.value.bytes).not.toBe(input.bytes);
    expect(copied.bytes).toBeGreaterThanOrEqual(2048);
    const taken = captureAssetDataAllocated(input, 'take');
    expect(taken.value.bytes.buffer).toBe(input.bytes.buffer);
    expect(taken.bytes).toBeLessThan(2048);
    expect(taken.reusedBy(taken.value)).toBe(taken.bytes);
  });

  it('does not deduplicate the full logical bytes of two different accepted records', () => {
    const records = new AssetRecords({ maxBytes: 24 * 1024 });
    const task = records.beginAdoption().unwrap();
    const input = { text: 'x'.repeat(8192) };
    task.adopt('text', input, [], (owned) => ok({ value: { ...owned } })).unwrap();
    expect(task.adopt('text', input)).toMatchObject({
      ok: false,
      error: { code: 'asset-budget-exceeded' },
    });
    while (task.inspect().phase !== 'retired') task.stepRetirement(1).unwrap();
    expect(records.inspect()).toMatchObject({ assets: 0, adoptionBytes: 0 });
  });

  it('never invokes an accessor when inspecting an untrusted preparation result for reuse', () => {
    const records = new AssetRecords();
    const task = records.beginAdoption().unwrap();
    let called = false;
    const result = task.adopt('text', {}, [], () =>
      ok({
        value: {
          get payload() {
            called = true;
            return 'bad';
          },
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'asset-invalid-value' } });
    expect(called).toBe(false);
    while (task.inspect().phase !== 'retired') task.stepRetirement(1).unwrap();
  });
});
