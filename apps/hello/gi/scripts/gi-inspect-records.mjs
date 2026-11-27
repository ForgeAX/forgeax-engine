// GI producer layouts; replay/byte decoding remain owned by RHI Debug.
import { compileShader } from '@forgeax/engine-shader-compiler';

export async function withReplaySession(device, open, inspect) {
  let session;
  try {
    session = (await open()).unwrap();
    return await inspect(session);
  } finally {
    try {
      if (session !== undefined) (await session.dispose()).unwrap();
    } finally {
      device.nativeDevice().unwrap().destroy();
    }
  }
}

export async function readBatch(session, requests) {
  const result = await session.readAtWorks(requests);
  if (!result.ok) throw new Error(`replay batch failed: ${JSON.stringify(result.error)}`);
  if (!Array.isArray(result.value) || result.value.length !== requests.length)
    throw new Error('replay batch returned an incomplete slot array');
  return result.value;
}

export const originLayout = { stride: 32, fields: [
  { name: 'origin', offset: 0, type: 'f32', components: 3 },
  { name: 'probe', offset: 12, type: 'u32', components: 1 },
  { name: 'updates', offset: 16, type: 'u32', components: 1 },
] };

export function scheduledCount(frame, capacity) {
  if (frame.byteLength !== 128) throw new Error('unknown Field Frame byte layout');
  const count = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4, true);
  if (!Number.isSafeInteger(capacity) || capacity < count)
    throw new Error('schedule exceeds the bound producer capacity');
  return Math.min(32, count);
}

export function bindingKey(binding) {
  return JSON.stringify([binding.resourceId, binding.bufferOffset ?? 0,
    binding.dynamicOffset ?? 0, binding.bufferSize]);
}

// Admit only this recorded producer ABI. In particular the old two-field 16B
// ProbeOrigin must not be silently decoded with the current layout.
function vector(type, kind, components) {
  return type?.kind === 'vector' && type.scalarKind === kind && type.width === 4 &&
    type.components === components;
}

function uint(type) {
  return type?.kind === 'scalar' && type.scalarKind === 'uint' && type.width === 4;
}

function fieldFrameType(frame) {
  const kinds = ['uint', 'uint', 'uint', 'float', 'float', 'uint', 'uint', 'uint'];
  return frame?.kind === 'struct' && frame.span === 128 && frame.members.length === 8 &&
    frame.members.every((member, index) => member.offset === index * 16 &&
      vector(member.typeDescriptor, kinds[index], 4));
}

function probeOriginsType(origins) {
  const members = origins?.element?.members;
  return origins?.kind === 'array' && origins.stride === 32 && origins.element.kind === 'struct' &&
    origins.element.span === 32 && members.length === 3 &&
    members[0].offset === 0 && vector(members[0].typeDescriptor, 'float', 3) &&
    members[1].offset === 12 && uint(members[1].typeDescriptor) &&
    members[2].offset === 16 && uint(members[2].typeDescriptor);
}

function placeBufferAccess(global, index) {
  const uniform = [2, 3].includes(index);
  return global?.resourceKind === (uniform ? 'buffer' : 'storage-buffer') &&
    global.addressSpace === (uniform ? 'uniform' : 'storage') &&
    global.resourceAccess === (index === 4 ? 'read-write' : 'read-only');
}

function placeProducerTypes(types) {
  const [list, meta, field, frame, origins] = types.map((global) => global?.typeDescriptor);
  return list?.kind === 'array' && list.stride === 4 && uint(list.element) &&
    meta?.kind === 'array' && meta.stride === 16 && vector(meta.element, 'uint', 4) &&
    field?.kind === 'struct' && field.span === 256 && fieldFrameType(frame) &&
    probeOriginsType(origins) && types.every(placeBufferAccess);
}

export async function placeBindings(work) {
  const source = work.pipeline.shaders.find((shader) => shader.entryPoint === 'placeProbes')?.source;
  if (typeof source !== 'string') throw new Error('unsupported recorded Field producer: missing source');
  // Naga owns syntax, naming, offsets and array stride, including precompiled
  // WGSL. The five coordinates are the placeProbes producer's binding ABI.
  const compiled = (await compileShader(source, { id: 'gi-inspect/placeProbes' })).unwrap();
  const globals = compiled.reflection.boundGlobals;
  const types = [0, 1, 2, 3, 4].map((binding) => globals.find(
    (global) => global.group === 0 && global.binding === binding));
  if (!placeProducerTypes(types))
    throw new Error('unsupported recorded Field producer ABI (including historical 16B origins)');
  return Object.fromEntries(['probeList', 'probeMeta', 'probeField', 'frame', 'probeOrigins'].map((name, index) => {
    const binding = work.bindings.find((bound) => bound.groupIndex === 0 && bound.binding === index);
    if (!binding?.resourceId) throw new Error(`recorded producer has no bound ${name}`);
    return [name, binding];
  }));
}

export function recordRange(binding, resourceBytes, stride, first, count) {
  const base = (binding.bufferOffset ?? 0) + (binding.dynamicOffset ?? 0);
  const boundBytes = binding.bufferSize ?? resourceBytes - base;
  if (![base, boundBytes, stride, first, count].every(Number.isSafeInteger) ||
      base < 0 || boundBytes < 0 || base + boundBytes > resourceBytes ||
      stride < 4 || first < 0 || count < 1 || count > 4096 ||
      (first + count) * stride > boundBytes)
    throw new Error('record sample exceeds the actual binding window');
  return { offset: base + first * stride, size: count * stride };
}

export function matchingCohort(work, cohorts) {
  const keys = new Set(work.bindings.map(bindingKey));
  const matches = cohorts.filter((cohort) => [...cohort.keys].some((key) => keys.has(key)));
  if (matches.length > 1) throw new Error('work ambiguously binds multiple Field cohorts');
  return matches[0];
}

export function rayProbe(recordIndex, raysPerProbe, selected) {
  if (!Number.isInteger(raysPerProbe) || raysPerProbe < 1)
    throw new Error('unknown rays-per-probe schedule');
  const slot = Math.floor(recordIndex / raysPerProbe);
  const probe = selected.find((probe) => probe.slot === slot);
  if (!probe) throw new Error('ray record is outside the sampled active slots');
  return { slot, probe: probe.index, ray: recordIndex % raysPerProbe };
}
