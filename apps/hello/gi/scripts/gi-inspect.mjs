// Bounded producer-layout inspection of the real GI frame, on a fresh device.
// RHI Debug owns replay and mixed scalar decoding; this consumer owns GI layouts.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildFrameModel, decodeTape, inspectBufferRecords, openReplay, replayDeviceRequest, tapeDigest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { installDawn } from './gi-dawn.mjs';
import { PROBE_ENTRY_INDEX } from '../../../../packages/render/src/raytracing/probe-clipmap.ts';

const bytes = new Uint8Array(readFileSync(resolve(process.argv[2])));
const out = resolve(process.argv[3]);
const tape = decodeTape(bytes).unwrap();
const model = buildFrameModel(tape);
const report = { digest: await tapeDigest(bytes), works: model.works.length,
  unseededResources: model.unseededResources, selected: [], errors: [] };
const stages = new Set(['cardSurface', 'radiateCards', 'placeProbes', 'traceProbes',
  'classifyRays', 'updateProbes', 'deriveProbes', 'gatherField', 'upsampleField']);
const resources = new Map(model.resources.map((resource) => [resource.resourceId, resource]));
const layouts = {
  'irradiance-field.probe-list': { stride: 4, fields: [
    { name: 'entry', offset: 0, type: 'u32', components: 1 },
  ] },
  'irradiance-field.probe-origins': { stride: 16, fields: [
    { name: 'origin', offset: 0, type: 'f32', components: 3 },
    { name: 'entry', offset: 12, type: 'u32', components: 1 },
  ] },
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
await installDawn();
const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
const device = (await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))).unwrap();
const session = (await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })).unwrap();
try {
  const seen = new Set();
  for (const work of model.works) {
    const stage = work.pipeline.shaders.map((shader) => shader.entryPoint).find((entry) => stages.has(entry));
    if (stage === undefined || seen.has(stage)) continue;
    seen.add(stage);
    // Full output readback belongs to captureAndReplay's all-resource comparison.
    // Keep this report bounded: selected post-work records, pipeline and bindings.
    const result = await session.inspectWork(work.workIndex, ['pipeline', 'bindings']);
    const row = { stage, workIndex: work.workIndex, inspection: result, records: [] };
    if (!result.ok) report.errors.push({ stage, workIndex: work.workIndex, error: result.error });
    for (const binding of work.bindings) {
      const resource = resources.get(binding.resourceId);
      const label = resource?.descriptor?.desc?.label;
      const layout = layouts[label];
      if (resource?.kind !== 'buffer' || layout === undefined) continue;
      const count = Math.min(32, Math.floor(resource.descriptor.desc.size / layout.stride));
      const decoded = await inspectBufferRecords(session, resource.resourceId, work.workIndex, layout, { first: 0, count });
      row.records.push({ label, decoded });
      if (!decoded.ok) report.errors.push({ stage, label, error: decoded.error });
      else if (decoded.value.records.some((record) => Object.values(record.fields).flat().some((value) => typeof value !== 'number')))
        report.errors.push({ stage, label, error: 'nonfinite sampled buffer value' });
    }
    // The update budget selects lattice addresses, which need not begin at 0.
    // Follow those actual addresses instead of treating the first meta rows as
    // the probes this work updated. This remains a bounded sample, not a census.
    const list = row.records.find((record) => record.label === 'irradiance-field.probe-list')?.decoded;
    const meta = work.bindings.map((binding) => resources.get(binding.resourceId)).find(
      (resource) => resource?.descriptor?.desc?.label === 'irradiance-field.meta',
    );
    if (list?.ok && meta !== undefined) {
      row.selectedProbeMeta = [];
      for (const entry of new Set(list.value.records.map((record) => record.fields.entry[0]))) {
        if (entry === 0xffffffff) continue;
        const index = entry & PROBE_ENTRY_INDEX;
        if (!Number.isInteger(index) || index >= meta.descriptor.desc.size / 16) {
          report.errors.push({ stage, index, error: 'selected probe outside producer meta buffer' });
          continue;
        }
        const decoded = await inspectBufferRecords(session, meta.resourceId, work.workIndex,
          layouts['irradiance-field.meta'], { first: index, count: 1 });
        row.selectedProbeMeta.push({ index, decoded });
        if (!decoded.ok) report.errors.push({ stage, index, error: decoded.error });
      }
    }
    report.selected.push(row);
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[gi-inspect] ${stage} work ${work.workIndex}, ${row.records.length} bounded buffers`);
  }
} finally {
  (await session.dispose()).unwrap();
  device.destroy?.();
}
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
process.exit(report.selected.length === 0 || report.selected.every((row) => row.records.length === 0) || report.errors.length > 0 ? 1 : 0);
