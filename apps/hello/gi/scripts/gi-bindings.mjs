// Binding verification for the key GI passes of an RHI tape: for each matching pass,
// the compute/fragment entry point and every binding with its resource label, access,
// and size; unresolved bindings and GI storage written but never read are flagged.
//   node scripts/gi-bindings.mjs <tape> [regex]
import { readFileSync } from 'node:fs';

const { decodeTape, buildFrameModel } = await import('@forgeax/engine-rhi-debug');
const decoded = decodeTape(new Uint8Array(readFileSync(process.argv[2])));
const model = (buildFrameModel(decoded.value ?? decoded).value ?? buildFrameModel(decoded.value ?? decoded));
const key = new RegExp(process.argv[3] ?? 'trace|update|transport|resolve|composite|card-lighting|card-surface|temporal|filter|accumulate|shade', 'i');
const resources = new Map(model.resources.map((r) => [r.resourceId, r]));
const labelOf = (id) => {
  const r = resources.get(id);
  const d = r?.descriptor;
  const own = d?.desc?.label;
  if (own) return own;
  const parent = d?.sourceHandleId ?? d?.textureHandleId;
  if (typeof parent === 'string' && resources.get(parent)?.descriptor?.desc?.label)
    return `${resources.get(parent).descriptor.desc.label}(view)`;
  return id;
};
const commands = new Map(model.commands.map((c) => [c.eventIndex, c]));
const passLabel = (pass) => {
  const p = commands.get(pass.beginEventIndex)?.params;
  return p?.desc?.label ?? p?.label ?? `<${pass.kind}-${pass.passIndex}>`;
};
const works = new Map(model.works.map((w) => [w.workIndex, w]));
const seen = new Set();
const out = [];
for (const pass of model.passes) {
  const label = passLabel(pass);
  const stage = label.replace(/\.\d+\./g, '.').replace(/-\d+(-bounce-\d+)?$/, '').replace(/material-\d+/g, 'material-*');
  if (!key.test(label) || seen.has(stage)) continue;
  seen.add(stage);
  const work = works.get(pass.workIndices[0]);
  if (work === undefined) continue;
  const entry = work.pipeline.shaders.map((s) => `${s.stage}:${s.entryPoint}`).join(',');
  const bindings = work.bindings.map((b) => ({
    slot: `${b.groupIndex}.${b.binding}`,
    resource: b.resourceId === null ? null : labelOf(b.resourceId),
    kind: b.resourceKind,
    access: b.access,
    size: b.bufferSize,
  }));
  const unresolved = bindings.filter((b) => b.resource === null).length;
  out.push({ pass: label, works: pass.workIndices.length, kind: work.kind, entry, pipeline: work.pipeline.status, unresolved, bindings });
}
// GI storage that a frame writes but nothing reads (dead output) or reads but nobody wrote and was unseeded.
const giWriteOnly = [];
for (const r of model.resources) {
  const label = r.descriptor?.desc?.label;
  if (typeof label !== 'string' || !/^(ray|irradiance|screen-probe|probe-|card|global-sdf|sdf|gi\.)/.test(label)) continue;
  const writes = r.consumers.filter((c) => c.access === 'write').length;
  const reads = r.consumers.filter((c) => c.access === 'read').length;
  if (writes > 0 && reads === 0) giWriteOnly.push(label);
}
console.log(JSON.stringify({ passes: out, giWriteOnly, unseeded: model.unseededResources.length }, null, 1));
