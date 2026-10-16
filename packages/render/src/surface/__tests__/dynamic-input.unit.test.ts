import { describe, expect, it } from 'vitest';
import { ReadonlyDynamicInputPage } from '../dynamic-input.js';

const schema = {
  name: 'waterEvents',
  fields: [
    { name: 'position', type: 'vec3<f32>' as const },
    { name: 'time', type: 'f32' as const },
    { name: 'eventId', type: 'u32' as const },
  ],
  maxRecords: 4,
  maxDomains: 2,
  maxPageBytes: 128,
  maxBindings: 1,
  maxEventsPerSample: 8,
};

const member = (instanceOrdinal = 0) => ({
  worldIdentity: 'world-a',
  entityKey: 1,
  drawItemIndex: 0,
  instanceOrdinal,
});

describe('Render read-only dynamic input page', () => {
  it('uploads dirty records and consumes an explicit instance range', () => {
    const created = ReadonlyDynamicInputPage.create({
      sourceId: 'project-water',
      pageId: 7,
      schema,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const page = created.value;
    expect(page.writeRecord(0, { position: [1, 2, 3], time: 4, eventId: 11 })).toMatchObject({
      ok: true,
    });
    const range = page.reserveRange({
      domain: 'river-a',
      recordStart: 0,
      recordCount: 1,
      instanceIndex: 0xffffffff,
      member: member(),
    });
    expect(range.ok).toBe(true);
    if (!range.ok) return;
    expect(page.consume(range.value, 14)).toMatchObject({
      ok: false,
      error: { code: 'not-uploaded' },
    });

    const upload = page.upload();
    expect(upload).toMatchObject({
      ok: true,
      value: {
        contentRevision: 2,
        bufferGeneration: 1,
        bytes: 32,
        ranges: [{ byteStart: 0, byteEnd: 32 }],
      },
    });
    expect(page.consume(range.value, 14)).toMatchObject({
      ok: true,
      value: {
        pageId: 7,
        domain: 'river-a',
        instanceIndex: 0xffffffff,
        frameNumber: 14,
        uploadedRevision: 2,
      },
    });
  });

  it('keeps dirty bytes pending until the owning queue commits the receipt', () => {
    const created = ReadonlyDynamicInputPage.create({ sourceId: 'water', pageId: 8, schema });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const page = created.value;
    expect(page.writeRecord(0, { position: [1, 2, 3], time: 4, eventId: 11 })).toMatchObject({
      ok: true,
    });
    const range = page.reserveRange({
      domain: 'water-surface',
      recordStart: 0,
      recordCount: 1,
      instanceIndex: 3,
      member: member(),
    });
    expect(range.ok).toBe(true);
    if (!range.ok) return;

    const first = page.beginUpload();
    expect(first).toMatchObject({ ok: true, value: { bytes: 32, contentRevision: 2 } });
    expect(page.uploadedRevision).toBe(0);
    expect(page.lastUploadedBytes).toBe(0);
    expect(page.consume(range.value, 21)).toMatchObject({
      ok: false,
      error: { code: 'not-uploaded' },
    });
    if (!first.ok) return;

    // A producer update while the queue write is in flight invalidates only
    // the receipt. The original dirty bytes and the new revision remain
    // available for the retry.
    expect(page.writeRecord(0, { position: [4, 5, 6], time: 7, eventId: 12 })).toMatchObject({
      ok: true,
    });
    expect(page.commitUpload(first.value)).toMatchObject({
      ok: false,
      error: { code: 'stale-generation' },
    });
    expect(page.uploadedRevision).toBe(0);
    const retry = page.beginUpload();
    expect(retry).toMatchObject({ ok: true, value: { bytes: 32, contentRevision: 3 } });
    if (!retry.ok) return;
    expect(page.commitUpload(retry.value)).toMatchObject({ ok: true, value: true });
    expect(page.consume(range.value, 22)).toMatchObject({
      ok: true,
      value: { frameNumber: 22, uploadedRevision: 3 },
    });
  });

  it('bounds domains, preserves page identity across device rebuild, and rejects stale ranges', () => {
    const created = ReadonlyDynamicInputPage.create({ sourceId: 'water', pageId: 1, schema });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const page = created.value;
    expect(
      page.reserveRange({
        domain: 'a',
        recordStart: 0,
        recordCount: 1,
        instanceIndex: 0,
        member: member(),
      }).ok,
    ).toBe(true);
    expect(
      page.reserveRange({
        domain: 'b',
        recordStart: 1,
        recordCount: 1,
        instanceIndex: 1,
        member: member(1),
      }).ok,
    ).toBe(true);
    expect(
      page.reserveRange({
        domain: 'c',
        recordStart: 2,
        recordCount: 1,
        instanceIndex: 2,
        member: member(2),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'domain-overflow' },
    });

    const before = page.reserveRange({
      domain: 'a',
      recordStart: 0,
      recordCount: 1,
      instanceIndex: 9,
      member: member(),
    });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(page.reconfigureDevice(2)).toMatchObject({ ok: true, value: 2 });
    expect(page.consume(before.value, 15)).toMatchObject({
      ok: false,
      error: { code: 'stale-generation' },
    });
    expect(page.upload()).toMatchObject({ ok: true, value: { bytes: 128, deviceGeneration: 2 } });
  });

  it('accepts the renderer initial device generation', () => {
    const page = ReadonlyDynamicInputPage.create({ sourceId: 'water', pageId: 9, schema }).unwrap();
    expect(page.reconfigureDevice(0)).toMatchObject({ ok: true, value: 2 });
    expect(page.deviceGeneration).toBe(0);
  });

  it('rejects a stale device generation without changing page state', () => {
    const page = ReadonlyDynamicInputPage.create({
      sourceId: 'water',
      pageId: 10,
      schema,
    }).unwrap();
    page.writeRecord(0, { position: [1, 2, 3], time: 4, eventId: 11 }).unwrap();
    page.reconfigureDevice(2).unwrap();
    const before = page.beginUpload().unwrap();

    expect(page.reconfigureDevice(1)).toMatchObject({
      ok: false,
      error: { code: 'stale-generation' },
    });
    expect(page.deviceGeneration).toBe(2);
    expect(page.bufferGeneration).toBe(before.bufferGeneration);
    expect(page.contentRevision).toBe(before.contentRevision);
    expect(page.uploadedRevision).toBe(0);
    expect(page.beginUpload()).toEqual({ ok: true, value: before });
  });

  it('keeps invalid records structured and release terminal', () => {
    const created = ReadonlyDynamicInputPage.create({ sourceId: 'water', pageId: 2, schema });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const page = created.value;
    expect(page.writeRecord(0, { position: [0, 0], time: 0, eventId: 1 })).toMatchObject({
      ok: false,
      error: { code: 'invalid-record' },
    });
    expect(page.release()).toMatchObject({ ok: true });
    expect(page.upload()).toMatchObject({ ok: false, error: { code: 'released' } });
  });

  it('rejects released-page receipts and ranges after same-id page replacement', () => {
    const createdA = ReadonlyDynamicInputPage.create({
      sourceId: 'same-source',
      pageId: 12,
      schema,
    });
    expect(createdA.ok).toBe(true);
    if (!createdA.ok) return;
    const pageA = createdA.value;
    expect(pageA.writeRecord(0, { position: [1, 2, 3], time: 4, eventId: 101 })).toMatchObject({
      ok: true,
    });
    const rangeA = pageA.reserveRange({
      domain: 'water',
      recordStart: 0,
      recordCount: 1,
      instanceIndex: 0,
      member: member(),
    });
    expect(rangeA.ok).toBe(true);
    if (!rangeA.ok) return;
    const receiptA = pageA.beginUpload();
    expect(receiptA.ok).toBe(true);
    if (!receiptA.ok) return;
    expect(pageA.release()).toMatchObject({ ok: true });
    expect(pageA.writeRecord(0, { position: [9, 8, 7], time: 6, eventId: 102 })).toMatchObject({
      ok: false,
      error: { code: 'released' },
    });
    expect(pageA.commitUpload(receiptA.value)).toMatchObject({
      ok: false,
      error: { code: 'released' },
    });
    expect(pageA.consume(rangeA.value, 40)).toMatchObject({
      ok: false,
      error: { code: 'released' },
    });

    const createdB = ReadonlyDynamicInputPage.create({
      sourceId: 'same-source',
      pageId: 12,
      schema,
    });
    expect(createdB.ok).toBe(true);
    if (!createdB.ok) return;
    const pageB = createdB.value;
    expect(pageB.writeRecord(0, { position: [5, 6, 7], time: 8, eventId: 201 })).toMatchObject({
      ok: true,
    });
    const rangeB = pageB.reserveRange({
      domain: 'water',
      recordStart: 0,
      recordCount: 1,
      instanceIndex: 0,
      member: member(),
    });
    expect(rangeB.ok).toBe(true);
    if (!rangeB.ok) return;
    const beforeBytes = pageB.bytes.slice();
    const beforeContentRevision = pageB.contentRevision;
    const beforeUploadedRevision = pageB.uploadedRevision;
    const beforeUpload = pageB.beginUpload();
    expect(beforeUpload.ok).toBe(true);
    if (!beforeUpload.ok) return;

    expect(pageB.commitUpload(receiptA.value)).toMatchObject({
      ok: false,
      error: { code: 'stale-generation' },
    });
    expect(pageB.consume(rangeA.value, 41)).toMatchObject({
      ok: false,
      error: { code: 'stale-generation' },
    });
    expect(pageB.bytes).toEqual(beforeBytes);
    expect(pageB.contentRevision).toBe(beforeContentRevision);
    expect(pageB.uploadedRevision).toBe(beforeUploadedRevision);
    expect(pageB.beginUpload()).toEqual(beforeUpload);
    expect(pageB.consume(rangeB.value, 42)).toMatchObject({
      ok: false,
      error: { code: 'not-uploaded' },
    });
  });

  it('does not publish partial bytes when a later field is invalid', () => {
    const created = ReadonlyDynamicInputPage.create({ sourceId: 'water', pageId: 3, schema });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const page = created.value;
    expect(page.writeRecord(0, { position: [1, 2, 3], time: 4, eventId: 5 })).toMatchObject({
      ok: true,
    });
    const beforeBytes = page.bytes.slice();
    const beforeRevision = page.contentRevision;
    expect(page.writeRecord(0, { position: [9, 8, 7], time: 6, eventId: 1.5 })).toMatchObject({
      ok: false,
      error: { code: 'invalid-record', detail: { field: 'eventId' } },
    });
    expect(page.bytes).toEqual(beforeBytes);
    expect(page.contentRevision).toBe(beforeRevision);
    expect(page.upload()).toMatchObject({ ok: true, value: { bytes: 32 } });
  });

  it('rejects an instance address outside the exact u32 range', () => {
    const created = ReadonlyDynamicInputPage.create({ sourceId: 'water', pageId: 4, schema });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(
      created.value.reserveRange({
        domain: 'overflow',
        recordStart: 0,
        recordCount: 1,
        instanceIndex: 0x1_0000_0000,
        member: member(),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'range-overflow', detail: { field: 'instanceIndex' } },
    });
  });

  it('keeps two explicit instance addresses independent', () => {
    const created = ReadonlyDynamicInputPage.create({ sourceId: 'water', pageId: 5, schema });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const page = created.value;
    expect(page.writeRecord(0, { position: [1, 0, 0], time: 1, eventId: 10 })).toMatchObject({
      ok: true,
    });
    expect(page.writeRecord(1, { position: [2, 0, 0], time: 2, eventId: 20 })).toMatchObject({
      ok: true,
    });
    const first = page.reserveRange({
      domain: 'first-instance',
      recordStart: 0,
      recordCount: 1,
      instanceIndex: 0,
      member: member(),
    });
    const second = page.reserveRange({
      domain: 'second-instance',
      recordStart: 1,
      recordCount: 1,
      instanceIndex: 1,
      member: member(1),
    });
    expect(first).toMatchObject({ ok: true, value: { instanceIndex: 0, recordStart: 0 } });
    expect(second).toMatchObject({ ok: true, value: { instanceIndex: 1, recordStart: 1 } });
    if (!first.ok || !second.ok) return;
    expect(page.upload()).toMatchObject({ ok: true, value: { bytes: 64 } });
    expect(page.consume(first.value, 20)).toMatchObject({
      ok: true,
      value: { instanceIndex: 0, recordStart: 0 },
    });
    expect(page.consume(second.value, 20)).toMatchObject({
      ok: true,
      value: { instanceIndex: 1, recordStart: 1 },
    });
  });
});
