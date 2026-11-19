import { expect, it } from 'vitest';
import { ReadonlyDynamicInputPage } from '../dynamic-input.js';

const schema = {
  name: 'wake',
  fields: [
    { name: 'sample', type: 'vec4<f32>' as const },
    { name: 'id', type: 'u32' as const },
  ],
  maxRecords: 2,
  maxDomains: 1,
  maxPageBytes: 64,
  maxBindings: 1,
  maxEventsPerSample: 2,
};
const create = () =>
  ReadonlyDynamicInputPage.create({ sourceId: 'ocean', pageId: 4, schema }).unwrap();

it('captures detached bounded records without transferring GPU generation or upload receipts', () => {
  const source = create();
  source.writeRecord(0, { sample: [1, 2, 3, 4], id: 19 }).unwrap();
  source.reconfigureDevice(7).unwrap();
  const snapshot = source.capture().unwrap();
  const wire = structuredClone(snapshot);
  source.writeRecord(0, { sample: [8, 8, 8, 8], id: 20 }).unwrap();
  expect(new DataView(snapshot.bytes.buffer).getFloat32(0, true)).toBe(1);
  expect(snapshot.schema.fields).not.toBe(source.schema.fields);
  const received = ReadonlyDynamicInputPage.fromSnapshot(wire).unwrap();
  expect(received.bytes).toEqual(snapshot.bytes);
  expect(received.contentRevision).toBe(snapshot.contentRevision);
  expect(received.deviceGeneration).toBe(1);
  expect(received.uploadedRevision).toBe(0);
  received.reconfigureDevice(9).unwrap();
  const range = received
    .reserveRange({
      domain: 'ocean',
      recordStart: 0,
      recordCount: 1,
      instanceIndex: 0,
      member: { worldIdentity: 'world-ocean', entityKey: 51, drawItemIndex: 0, instanceOrdinal: 0 },
    })
    .unwrap();
  expect(range.deviceGeneration).toBe(9);
  received.upload().unwrap();
  expect(received.consume(range, 1)).toMatchObject({ ok: true });
  source.release().unwrap();
  expect(source.capture()).toMatchObject({ ok: false, error: { code: 'released' } });
  expect(received.capture().ok).toBe(true);
});

it('updates retained receiver bytes transactionally and rejects stale or malformed snapshots', () => {
  const source = create(),
    received = ReadonlyDynamicInputPage.fromSnapshot(source.capture().unwrap()).unwrap();
  received.upload().unwrap();
  const older = source.capture().unwrap();
  source.writeRecord(1, { sample: [2, 3, 4, 5], id: 7 }).unwrap();
  const next = source.capture().unwrap();
  const invalid = structuredClone(next);
  new DataView(invalid.bytes.buffer).setFloat32(32, Number.NaN, true);
  expect(received.applySnapshot(invalid)).toMatchObject({
    ok: false,
    error: { code: 'invalid-record' },
  });
  expect(received.bytes).toEqual(older.bytes);
  expect(received.contentRevision).toBe(older.contentRevision);
  received.applySnapshot(next).unwrap();
  expect(received.bytes).toEqual(next.bytes);
  expect(received.beginUpload().unwrap().ranges).toEqual([{ byteStart: 32, byteEnd: 64 }]);
  expect(received.applySnapshot(older)).toMatchObject({
    ok: false,
    error: { code: 'stale-generation' },
  });
  const changed = structuredClone(next);
  changed.bytes[0] = 1;
  expect(received.applySnapshot(changed)).toMatchObject({
    ok: false,
    error: { code: 'invalid-record' },
  });
  expect(ReadonlyDynamicInputPage.fromSnapshot({ ...next, bytes: new Uint8Array(1) }).ok).toBe(
    false,
  );
  received.release().unwrap();
  expect(received.applySnapshot(next)).toMatchObject({ ok: false, error: { code: 'released' } });
});
