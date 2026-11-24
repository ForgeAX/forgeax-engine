// Bounded producer-layout inspection of the real GI frame, on a fresh device.
// RHI Debug owns replay and mixed scalar decoding; this consumer owns GI layouts.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildFrameModel, decodeBufferRecords, decodeTape, openReplay, replayDeviceRequest, tapeDigest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { installDawn } from './gi-dawn.mjs';
import { PROBE_ENTRY_INDEX } from '../../../../packages/render/src/raytracing/probe-entry.ts';
import { bindingKey, matchingCohort, originLayout, placeBindings, rayProbe, readBatch, recordRange, scheduledCount, withReplaySession } from './gi-inspect-records.mjs';

const bytes = new Uint8Array(readFileSync(resolve(process.argv[2])));
const out = resolve(process.argv[3]);
const tape = decodeTape(bytes).unwrap();
const model = buildFrameModel(tape);
const report = { digest: await tapeDigest(bytes), works: model.works.length,
  unseededResources: model.unseededResources, selected: [], errors: [] };
const stages = new Set(['cardSurface', 'radiateCards', 'placeProbes', 'traceProbes',
  'copyDirectCards', 'classifyRays', 'updateProbes', 'deriveProbes', 'gatherField', 'upsampleField',
  'traceWorldProbes', 'traceScreenProbes', 'resolveProbeRays', 'temporalProbeRadiance',
  'filterProbeRadiance', 'integrateScreenProbes', 'temporalScreenProbes',
  'fs_ray_diffuse_reconstructed', 'fs_ray_diffuse_reconstructed_reflections']);
const resources = new Map(model.resources.map((resource) => [resource.resourceId, resource]));
const layouts = {
  'irradiance-field.probe-list': { stride: 4, fields: [
    { name: 'entry', offset: 0, type: 'u32', components: 1 },
  ] },
  'irradiance-field.probe-origins': originLayout,
  'irradiance-field.meta': { stride: 16, fields: [
    { name: 'updatesClassification', offset: 0, type: 'u32', components: 2 },
    { name: 'relocation', offset: 8, type: 'f16', components: 4 },
  ] },
  'irradiance-field.moments': { stride: 8, fields: [{ name: 'distanceMoments', offset: 0, type: 'f32', components: 2 }] },
  'irradiance-field.probe-rays': { stride: 32, fields: [
    { name: 'radianceDistance', offset: 0, type: 'f32', components: 4 },
    { name: 'directionStatus', offset: 16, type: 'f32', components: 4 },
  ] },
};
const vector = { stride: 16, fields: [{ name: 'value', offset: 0, type: 'f32', components: 4 }] };
for (const label of ['card-direct', 'card-lit', 'irradiance', 'gathered', 'upsampled'])
  layouts[`irradiance-field.${label}`] = vector;
for (const label of ['integrated', 'historyA', 'historyB']) layouts[`screen-probe.${label}`] = vector;
// Validate the layout before starting a replay device, not from allocation size.
const producers = new Map();
for (const work of model.works) {
  if (work.pipeline.shaders.some((shader) => shader.entryPoint === 'placeProbes'))
    producers.set(work.workIndex, await placeBindings(work));
}

async function producerCohort(session, work, records) {
  const bindings = producers.get(work.workIndex);
  const frameRead = recordRange(bindings.frame, resources.get(bindings.frame.resourceId).descriptor.desc.size, 128, 0, 1);
  const [frame] = await readBatch(session, [{ resourceId: bindings.frame.resourceId,
    workIndex: work.workIndex, subresource: frameRead }]);
  const bytes = frame.unwrap().bytes;
  const listBytes = bindings.probeList.bufferSize ??
    resources.get(bindings.probeList.resourceId).descriptor.desc.size -
    (bindings.probeList.bufferOffset ?? 0) - (bindings.probeList.dynamicOffset ?? 0);
  const count = scheduledCount(bytes, Math.floor(listBytes / 4));
  const list = count === 0 ? undefined : await records(bindings.probeList, work.workIndex,
    layouts['irradiance-field.probe-list'], 0, count);
  if (list && !list.ok) throw new Error(JSON.stringify(list.error));
  return { placeWork: work.workIndex, bindings, count,
    active: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true),
    rays: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true),
    selected: list?.value.records.map((record) => ({ slot: record.index,
      entry: record.fields.entry[0], index: record.fields.entry[0] & PROBE_ENTRY_INDEX })) ?? [],
    keys: new Set(['probeList', 'probeOrigins', 'probeMeta', 'probeField'].map((name) => bindingKey(bindings[name]))) };
}

function boundRecordSamples(work, stage, row, cohort) {
  const samples = [];
  for (const binding of work.bindings) {
    const resource = resources.get(binding.resourceId);
    const label = resource?.descriptor?.desc?.label;
    const layout = layouts[label];
    if (resource?.kind !== 'buffer' || layout === undefined) continue;
    const scheduled = ['irradiance-field.probe-list', 'irradiance-field.probe-origins', 'irradiance-field.probe-rays'].includes(label);
    if (scheduled && cohort === undefined) throw new Error(`no recorded placeProbes authority for ${stage}/${label}`);
    const boundBytes = binding.bufferSize ?? resource.descriptor.desc.size -
      (binding.bufferOffset ?? 0) - (binding.dynamicOffset ?? 0);
    const slotRecords = label === 'irradiance-field.probe-rays' ? cohort?.rays : 1;
    if (scheduled && Math.floor(boundBytes / layout.stride) < cohort.active * slotRecords)
      throw new Error(`active schedule exceeds the bound ${label} capacity`);
    const count = Math.min(32, Math.floor(boundBytes / layout.stride),
      scheduled ? cohort.count * slotRecords : Infinity);
    if (count === 0) continue;
    const record = { label, resourceId: resource.resourceId, binding,
      selection: scheduled ? 'scheduled-slots' : 'allocation-prefix-not-selected-probes',
    };
    row.records.push(record);
    samples.push({ binding, layout, first: 0, count, record });
  }
  return samples;
}

function selectedMetaSamples(row, cohort) {
  const samples = [];
  // The update budget selects lattice addresses, which need not begin at 0.
  // Follow those actual addresses instead of treating the first meta rows as
  // the probes this work updated. This remains a bounded sample, not a census.
  if (cohort !== undefined) {
    row.selectedProbeMeta = [];
    for (const { slot, entry, index } of cohort.selected) {
      if (entry === 0xffffffff) throw new Error('invalid entry in active probe schedule');
      const record = { slot, index };
      row.selectedProbeMeta.push(record);
      samples.push({ binding: cohort.bindings.probeMeta,
        layout: layouts['irradiance-field.meta'], first: index, count: 1, record });
    }
  }
  return samples;
}

function decodeSamples(reads, samples, stage, cohort) {
  samples.forEach((sample, index) => {
    const read = reads[index];
    const decoded = read.ok ? decodeBufferRecords(read.value, sample.layout,
      { first: sample.first, count: sample.count }) : read;
    sample.record.decoded = decoded;
    if (!decoded.ok) report.errors.push({ stage, resourceId: sample.binding.resourceId, error: decoded.error });
    else {
      if (sample.record.label === 'irradiance-field.probe-rays')
        sample.record.rayProbes = decoded.value.records.map((record) => rayProbe(record.index, cohort.rays, cohort.selected));
      if (decoded.value.records.some((record) => Object.values(record.fields).flat().some((value) => typeof value !== 'number')))
        report.errors.push({ stage, resourceId: sample.binding.resourceId, error: 'nonfinite sampled buffer value' });
    }
  });
}

await installDawn();
const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
const device = (await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))).unwrap();
await withReplaySession(device, () => openReplay(tape, { device, createShaderModule: webgpu.createShaderModule }), async (session) => {
async function records(binding, workIndex, layout, first, count) {
  const resource = resources.get(binding.resourceId);
  const subresource = recordRange(binding, resource.descriptor.desc.size, layout.stride, first, count);
  const [read] = await readBatch(session, [{ resourceId: binding.resourceId, workIndex, subresource }]);
  return read.ok ? decodeBufferRecords(read.value, layout, { first, count }) : read;
}
try {
  const cohorts = [];
  for (const work of model.works) {
    const stage = work.pipeline.shaders.map((shader) => shader.entryPoint).find((entry) => stages.has(entry));
    if (stage === undefined) continue;
    if (report.selected.length >= 64) throw new Error('GI inspection exceeds the 64-work bound');
    let cohort;
    if (stage === 'placeProbes') {
      cohort = await producerCohort(session, work, records);
      cohorts.push(cohort);
    } else {
      cohort = matchingCohort(work, cohorts);
    }
    if (stage === 'updateProbes' && cohort) {
      // Only the actual update binding joins the cache to its producer cohort.
      for (const binding of work.bindings) {
        const label = resources.get(binding.resourceId)?.descriptor?.desc?.label;
        if (label === 'irradiance-field.irradiance' || label === 'irradiance-field.moments')
          cohort.keys.add(bindingKey(binding));
      }
    }
    // Full output readback belongs to captureAndReplay's all-resource comparison.
    // Keep this report bounded: selected post-work records, pipeline and bindings.
    const result = await session.inspectWork(work.workIndex, ['pipeline', 'bindings']);
    const row = { stage, workIndex: work.workIndex, placeWork: cohort?.placeWork,
      selectedSlots: cohort?.selected, inspection: result, records: [] };
    if (!result.ok) report.errors.push({ stage, workIndex: work.workIndex, error: result.error });
    const samples = boundRecordSamples(work, stage, row, cohort);
    samples.push(...selectedMetaSamples(row, cohort));
    // One replay batch per work, not one replay prefix per selected probe.
    const reads = await readBatch(session, samples.map((sample) => ({
      resourceId: sample.binding.resourceId, workIndex: work.workIndex,
      subresource: recordRange(sample.binding, resources.get(sample.binding.resourceId).descriptor.desc.size,
        sample.layout.stride, sample.first, sample.count),
    })));
    decodeSamples(reads, samples, stage, cohort);
    report.selected.push(row);
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[gi-inspect] ${stage} work ${work.workIndex}, ${row.records.length} bounded buffers`);
  }
} catch (error) {
  report.errors.push({ error: error instanceof Error ? error.message : String(error) });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  throw error;
}
});
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
process.exit(report.selected.length === 0 || report.selected.every((row) => row.records.length === 0) || report.errors.length > 0 ? 1 : 0);
