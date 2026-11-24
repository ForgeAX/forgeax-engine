import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { err, ok } from '@forgeax/engine-types';
import { compileShader } from '@forgeax/engine-shader-compiler';
import { bindingKey, matchingCohort, originLayout, placeBindings, rayProbe, readBatch, recordRange, scheduledCount } from '../gi-inspect-records.mjs';

const producer = readFileSync(new URL('../../../../../packages/render/src/raytracing/irradiance-field.ts', import.meta.url), 'utf8');
const originBytes = Number(producer.match(/IRRADIANCE_FIELD_ORIGIN_BYTES = (\d+)/)[1]);
const shared = producer.split('const SHARED_WGSL = `')[1].split('`;')[0];
const placeSource = producer.split('const IRRADIANCE_FIELD_PLACE_WGSL = `')[1].split('`;')[0]
  .replace('${SHARED_WGSL}', shared);
// Original Sponza e2be native-calls id299; retained bytes, not a reformatted proxy.
const capturedPlace = readFileSync(new URL('./fixtures/gi-inspect-place-probes.wgsl', import.meta.url), 'utf8');
function placeWork(source = placeSource) {
  return { pipeline: { shaders: [{ entryPoint: 'placeProbes', source }] }, bindings:
    ['list', 'meta', 'field', 'frame', 'origins'].map((resourceId, binding) => ({
      groupIndex: 0, binding, resourceId, bufferOffset: 0, dynamicOffset: null, bufferSize: null,
    })) };
}

test('two actual producer origins retain nonzero update ordinals', () => {
  const bytes = new ArrayBuffer(2 * originBytes);
  const view = new DataView(bytes);
  for (const [slot, index, updates] of [[0, 7, 19], [1, 3, 41]]) {
    view.setFloat32(slot * originBytes, slot + 1, true);
    view.setUint32(slot * originBytes + 12, index, true);
    view.setUint32(slot * originBytes + 16, updates, true);
  }
  assert.equal(originLayout.stride, originBytes);
  const field = originLayout.fields.find((field) => field.name === 'updates');
  assert.ok(field);
  assert.deepEqual([0, 1].map((slot) => view.getUint32(slot * originLayout.stride + field.offset, true)), [19, 41]);
});

test('only scheduled slots are inspected, not a stale nonzero allocation tail', () => {
  const frame = new Uint8Array(128);
  new DataView(frame.buffer).setUint32(4, 2, true);
  const entries = [7, 3, 0xdeadbeef, 0xffffffff];
  assert.deepEqual(entries.slice(0, scheduledCount(frame, entries.length)), [7, 3]);
});

test('actual captured Sponza producer is admitted by Naga reflection', async () => {
  assert.equal(createHash('sha256').update(capturedPlace).digest('hex'), '771079d97e3b8bfc83f7ffe7915ac226c95bca2a65ad924395a4ce4fdb76f0e4');
  assert.equal((await placeBindings(placeWork(capturedPlace))).probeOrigins.resourceId, 'origins');
  const canonical = (await compileShader(capturedPlace, { id: 'gi-inspect/captured-roundtrip' })).unwrap();
  assert.equal((await placeBindings(placeWork(canonical.wgsl))).probeOrigins.resourceId, 'origins');
});

test('reflected producer ABI rejects historical and unknown layouts', async () => {
  assert.equal((await placeBindings(placeWork())).probeOrigins.resourceId, 'origins');
  const historical = capturedPlace.replace(', updates: u32', '').replace('ProbeOrigin(origin,probe,updates)', 'ProbeOrigin(origin,probe)');
  await assert.rejects(() => placeBindings(placeWork(historical)), /unsupported recorded/);
  await assert.rejects(() => placeBindings(placeWork(null)), /missing source/);
  await assert.rejects(() => placeBindings(placeWork(placeSource.replace('schedule: vec4u', 'schedule: vec2u'))), /unsupported recorded/);
  const missing = placeWork();
  missing.bindings.pop();
  await assert.rejects(() => placeBindings(missing), /no bound probeOrigins/);
});

test('active count zero and capacity failures do not inspect old slots', () => {
  assert.equal(scheduledCount(new Uint8Array(128), 0), 0);
  const frame = new Uint8Array(128);
  new DataView(frame.buffer).setUint32(4, 33, true);
  assert.equal(scheduledCount(frame, 40), 32);
  assert.throws(() => scheduledCount(frame, 32), /capacity/);
  assert.throws(() => scheduledCount(new Uint8Array(64), 40), /unknown Field Frame/);
});

test('sampling respects static plus dynamic binding windows', () => {
  const binding = { resourceId: 'origins', bufferOffset: 32, dynamicOffset: 64, bufferSize: 64 };
  assert.deepEqual(recordRange(binding, 192, originLayout.stride, 1, 1), { offset: 128, size: 32 });
  assert.throws(() => recordRange(binding, 192, 32, 2, 1), /binding window/);
  assert.throws(() => recordRange(binding, 128, 32, 0, 1), /binding window/);
});

test('same labels or stages cannot join different field resources or binding windows', () => {
  const first = { resourceId: 'list-a', bufferOffset: 0, dynamicOffset: null, bufferSize: 32 };
  const second = { ...first, resourceId: 'list-b' };
  const a = { placeWork: 1, keys: new Set([bindingKey(first)]) };
  const b = { placeWork: 8, keys: new Set([bindingKey(second)]) };
  assert.equal(matchingCohort({ bindings: [second] }, [a, b]), b);
  assert.equal(matchingCohort({ bindings: [{ ...first, bufferOffset: 32 }] }, [a, b]), undefined);
  assert.throws(() => matchingCohort({ bindings: [first, second] }, [a, b]), /ambiguously/);
  // Screen's legal no-gather/no-update frame has no Field producer cohort.
  assert.equal(matchingCohort({ bindings: [{ resourceId: 'screen-integrated' }] }, []), undefined);
});

test('ray slots follow the actual list rather than global probe-index addressing', () => {
  const selected = [{ slot: 0, index: 7 }, { slot: 1, index: 3 }];
  assert.deepEqual(rayProbe(5, 4, selected), { slot: 1, probe: 3, ray: 1 });
  assert.throws(() => rayProbe(8, 4, selected), /outside the sampled/);
  assert.throws(() => rayProbe(0, 0, selected), /unknown rays/);
});

test('replay orchestration unwraps the real outer Result and retains distinct binding windows', async () => {
  const binding = { resourceId: 'origins', bufferOffset: 32, dynamicOffset: 64, bufferSize: 64 };
  const requests = [0, 1].map((first) => ({ resourceId: binding.resourceId, workIndex: 8,
    subresource: recordRange(binding, 192, 32, first, 1) }));
  const slots = requests.map((request, slot) => ok({ bytes: new Uint8Array([slot]), provenance: request }));
  let calls = 0;
  const reads = await readBatch({ async readAtWorks(actual) {
    calls++;
    assert.deepEqual(actual, requests);
    return ok(slots);
  } }, requests);
  assert.equal(calls, 1);
  assert.deepEqual(reads, slots);
  assert.deepEqual(reads[1].unwrap().provenance.subresource, { offset: 128, size: 32 });
});

test('replay orchestration fails closed on outer replay errors', async () => {
  await assert.rejects(() => readBatch({ readAtWorks: async () => err({ code: 'replay-position-invalid' }) }, []), /replay-position-invalid/);
});

test('replay orchestration preserves a failed read in its original slot', async () => {
  const failure = err({ code: 'readback-unsupported' });
  const reads = await readBatch({ readAtWorks: async () => ok([ok({ bytes: new Uint8Array(4) }), failure]) }, [{}, {}]);
  assert.equal(reads[0].ok, true);
  assert.equal(reads[1], failure);
});
