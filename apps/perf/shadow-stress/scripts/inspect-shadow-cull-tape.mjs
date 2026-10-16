#!/usr/bin/env node
// Shadow-caster camera-cull audit of one PERF_RHI_CAPTURE tape. Diagnostic only.
//   with-lavapipe node scripts/inspect-shadow-cull-tape.mjs <frame.rhitape>
// Replays the tape on a fresh Dawn device and reports, per depth raster pass,
// the instances its indirect draws submit (read after the cull wrote the args),
// plus the camera-culled count of every cullViewShadowCamera dispatch. Compare
// a gpuOcclusion=1 tape with a gpuOcclusion=0 tape of the same fingerprint:
// culled passes must submit fewer instances and the final image stays equal.

import { readFileSync } from 'node:fs';
import { buildFrameModel, decodeTape, openReplay } from '../../../../packages/rhi-debug/dist/index.mjs';
import { bootstrapDawn } from '../../../shared/scripts/rhi-debug-verify.mjs';

const tapePath = process.argv[2];
if (tapePath === undefined) {
  console.error('usage: inspect-shadow-cull-tape.mjs <frame.rhitape>');
  process.exit(2);
}
const decoded = decodeTape(new Uint8Array(readFileSync(tapePath)));
if (!decoded.ok) throw decoded.error;
const tape = decoded.value;
const model = buildFrameModel(tape);
const resources = new Map(model.resources.map((entry) => [entry.resourceId, entry]));
const works = new Map(model.works.map((work) => [work.workIndex, work]));
// Counter words per batch: visible, LOD selection, cull reasons; the last word
// is camera-culled (view-gpu.ts COUNTER_WORDS with 8 LOD levels).
const COUNTER_WORDS = 2 + 8 + 3 + 8 + 8 + 2;

const backend = await bootstrapDawn('shadow-cull-tape', tape);
const opened = await openReplay(tape, { device: backend.freshDevice, createShaderModule: backend.rhiWebgpu.createShaderModule });
if (!opened.ok) throw opened.error;
const replay = opened.value;

async function words(binding, workIndex) {
  const read = await replay.readResourceAtWork(binding.resourceId, workIndex);
  if (!read.ok) throw new Error(`read ${binding.resourceId}@${workIndex}: ${read.error.code}`);
  const bytes = read.value.bytes;
  const offset = bytes.byteOffset + (binding.bufferOffset ?? 0) + (binding.dynamicOffset ?? 0);
  const size = binding.size ?? bytes.byteLength - (binding.bufferOffset ?? 0) - (binding.dynamicOffset ?? 0);
  return new Uint32Array(bytes.buffer.slice(offset, offset + size));
}

try {
  const culls = [];
  for (const work of model.works) {
    if (!work.pipeline.shaders.some((shader) => shader.entryPoint === 'cullViewShadowCamera')) continue;
    const counters = work.bindings.find((binding) => binding.groupIndex === 0 && binding.binding === 6);
    if (counters === undefined) continue;
    const after = await words(counters, work.workIndex + 1);
    let cameraCulled = 0;
    for (let base = 0; base + COUNTER_WORDS <= after.length; base += COUNTER_WORDS) {
      cameraCulled += after[base + COUNTER_WORDS - 1];
    }
    culls.push({ work: work.workIndex, cameraCulled });
  }

  const passes = [];
  for (const pass of model.passes) {
    if (pass.kind !== 'render') continue;
    const begin = model.commands.find((command) => command.eventIndex === pass.beginEventIndex);
    const viewId = begin?.params?.depthStencilViewHandleId;
    const view = viewId === undefined ? undefined : resources.get(viewId)?.descriptor;
    if (view === undefined || view === null) continue;
    if ((begin.params.desc.colorAttachments ?? []).some((attachment) => attachment !== null)) continue;
    const first = pass.workIndices[0];
    if (first === undefined) continue;
    const buffers = new Map();
    let draws = 0;
    let instances = 0;
    for (const index of pass.workIndices) {
      const call = works.get(index)?.drawCall;
      if (call?.indirectBufferHandleId === undefined) continue;
      let args = buffers.get(call.indirectBufferHandleId);
      if (args === undefined) {
        args = await words({ resourceId: call.indirectBufferHandleId }, first);
        buffers.set(call.indirectBufferHandleId, args);
      }
      draws += 1;
      instances += args[call.indirectOffset / 4 + 1];
    }
    if (draws === 0) continue;
    passes.push({ pass: pass.passIndex, layer: `${view.sourceHandleId}:${view.desc?.baseArrayLayer ?? 0}`, draws, instances });
  }
  const totalInstances = passes.reduce((sum, pass) => sum + pass.instances, 0);
  const totalCulled = culls.reduce((sum, cull) => sum + cull.cameraCulled, 0);
  console.log(JSON.stringify({ tape: tapePath, cameraCulled: totalCulled, depthInstances: totalInstances, culls, passes }, null, 2));
} finally {
  await replay.dispose();
}
process.exit(0);
