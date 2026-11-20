import { expect, it } from 'vitest';
import { ReadonlyDynamicInputPage } from '../../surface/dynamic-input';
import { captureSurfaceDynamicInput } from '../../surface/frame-source';
import { SurfaceDynamicInputReceiver } from '../dynamic-input';

it('retains a valid page, refreshes device addresses and clears the owned lifetime', () => {
  const source = ReadonlyDynamicInputPage.create({
    sourceId: 'ocean',
    pageId: 2,
    schema: {
      name: 'wake',
      fields: [{ name: 'value', type: 'f32' }],
      maxRecords: 2,
      maxDomains: 1,
      maxPageBytes: 32,
      maxBindings: 1,
      maxEventsPerSample: 2,
    },
  }).unwrap();
  const range = source
    .reserveRange({
      domain: 'wake',
      recordStart: 0,
      recordCount: 1,
      instanceIndex: 0,
      member: { worldIdentity: 'water', entityKey: 7, drawItemIndex: 0, instanceOrdinal: 0 },
    })
    .unwrap();
  const owner = new SurfaceDynamicInputReceiver();
  const capture = (revision = 1) =>
    captureSurfaceDynamicInput({
      page: source,
      ranges: [range],
      projectionRevision: revision,
      frameTime: 1,
    }).unwrap();
  try {
    source.writeRecord(0, { value: 1 }).unwrap();
    const first = owner.restore(capture(), 1).unwrap();
    assert(first);
    const firstRange = first.ranges?.[0];
    assert(firstRange);
    source.writeRecord(1, { value: 2 }).unwrap();
    const next = owner.restore(capture(), 1).unwrap();
    assert(next);
    expect(next.page).toBe(first.page);
    expect(next.ranges).toBe(first.ranges);
    const malformed = capture();
    malformed.page.bytes.fill(255);
    expect(owner.restore(malformed, 1).ok).toBe(false);
    expect(new DataView(first.page.bytes.buffer).getFloat32(16, true)).toBe(2);
    const moved = capture();
    const movedRange = moved.ranges?.[0];
    assert(movedRange);
    Reflect.set(movedRange.member, 'entityKey', 9);
    expect(owner.restore(moved, 1)).toMatchObject({ ok: false, error: { code: 'invalid-record' } });
    const unversioned = capture(2);
    unversioned.page.bytes[0] = 1;
    expect(owner.restore(unversioned, 1)).toMatchObject({
      ok: false,
      error: { code: 'invalid-record' },
    });
    const recovered = owner.restore(capture(), 8).unwrap();
    assert(recovered);
    expect(recovered.page).toBe(first.page);
    expect(recovered.ranges).not.toBe(first.ranges);
    const recoveredRange = recovered.ranges?.[0];
    assert(recoveredRange);
    expect(recoveredRange.deviceGeneration).toBe(8);
    recovered.page.upload().unwrap();
    expect(recovered.page.consume(firstRange, 2).ok).toBe(false);
    expect(recovered.page.consume(recoveredRange, 2).ok).toBe(true);
    const remapped = owner.restore(capture(), 8, 'render-source:1').unwrap();
    assert(remapped);
    expect(remapped.ranges?.[0]?.member.worldIdentity).toBe('render-source:1');
    expect(capture().ranges?.[0]?.member.worldIdentity).toBe('water');
    const retained = owner.restore(capture(), 8, 'render-source:1').unwrap();
    expect(retained?.ranges).toBe(remapped.ranges);
    const newSource = owner.restore(capture(), 8, 'render-source:2').unwrap();
    expect(newSource?.ranges?.[0]?.member.worldIdentity).toBe('render-source:2');
    const replaced = owner.restore(capture(2), 8).unwrap();
    assert(replaced);
    expect(replaced.page).not.toBe(first.page);
    expect(first.page.capture().ok).toBe(false);
    expect(owner.restore(undefined, 8).unwrap()).toBeUndefined();
    expect(replaced.page.capture().ok).toBe(false);
    expect(owner.active).toBe(false);
    owner.dispose();
    owner.dispose();
    expect(owner.restore(capture(), 8)).toMatchObject({ ok: false, error: { code: 'released' } });
  } finally {
    owner.dispose();
    source.release().unwrap();
  }
});

import assert from 'node:assert/strict';
