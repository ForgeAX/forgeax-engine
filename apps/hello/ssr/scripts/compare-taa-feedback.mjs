import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeTape, buildFrameModel, openReplay, halfToFloat } from '@forgeax/engine-rhi-debug';
import { bootstrapDawn } from '../../../shared/scripts/rhi-debug-verify.mjs';
import { writeReferencePng } from '../../../shared/png-codec.mjs';
import { readCapturedTaaPose, readCapturedTaaReference, measureTaaReferenceRegions } from './taa-reference.mjs';

// Diagnostic feedback experiment, not a live-frame replay: repeat the recorded
// eight-phase static inputs, but feed each candidate's own GPU output forward.
const prefix = resolve(process.argv[2]);
const journey = process.argv.includes('--journey');
const scenePose = process.argv.includes('--scene-pose');
const secondaryReactivity = process.argv.includes('--secondary-reactivity');
const confidenceReactivity = process.argv.includes('--confidence-reactivity');
assert.ok(!confidenceReactivity || secondaryReactivity, 'Confidence diagnostic requires the captured secondary mask');
const settlePrefix = process.argv.find(arg => arg.startsWith('--settle-prefix='))?.slice(16);
if (settlePrefix) assert.ok(journey, 'A same-pose settle splice requires a chronological journey');
const resultPrefix = process.argv.find(arg => arg.startsWith('--output-prefix='))?.slice(16)
  ?? (settlePrefix ? `${prefix}-settle` : prefix);
const exportFrames = process.argv.includes('--export-frames');
const historyFormat = process.argv.find(arg => arg.startsWith('--history-format='))?.slice(17) ?? 'rgba16float';
assert.ok(['rgba16float', 'rgba32float'].includes(historyFormat), 'History format must be explicitly decoded');
const stabilityFormat = process.argv.find(arg => arg.startsWith('--stability-format='))?.slice(19) ?? 'r8unorm';
assert.ok(['r8unorm', 'rgba16float'].includes(stabilityFormat), 'Private statistics format must be explicit');
assert.ok(stabilityFormat === 'r8unorm' || process.argv[3] === 'implementation',
  'Extended private statistics require one explicit implementation candidate');
const warmupFrames = Number(process.argv.find(arg => arg.startsWith('--warmup-frames='))?.slice(16) ?? 128);
assert.ok(Number.isInteger(warmupFrames) && warmupFrames >= 64 && warmupFrames <= 1024 && warmupFrames % 8 === 0,
  'Warmup must be 64..1024 frames and include complete jitter cycles');
const inputKeys = journey ? ['color', 'temporal', 'params', 'history', 'historyTemporal'] : ['color', 'temporal', 'params'];
if (scenePose) inputKeys.push('view', 'meshes');
if (secondaryReactivity) inputKeys.push('secondaryReactivity');
if (confidenceReactivity) inputKeys.push('ssrPreviousSurface', 'ssrSurface');
const extractionPhase = process.argv[3] === '--extract-phase' ? Number(process.argv[4]) : undefined;
if (extractionPhase !== undefined) assert.ok(Number.isInteger(extractionPhase) && extractionPhase >= 0 && extractionPhase < 8);
const frames = [];
for (let phase = 0; phase < 8; phase++) {
  if (extractionPhase !== undefined && phase !== extractionPhase) continue;
  const bytes = new Uint8Array(readFileSync(`${prefix}-${phase}/frame.rhitape`));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const cachePath = `${prefix}-${phase}/taa-feedback-inputs.json`;
  const cacheUsable = () => {
    if (!existsSync(cachePath)) return false;
    const cache = JSON.parse(readFileSync(cachePath));
    return inputKeys.every(key => cache[key] !== undefined);
  };
  if (!cacheUsable() && extractionPhase === undefined) {
    // Repeated native Dawn instance replacement in one process crashed after
    // several tapes. Each extraction gets a fresh process, while the feedback
    // experiment keeps one device and its real evolving history throughout.
    await new Promise((done, fail) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), prefix, '--extract-phase', String(phase), ...(journey ? ['--journey'] : []), ...(scenePose ? ['--scene-pose'] : []), ...(secondaryReactivity ? ['--secondary-reactivity'] : []), ...(confidenceReactivity ? ['--confidence-reactivity'] : [])], { stdio: 'inherit' });
      child.once('error', fail);
      child.once('exit', (code, signal) => code === 0 ? done() : fail(new Error(`Phase ${phase} extraction failed: code=${code}, signal=${signal}`)));
    });
  }
  if (cacheUsable()) {
    const cache = JSON.parse(readFileSync(cachePath));
    assert.equal(cache.digest, digest);
    for (const key of inputKeys) {
      cache[key].bytes = new Uint8Array(readFileSync(`${prefix}-${phase}/taa-feedback-${key}.bin`));
      assert.equal(createHash('sha256').update(cache[key].bytes).digest('hex'), cache[key].digest);
    }
    assert.equal(cache.frameIndex, new DataView(cache.params.bytes.buffer, cache.params.bytes.byteOffset).getUint32(12, true));
    if (frames.length > 0) assert.equal(cache.frameIndex, frames.at(-1).frameIndex + 1);
    frames.push(cache);
    console.log(JSON.stringify({ cachedPhase: phase, frameIndex: cache.frameIndex }));
    continue;
  }
  const tape = decodeTape(bytes).unwrap();
  const model = buildFrameModel(tape);
  const works = model.works.filter(w => w.pipeline.shaders.some(s => s.source.includes('fn fs_taa_resolve(')));
  assert.equal(works.length, 1);
  const work = works[0];
  const backend = await bootstrapDawn('TAA feedback input', tape);
  const replay = (await openReplay(tape, { device: backend.freshDevice, createShaderModule: backend.rhiWebgpu.createShaderModule })).unwrap();
  try {
    const read = async slot => (await replay.readResourceAtWork(
      work.bindings.find(b => b.groupIndex === 1 && b.binding === slot).resourceId, work.workIndex)).unwrap();
    const color = await read(0), temporal = await read(6), params = await read(8);
    const prior = journey ? { history: await read(2), historyTemporal: await read(4) } : {};
    if (secondaryReactivity) {
      assert.ok(params.bytes.byteLength >= 20);
      assert.equal(new DataView(params.bytes.buffer, params.bytes.byteOffset).getUint32(16, true), 1,
        'Secondary reactivity must be enabled in the captured pipeline');
      prior.secondaryReactivity = await read(10);
      assert.equal(prior.secondaryReactivity.format, 'r32float');
    }
    if (confidenceReactivity) {
      const temporalWork = model.works.find(work => work.pipeline.shaders.some(shader => shader.entryPoint === 'ssr_temporal'));
      assert.ok(temporalWork, 'Missing captured SSR resolve');
      for (const [name, slot] of [['ssrPreviousSurface', 9], ['ssrSurface', 10]]) {
        const binding = temporalWork.bindings.find(binding => binding.groupIndex === 0 && binding.binding === slot);
        assert.ok(binding?.resourceId);
        prior[name] = (await replay.readResourceAtWork(binding.resourceId, temporalWork.workIndex)).unwrap();
        assert.equal(prior[name].format, 'rgba8unorm');
      }
    }
    if (scenePose) {
      const draw = model.works.find(work => work.pipeline.shaders.some(shader => shader.entryPoint === 'fs_temporal'));
      assert.ok(draw, 'Pose verification requires an ordinary scene-temporal draw');
      for (const [name, groupIndex] of [['view', 0], ['meshes', 2]]) {
        const binding = draw.bindings.find(binding => binding.groupIndex === groupIndex && binding.binding === 0);
        assert.ok(binding?.resourceId);
        if (name === 'meshes') assert.equal(binding.bufferSize, 256, 'Expected the ordinary Mesh window ABI');
        prior[name] = (await replay.readResourceAtWork(binding.resourceId, draw.workIndex)).unwrap();
      }
    }
    assert.equal(color.format, 'rgba16float');
    assert.equal(temporal.format, 'rgba16float');
    const frameIndex = new DataView(params.bytes.buffer, params.bytes.byteOffset).getUint32(12, true);
    if (frames.length > 0) assert.equal(frameIndex, frames.at(-1).frameIndex + 1);
    frames.push({ digest, frameIndex, color, temporal, params, ...prior });
    const cache = { digest, frameIndex };
    for (const [key, read] of Object.entries({ color, temporal, params, ...prior })) {
      writeFileSync(`${prefix}-${phase}/taa-feedback-${key}.bin`, read.bytes);
      cache[key] = { width: read.width, height: read.height, format: read.format,
        digest: createHash('sha256').update(read.bytes).digest('hex') };
    }
    writeFileSync(cachePath, JSON.stringify(cache));
    console.log(JSON.stringify({ loadedPhase: phase, frameIndex }));
  } finally { replay.dispose(); backend.freshDevice.destroy?.(); }
}
if (extractionPhase !== undefined) process.exit(0);
if (settlePrefix) {
  assert.deepEqual(readCapturedTaaPose(prefix, 5), readCapturedTaaPose(settlePrefix, 0), 'Settle inputs must share the terminal scene pose');
  const settled = Array.from({ length: 8 }, (_, phase) => {
    const cache = JSON.parse(readFileSync(`${settlePrefix}-${phase}/taa-feedback-inputs.json`));
    const tape = readFileSync(`${settlePrefix}-${phase}/frame.rhitape`);
    assert.equal(createHash('sha256').update(tape).digest('hex'), cache.digest);
    for (const key of ['color', 'temporal', 'params', ...(secondaryReactivity ? ['secondaryReactivity'] : []), ...(confidenceReactivity ? ['ssrPreviousSurface', 'ssrSurface'] : [])]) {
      assert.ok(cache[key], `Settle input is missing ${key}; extract the matching captured inputs first`);
      cache[key].bytes = new Uint8Array(readFileSync(`${settlePrefix}-${phase}/taa-feedback-${key}.bin`));
      assert.equal(createHash('sha256').update(cache[key].bytes).digest('hex'), cache[key].digest);
    }
    return cache;
  });
  const finalIndex = frames.at(-1).frameIndex;
  for (let step = 1; step <= 32; step++) {
    const frameIndex = finalIndex + step;
    const input = settled.find(row => row.frameIndex % 8 === frameIndex % 8);
    assert.ok(input);
    const bytes = input.params.bytes.slice();
    const params = new DataView(bytes.buffer, bytes.byteOffset);
    params.setUint32(8, 1, true);
    params.setUint32(12, frameIndex, true);
    frames.push({ ...input, frameIndex, sourceFrameIndex: input.frameIndex, params: { ...input.params, bytes } });
  }
}
// Compare variants/captures from the same point in the eight-phase jitter
// cycle. Capture start time must not choose a different warmup initial phase.
const cycle = frames.slice();
if (!journey) while (cycle[0].frameIndex % 8 !== 0) cycle.push(cycle.shift());
for (const frame of frames) {
  const bytes = frame.params.bytes;
  const enabled = bytes.byteLength >= 20 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(16, true) !== 0;
  assert.equal(enabled, secondaryReactivity,
    'Captured secondary mask must not be silently dropped or fabricated; match --secondary-reactivity to the tape');
}

const referenceTape = decodeTape(new Uint8Array(readFileSync(`${prefix}-0/frame.rhitape`))).unwrap();
const integrationReference = journey ? undefined : readCapturedTaaReference(prefix);
if (integrationReference) assert.deepEqual([...integrationReference.inputDigests].sort(), frames.map(f => f.digest).sort());
const backend = await bootstrapDawn('TAA feedback variants', referenceTape);
const device = backend.freshDevice;
const { width, height } = frames[0].color;
assert.equal(width * 8 % 256, 0, 'This diagnostic currently requires aligned rows');
const usage = GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
const texture = (label, format = 'rgba16float', size = { width, height }) => {
  const texture = device.createTexture({ label, size: { ...size, depthOrArrayLayers: 1 }, format, usage }).unwrap();
  return { texture, view: device.createTextureView(texture, {}).unwrap() };
};
const color = texture('recorded-color'), temporal = texture('recorded-temporal');
const secondaryMask = secondaryReactivity ? texture('recorded-secondary-reactivity', 'r32float', {
  width: frames[0].secondaryReactivity.width, height: frames[0].secondaryReactivity.height,
}) : undefined;
const history = [texture('feedback-color-0', historyFormat), texture('feedback-color-1', historyFormat)];
const metadata = [texture('feedback-temporal-0'), texture('feedback-temporal-1')];
const stability = [texture('feedback-stability-0', stabilityFormat), texture('feedback-stability-1', stabilityFormat)];
const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }).unwrap();
const nearest = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }).unwrap();
const params = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }).unwrap();
const historyPixelBytes = historyFormat === 'rgba32float' ? 16 : 8;
const imageBytes = width * height * historyPixelBytes;
const metadataBytes = width * height * 8;
const readback = device.createBuffer({ size: imageBytes + (journey ? metadataBytes : 0), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }).unwrap();
const decodeHalf = bytes => {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from({ length: bytes.byteLength / 2 }, (_, i) => halfToFloat(data.getUint16(i * 2, true)));
};
const saveDisplay = (path, values) => {
  const rgba = Uint8Array.from(values, (value, i) => i % 4 === 3 ? 255
    : Math.round(Math.min(1, Math.max(0, value)) ** (1 / 2.2) * 255));
  writeFileSync(path, writeReferencePng(rgba, width, height));
};
const outputsLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
const inputLayout = device.createBindGroupLayout({ entries: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(binding => ({
  binding, visibility: GPUShaderStage.FRAGMENT,
  ...(binding === 8 ? { buffer: { type: 'uniform' } } : binding < 8 && binding % 2 ? { sampler: { type: binding >= 5 ? 'non-filtering' : 'filtering' } } : { texture: { sampleType: binding === 10 || binding === 2 && historyFormat === 'rgba32float' ? 'unfilterable-float' : 'float', viewDimension: '2d' } }),
})) }).unwrap();
const layout = device.createPipelineLayout({ bindGroupLayouts: [outputsLayout, inputLayout] }).unwrap();
const emptyGroup = device.createBindGroup({ layout: outputsLayout, entries: [] }).unwrap();
const inputs = history.map((h, i) => device.createBindGroup({ layout: inputLayout, entries: [color.view, sampler, h.view, sampler, metadata[i].view, nearest, temporal.view, nearest, params, stability[i].view, secondaryMask?.view ?? temporal.view].map((value, binding) => ({
  binding, resource: binding === 8 ? { kind: 'buffer', value: { buffer: value } } : { kind: binding < 8 && binding % 2 ? 'sampler' : 'textureView', value },
})) }).unwrap());
const upload = (target, bytes) => {
  const wide = historyFormat === 'rgba32float' && history.includes(target);
  device.queue.writeTexture({ texture: target.texture, mipLevel: 0, origin: [0, 0, 0] }, wide ? decodeHalf(bytes) : bytes,
    { offset: 0, bytesPerRow: width * (wide ? 16 : 8), rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 }).unwrap();
};
const implementationPath = process.argv.find(arg => arg.startsWith('--implementation-shader='))?.slice(24)
  ?? 'packages/shader/src/taa-resolve.wgsl';
const implementation = readFileSync(resolve(implementationPath), 'utf8').replace(/^#define_import_path.*$/gm, '');
const baselinePath = process.argv.find(arg => arg.startsWith('--baseline-shader='))?.slice(18);
assert.ok(baselinePath, 'Pass --baseline-shader with the preserved pre-change shader; never silently change the diagnostic baseline');
const production = readFileSync(resolve(baselinePath), 'utf8').replace(/^#define_import_path.*$/gm, '');
assert.ok(production.includes('fn neighborhood3x3('), 'Legacy counterfactual variants require the original 3x3 baseline');
const raw = production.replace('in.uv + params.currentJitterUv', 'in.uv');
// Three.js TRAANode/TAAUtils, pinned in the SSR checkpoint references (MIT):
// RGB moments, gamma=1 for stationary input, and center-directed AABB clipping.
const variance = raw.replace(/fn clipTaaHistory\([\s\S]*?\n}\n/, `fn clipTaaHistory(current : vec3<f32>, neighbors : array<vec3<f32>, 8>, history : vec3<f32>) -> vec3<f32> {
  var moment1 = max(current, vec3<f32>(0.0));
  var moment2 = moment1 * moment1;
  for (var i = 0u; i < 8u; i++) {
    let sample = max(neighbors[i], vec3<f32>(0.0));
    moment1 += sample;
    moment2 += sample * sample;
  }
  let mean = moment1 / 9.0;
  let extent = sqrt(max(moment2 / 9.0 - mean * mean, vec3<f32>(0.0))) + vec3<f32>(1e-7);
  let delta = history - mean;
  let unit = abs(delta / extent);
  return mean + delta / max(1.0, max(unit.x, max(unit.y, unit.z)));
}
`);
const variants = {
  implementation,
  // Falsify the remaining phase-dependent bounds: a settled 5x5 footprint
  // centered on nearest is fixed throughout this subpixel jitter cycle.
  // Motion and the first eight accepted stationary frames retain 3x3 bounds.
  'implementation-fixed-bounds': implementation
    .replaceAll('array<vec3<f32>, 16>', 'array<vec3<f32>, 25>')
    .replace('i < 16u', 'i < 25u')
    .replace('let pixel = vec2<i32>(floor(uv * vec2<f32>(dimensions) - vec2<f32>(0.5)));',
      'let pixel = vec2<i32>(uv * vec2<f32>(dimensions));')
    .replace('var y = -1; y <= 2', 'var y = -2; y <= 2')
    .replace('var x = -1; x <= 2', 'var x = -2; x <= 2'),
  production,
  'raw-current': raw,
  'raw-current-variance': variance,
  // Isolate clipping from reconstruction: the raw-current experiment changes
  // both, so it cannot establish whether variance clipping itself helps.
  'filtered-current-variance': variance.replace('let currentUv = in.uv;', 'let currentUv = in.uv + params.currentJitterUv;'),
  'filtered-current-variance-wide': variance.replace('let currentUv = in.uv;', 'let currentUv = in.uv + params.currentJitterUv;')
    .replace('let extent = sqrt(', 'let extent = 2.0 * sqrt('),
  // A diagnostic upper bound on accumulation, explicitly unsafe under motion.
  'no-clipping-diagnostic': production.replace('clipTaaHistory(current.rgb, neighborhood3x3(currentUv), history.rgb)', 'history.rgb'),
  // The bilinear reconstructed center is not the raw center texel. Preserve
  // all nine raw extrema without increasing the spatial clipping footprint.
  'complete-current-bounds': production
    .replace('if (x == 0 && y == 0) { continue; }', '')
    .replaceAll('array<vec3<f32>, 8>', 'array<vec3<f32>, 9>')
    .replace('i < 8u', 'i < 9u'),
  // Diagnose whether reconstruction support exceeds the 3x3 clipping window.
  // This retains clipping, but is not accepted without moving/disocclusion
  // evidence: a wider color box can preserve unrelated historical radiance.
  'wide-current-bounds': production
    .replace(/fn neighborhood3x3\([\s\S]*?\n}\n/, source => source
      .replace('var y = -1; y <= 1', 'var y = -2; y <= 2')
      .replace('var x = -1; x <= 1', 'var x = -2; x <= 2')
      .replace('if (x == 0 && y == 0) { continue; }', ''))
    .replaceAll('array<vec3<f32>, 8>', 'array<vec3<f32>, 25>')
    .replace('i < 8u', 'i < 25u'),
  // Union of the raw texels supporting a 3x3 bilinear neighborhood.
  // Its lower corner follows the interpolation cell, not nearest rounding.
  'reconstruction-footprint-bounds': production
    .replace(/fn neighborhood3x3\([\s\S]*?\n}\n/, source => source
      .replace('vec2<i32>(uv * vec2<f32>(dimensions))',
        'vec2<i32>(floor(uv * vec2<f32>(dimensions) - vec2<f32>(0.5)))')
      .replace('var y = -1; y <= 1', 'var y = -1; y <= 2')
      .replace('var x = -1; x <= 1', 'var x = -1; x <= 2')
      .replace('if (x == 0 && y == 0) { continue; }', ''))
    .replaceAll('array<vec3<f32>, 8>', 'array<vec3<f32>, 16>')
    .replace('i < 8u', 'i < 16u'),
};
variants['motion-gated-footprint'] = variants['reconstruction-footprint-bounds']
  .replace('fn neighborhood3x3(uv : vec2<f32>)',
    'fn neighborhood3x3(uv : vec2<f32>, current : vec3<f32>, wide : bool)')
  .replace('samples[index] = textureLoad(currentColor, clamp(pixel + vec2<i32>(x, y), vec2<i32>(0), dimensions - vec2<i32>(1)), 0).rgb;', `
      let delta = pixel + vec2<i32>(x, y) - vec2<i32>(uv * vec2<f32>(dimensions));
      if (!wide && (any(abs(delta) > vec2<i32>(1)) || all(delta == vec2<i32>(0)))) {
        samples[index] = current;
      } else {
        samples[index] = textureLoad(currentColor, clamp(pixel + vec2<i32>(x, y), vec2<i32>(0), dimensions - vec2<i32>(1)), 0).rgb;
      }`)
  .replace('neighborhood3x3(currentUv)',
    'neighborhood3x3(currentUv, current.rgb, max(length(temporal.xy), length(previousTemporal.xy)) < 1e-5)');
variants['implementation-static-weight'] = implementation.replace(
  'taaAccumulationWeight(params.temporalFrameIndex, 0.95)',
  'taaAccumulationWeight(params.temporalFrameIndex, select(0.95, 0.99, stableAge >= TAA_STABILITY_FRAMES))');
// Counterfactual only: keep fast recovery through 64 accepted stationary
// frames, then ramp the history weight over another 64. The 4x4 footprint
// still starts at eight frames; extending the private age is not permission
// to change motion/clip semantics or to declare moving-light acceptance.
variants['implementation-late-weight'] = implementation
  .replace('const TAA_STABILITY_FRAMES : f32 = 8.0;', 'const TAA_STABILITY_FRAMES : f32 = 128.0;')
  .replaceAll('stableAge >= TAA_STABILITY_FRAMES', 'stableAge >= 8.0')
  .replace('taaAccumulationWeight(params.temporalFrameIndex, 0.95)',
    'taaAccumulationWeight(params.temporalFrameIndex, mix(0.95, 0.99, smoothstep(64.0, 128.0, stableAge)))');
variants['implementation-nearest-half'] = implementation.replace(
  'vec4<f32>(resolved, current.a)', 'vec4<f32>(quantizeToF16(resolved), current.a)');
variants['implementation-static-weight-nearest-half'] = variants['implementation-static-weight'].replace(
  'vec4<f32>(resolved, current.a)', 'vec4<f32>(quantizeToF16(resolved), current.a)');
const unbiasedHalf = `
fn diagnosticHalfNoise(pixel : vec2<u32>, frame : u32) -> f32 {
  var bits = pixel.x * 0x9e3779b9u + pixel.y * 0x85ebca6bu + frame * 0xc2b2ae35u;
  bits = (bits ^ (bits >> 16u)) * 0x7feb352du;
  bits = (bits ^ (bits >> 15u)) * 0x846ca68bu;
  bits = bits ^ (bits >> 16u);
  return f32(bits >> 8u) / 16777216.0;
}
fn diagnosticHalfRound(color : vec3<f32>, noise : f32) -> vec3<f32> {
  let magnitude = min(abs(color), vec3<f32>(65504.0));
  let exponent = (bitcast<vec3<u32>>(magnitude) >> vec3<u32>(23u)) & vec3<u32>(255u);
  let step = bitcast<vec3<f32>>((max(exponent, vec3<u32>(113u)) - vec3<u32>(10u)) << vec3<u32>(23u));
  let scaled = magnitude / step;
  let integral = floor(scaled);
  let rounded = (integral + select(vec3<f32>(0.0), vec3<f32>(1.0), vec3<f32>(noise) < scaled - integral)) * step;
  return select(rounded, -rounded, color < vec3<f32>(0.0));
}
`;
for (const name of ['implementation', 'implementation-static-weight']) {
  variants[`${name}-unbiased-half`] = variants[name].replace('vec4<f32>(resolved, current.a)',
    'vec4<f32>(diagnosticHalfRound(resolved, diagnosticHalfNoise(vec2<u32>(in.position.xy), params.temporalFrameIndex)), current.a)') + unbiasedHalf;
}
variants['implementation-fixed-static-weight'] = variants['implementation-fixed-bounds'].replace(
  'taaAccumulationWeight(params.temporalFrameIndex, 0.95)',
  'taaAccumulationWeight(params.temporalFrameIndex, select(0.95, 0.99, stableAge >= TAA_STABILITY_FRAMES))');
// Instantaneous zero velocity does not imply settled history. Retain the
// original motion clip during the first stable jitter cycle after a stop.
// This standalone diagnostic repurposes its own metadata alpha. The real TAA
// attachment is also consumed by downstream effects as temporal-v1, so this
// state cannot be copied into production without separate private storage.
variants['settled-footprint'] = variants['motion-gated-footprint']
  .replace('  let clippedHistoryRgb =', `
  let stableAge = select(0.0, min(previousTemporal.w + 1.0, 8.0),
    !rejected && temporal.w == 0.0 && max(length(temporal.xy), length(previousTemporal.xy)) < 1e-5);
  let clippedHistoryRgb =`)
  .replace('neighborhood3x3(currentUv, current.rgb, max(length(temporal.xy), length(previousTemporal.xy)) < 1e-5)',
    'neighborhood3x3(currentUv, current.rgb, stableAge >= 8.0)')
  .replace('    temporal,\n  );', '    vec4<f32>(temporal.xyz, stableAge),\n  );');
assert.ok(variants['settled-footprint'].includes('vec4<f32>(temporal.xyz, stableAge)'));
// Three.js TRAANode's subpixel phase correction reduces recycled interpolation
// blur under motion. Keep our existing velocity/rejection policy as an upper
// bound on history trust; this is a diagnostic, not a production adoption.
variants['subpixel-gated-footprint'] = variants['motion-gated-footprint']
  .replace('let historyWeight = progressiveWeight * reactiveFactor * velocityFactor;', `
  let phase = fract(temporal.xy * vec2<f32>(dimensions));
  let axisWeight = max(phase, vec2<f32>(1.0) - phase);
  let subpixel = (1.0 - axisWeight.x * axisWeight.y) / 0.75;
  let historyWeight = min(progressiveWeight * velocityFactor, 0.95 - 0.25 * subpixel) * reactiveFactor;`);
// Test stronger moving-history validation instead of increasing its weight.
// The stationary branch covers reconstruction support; the moving branch uses
// Three's RGB variance clip on the original 3x3 support (not padded samples).
const movingClip = variance.match(/fn clipTaaHistory\([\s\S]*?\n}\n/)[0]
  .replace('clipTaaHistory', 'clipMovingTaaHistory');
const stationaryClip = variants['reconstruction-footprint-bounds']
  .match(/fn clipTaaHistory\([\s\S]*?\n}\n/)[0].replace('clipTaaHistory', 'clipStationaryTaaHistory');
const stationaryNeighborhood = variants['reconstruction-footprint-bounds']
  .match(/fn neighborhood3x3\([\s\S]*?\n}\n/)[0].replace('neighborhood3x3', 'stationaryNeighborhood');
variants['motion-variance-footprint'] = production
  .replace(/fn clipTaaHistory\([\s\S]*?\n}\n/, movingClip + stationaryClip + stationaryNeighborhood)
  .replace('let clippedHistoryRgb = clipTaaHistory(current.rgb, neighborhood3x3(currentUv), history.rgb);', `
  var clippedHistoryRgb : vec3<f32>;
  if (max(length(temporal.xy), length(previousTemporal.xy)) < 1e-5) {
    clippedHistoryRgb = clipStationaryTaaHistory(current.rgb, stationaryNeighborhood(currentUv), history.rgb);
  } else {
    clippedHistoryRgb = clipMovingTaaHistory(current.rgb, neighborhood3x3(currentUv), history.rgb);
  }`);
// Test the user's bounded HDR-space resolve separately from luminance-only
// weighting. Clip and accumulate in the compressed space, then invert once.
let toneMapped = production
  .replace(/fn blendTaaHistory\([\s\S]*?\n}\n/, `fn blendTaaHistory(current : vec3<f32>, history : vec3<f32>, historyWeight : f32) -> vec3<f32> {
  return mix(current, history, historyWeight);
}
fn taaCompress(value : vec3<f32>) -> vec3<f32> {
  let positive = max(value, vec3<f32>(0.0));
  return positive / (vec3<f32>(1.0) + positive);
}
fn taaExpand(value : vec3<f32>) -> vec3<f32> {
  return value / max(vec3<f32>(1.0) - value, vec3<f32>(1e-6));
}
`)
  .replace('let current = textureSampleLevel(currentColor, currentSampler, currentUv, 0.0);',
    'let currentHdr = textureSampleLevel(currentColor, currentSampler, currentUv, 0.0);\n  let current = vec4<f32>(taaCompress(currentHdr.rgb), currentHdr.a);')
  .replace('let history = textureSampleLevel(historyColor, historySampler, historyUv, 0.0);',
    'let historyHdr = textureSampleLevel(historyColor, historySampler, historyUv, 0.0);\n  let history = vec4<f32>(taaCompress(historyHdr.rgb), historyHdr.a);')
  .replace(/samples\[index\] = (textureLoad\(currentColor,[^;]+\.rgb);/, 'samples[index] = taaCompress($1);')
  .replace('vec4<f32>(resolved, current.a)', 'vec4<f32>(taaExpand(resolved), current.a)');
assert.ok(toneMapped.includes('samples[index] = taaCompress('));
variants['tone-map-space'] = toneMapped;
variants['tone-map-rgb'] = toneMapped
  .replace('var clipMin = rgbToYCoCg(current);', 'var clipMin = current;')
  .replace('let sample = rgbToYCoCg(neighbors[i]);', 'let sample = neighbors[i];')
  .replace('return yCoCgToRgb(clamp(rgbToYCoCg(history), clipMin, clipMax));',
    'return clamp(history, clipMin, clipMax);');
const selectedVariant = process.argv[3];
if (selectedVariant !== undefined) assert.ok(Object.hasOwn(variants, selectedVariant));
if (selectedVariant === undefined || /(?:nearest|unbiased)-half$/.test(selectedVariant)) {
  assert.ok(implementation.includes('vec4<f32>(resolved, current.a)'),
    'Historical rounding experiments need --implementation-shader with the preserved raw FP16 output; refuse a silent no-op');
}
const results = [];
try {
  for (const [name, variantSource] of Object.entries(variants)) {
    if (selectedVariant !== undefined && name !== selectedVariant) continue;
    let source = variantSource;
    if (historyFormat === 'rgba32float') {
      const sample = 'textureSampleLevel(historyColor, historySampler, historyUv, 0.0)';
      assert.ok(source.includes(sample));
      source = source.replace(sample, 'sampleDiagnosticHistory(historyUv)') + `
fn sampleDiagnosticHistory(uv : vec2<f32>) -> vec4<f32> {
  let dimensions = vec2<i32>(textureDimensions(historyColor));
  let position = uv * vec2<f32>(dimensions) - vec2<f32>(0.5);
  let first = vec2<i32>(floor(position));
  let fraction = fract(position);
  let a = textureLoad(historyColor, clamp(first, vec2<i32>(0), dimensions - vec2<i32>(1)), 0);
  let b = textureLoad(historyColor, clamp(first + vec2<i32>(1, 0), vec2<i32>(0), dimensions - vec2<i32>(1)), 0);
  let c = textureLoad(historyColor, clamp(first + vec2<i32>(0, 1), vec2<i32>(0), dimensions - vec2<i32>(1)), 0);
  let d = textureLoad(historyColor, clamp(first + vec2<i32>(1), vec2<i32>(0), dimensions - vec2<i32>(1)), 0);
  return mix(mix(a, b, fraction.x), mix(c, d, fraction.x), fraction.y);
}
`;
    }
    const shaderDigest = createHash('sha256').update(source).digest('hex');
    writeFileSync(`${resultPrefix}-${name}-${shaderDigest}.wgsl`, source);
    // Execute the actual fragment entry and attachment formats. In particular,
    // stability must pass through real r8unorm quantization, not metadata.w.
    const privateStability = ['implementation', 'implementation-late-weight', 'implementation-fixed-bounds',
      'implementation-static-weight', 'implementation-fixed-static-weight',
      'implementation-nearest-half', 'implementation-static-weight-nearest-half',
      'implementation-unbiased-half', 'implementation-static-weight-unbiased-half'].includes(name);
    const module = (await backend.rhiWebgpu.createShaderModule(device, { code: source })).unwrap();
    const pipeline = device.createRenderPipeline({ layout,
      vertex: { module, entryPoint: 'vs_main', buffers: [] },
      fragment: { module, entryPoint: 'fs_main', targets: [
        { format: historyFormat }, { format: 'rgba16float' },
        ...(privateStability ? [{ format: stabilityFormat }] : []),
      ] }, primitive: { topology: 'triangle-list' },
    }).unwrap();
    for (const h of history) upload(h, (journey ? frames[0].history : frames[0].color).bytes);
    for (const m of metadata) upload(m, (journey ? frames[0].historyTemporal : frames[0].temporal).bytes);
    // The old capture has no private age. Seed settled history at one; the
    // first moving/rejected fragment must reset it through production logic.
    const statisticsBytes = stabilityFormat === 'r8unorm'
      ? new Uint8Array(width * height).fill(journey ? 255 : 0)
      : new Uint16Array(width * height * 4);
    if (stabilityFormat === 'rgba16float' && journey) {
      // A historical capture has no variance payload. Seed only its age;
      // never present this cold statistics seed as warm full-renderer history.
      for (let i = 0; i < width * height; i++) statisticsBytes[i * 4] = 0x3c00;
    }
    for (const s of stability) device.queue.writeTexture({ texture: s.texture }, statisticsBytes,
      { bytesPerRow: width * (stabilityFormat === 'r8unorm' ? 1 : 8), rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 }).unwrap();
    const samples = journey ? [decodeHalf(frames[0].history.bytes)] : [];
    const temporalSamples = journey ? [decodeHalf(frames[0].historyTemporal.bytes)] : [];
    const firstRead = journey ? 0 : warmupFrames - 1;
    for (let frame = 0; frame < (journey ? cycle.length : warmupFrames + 8); frame++) {
      const input = cycle[frame % cycle.length];
      upload(color, input.color.bytes); upload(temporal, input.temporal.bytes);
      if (secondaryMask) {
        const mask = input.secondaryReactivity;
        assert.equal(mask.format, 'r32float');
        assert.equal(mask.width, frames[0].secondaryReactivity.width);
        assert.equal(mask.height, frames[0].secondaryReactivity.height);
        assert.equal(mask.bytes.byteLength, mask.width * mask.height * 4);
        let maskBytes = mask.bytes;
        if (confidenceReactivity) {
          const prior = input.ssrPreviousSurface, current = input.ssrSurface;
          assert.equal(prior.width, mask.width); assert.equal(current.width, mask.width);
          assert.equal(prior.height, mask.height); assert.equal(current.height, mask.height);
          const values = new Float32Array(mask.bytes.slice().buffer);
          // Diagnostic only: fixed-lattice confidence changes on stationary
          // receivers. It does not reconstruct moving-surface reprojection
          // or a production raster-space reactivity output.
          for (let i = 0; i < values.length; i++) {
            const change = Math.abs(current.bytes[i * 4 + 3] - prior.bytes[i * 4 + 3]);
            values[i] = Math.max(values[i], Math.max(0, change - 2) / 255);
          }
          maskBytes = new Uint8Array(values.buffer);
        }
        device.queue.writeTexture({ texture: secondaryMask.texture }, maskBytes,
          { bytesPerRow: mask.width * 4, rowsPerImage: mask.height },
          { width: mask.width, height: mask.height, depthOrArrayLayers: 1 }).unwrap();
      }
      const payload = new Uint8Array(32);
      payload.set(input.params.bytes);
      const data = new DataView(payload.buffer, payload.byteOffset);
      if (!journey) {
        data.setUint32(8, Number(frame > 0), true); data.setUint32(12, frame, true);
      }
      device.queue.writeBuffer(params, 0, payload).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const index = (frame + 1) % 2;
      const pass = encoder.beginRenderPass({ colorAttachments: [history[index], metadata[index],
        ...(privateStability ? [stability[index]] : [])].map(target => ({ view: target.view,
          loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } })) });
      pass.setPipeline(pipeline); pass.setBindGroup(0, emptyGroup); pass.setBindGroup(1, inputs[frame % 2]);
      pass.draw(3, 1, 0, 0); pass.end();
      if (frame >= firstRead) encoder.copyTextureToBuffer({ texture: history[(frame + 1) % 2].texture, mipLevel: 0, origin: [0, 0, 0] },
        { buffer: readback, offset: 0, bytesPerRow: width * historyPixelBytes, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
      if (journey) encoder.copyTextureToBuffer({ texture: metadata[(frame + 1) % 2].texture, mipLevel: 0, origin: [0, 0, 0] },
        { buffer: readback, offset: imageBytes, bytesPerRow: width * 8, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 });
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      if (frame % 8 === 7) await device.queue.onSubmittedWorkDone();
      if (frame >= firstRead) {
        const mapped = (await readback.mapAsync(GPUMapMode.READ)).unwrap();
        const bytes = mapped.getMappedRange().unwrap().slice(0);
        mapped.unmap();
        const data = new DataView(bytes);
        const sample = Float32Array.from({ length: width * height * 4 }, (_, i) => historyFormat === 'rgba32float'
          ? data.getFloat32(i * 4, true) : halfToFloat(data.getUint16(i * 2, true)));
        assert.ok(sample.every(Number.isFinite));
        samples.push(sample);
        if (journey) {
          temporalSamples.push(decodeHalf(new Uint8Array(bytes, imageBytes, metadataBytes)));
          if (frame < 8 || frame % 8 === 7) saveDisplay(`${resultPrefix}-${name}-frame-${frame}.png`, sample);
        }
      }
    }
    const regions = {};
    const outputFrames = [];
    if (exportFrames) for (let phase = 1; phase < samples.length; phase++) {
      const path = `${resultPrefix}-${name}-frame-${phase - 1}.rgba32f.bin`;
      const bytes = new Uint8Array(samples[phase].buffer);
      writeFileSync(path, bytes);
      outputFrames.push({ inputFrameIndex: cycle[(phase - 1) % cycle.length].frameIndex, path,
        digest: createHash('sha256').update(bytes).digest('hex') });
    }
    for (const [region, lower, upper] of [['wall', 0.2, 0.5], ['contact', 0.47, 0.56], ['reflection', 0.52, 0.78]]) {
      const phases = [];
      for (let phase = 1; phase < samples.length; phase++) {
        const deltas = [];
        let gradient = 0;
        let worst;
        for (let y = Math.floor(height * lower); y < height * upper; y++) for (let x = Math.floor(width * 0.15); x < width * 0.85; x++) {
          const p = (y * width + x) * 4;
          const delta = Math.max(...[0, 1, 2].map(c => Math.abs(samples[phase][p + c] - samples[phase - 1][p + c])));
          deltas.push(delta);
          if (worst === undefined || delta > worst.delta) worst = {
            x, y, delta, output: [...samples[phase].slice(p, p + 3)],
            history: [...samples[phase - 1].slice(p, p + 3)],
          };
          gradient += Math.max(...[0, 1, 2].map(c => Math.abs(samples[phase][p + c] - samples[phase][p + c + 4])));
        }
        deltas.sort((a,b) => a-b);
        phases.push({ inputFrameIndex: cycle[(phase - 1) % cycle.length].frameIndex,
          mean: deltas.reduce((sum, value) => sum + value, 0) / deltas.length,
          p99: deltas[Math.floor(deltas.length * .99)], maximum: deltas.at(-1),
          worst, meanGradient: gradient / deltas.length });
      }
      regions[region] = phases;
    }
    const disocclusion = [];
    if (journey) for (let phase = 1; phase < samples.length; phase++) {
      const input = frames[phase - 1];
      const color = decodeHalf(input.color.bytes);
      const params = new DataView(input.params.bytes.buffer, input.params.bytes.byteOffset);
      const jitterX = params.getFloat32(0, true) * width;
      const jitterY = params.getFloat32(4, true) * height;
      const temporal = temporalSamples[phase], previous = temporalSamples[phase - 1];
      let movingPixels = 0, rejectedPixels = 0, maximumRejectedError = 0;
      let worst;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        movingPixels += Number(Math.hypot(temporal[p], temporal[p + 1]) > 1e-5);
        const hx = (x + 0.5) / width - temporal[p], hy = (y + 0.5) / height - temporal[p + 1];
        const q = (Math.min(height - 1, Math.max(0, Math.floor(hy * height))) * width
          + Math.min(width - 1, Math.max(0, Math.floor(hx * width)))) * 4;
        const rejected = params.getUint32(8, true) === 0 || hx < 0 || hy < 0 || hx > 1 || hy > 1
          || temporal[p + 2] < 0 || previous[q + 2] < 0
          || Math.abs(temporal[p + 2] - previous[q + 2]) > 0.0025 + temporal[p + 2] * 0.01;
        if (!rejected) continue;
        rejectedPixels++;
        const sx = x + jitterX, sy = y + jitterY, x0 = Math.floor(sx), y0 = Math.floor(sy);
        const fx = sx - x0, fy = sy - y0;
        const tap = (dx, dy, channel) => color[(Math.min(height - 1, Math.max(0, y0 + dy)) * width
          + Math.min(width - 1, Math.max(0, x0 + dx))) * 4 + channel];
        const expected = [0, 1, 2].map(c => tap(0, 0, c) * (1 - fx) * (1 - fy)
          + tap(1, 0, c) * fx * (1 - fy) + tap(0, 1, c) * (1 - fx) * fy + tap(1, 1, c) * fx * fy);
        const error = Math.max(...expected.map((value, c) => Math.abs(value - samples[phase][p + c])));
        if (error > maximumRejectedError) {
          maximumRejectedError = error;
          worst = { x, y, expected, output: [...samples[phase].slice(p, p + 3)] };
        }
      }
      disocclusion.push({ inputFrameIndex: input.frameIndex, movingPixels, rejectedPixels, maximumRejectedError, worst });
    }
    if (journey) assert.ok(disocclusion.some(frame => frame.movingPixels > 0), 'Journey did not produce real motion vectors');
    const result = { name, shaderDigest, regions, ...(journey ? { disocclusion } : {}),
      ...(integrationReference === undefined ? {} : { referencePhases: samples.slice(1).map((values, phase) => ({
        inputFrameIndex: cycle[phase % cycle.length].frameIndex,
        regions: measureTaaReferenceRegions(values, integrationReference),
      })) }),
      ...(exportFrames ? { outputFrames } : {}) };
    results.push(result); console.log(JSON.stringify(result));
  }
  writeFileSync(`${resultPrefix}-feedback-${selectedVariant ?? 'comparison'}.json`, JSON.stringify({
    execution: 'fragment-raster', historyFormat, stabilityFormat,
    ...(stabilityFormat === 'rgba16float' ? { statisticsSeed: journey ? 'settled-age-zero-variance' : 'zero-age-zero-variance' } : {}),
    secondaryReactivity, confidenceReactivity, baselinePath: resolve(baselinePath),
    mode: settlePrefix ? 'spliced-same-pose-settle-gpu-feedback' : journey ? 'recorded-journey-gpu-feedback' : 'recorded-input-gpu-feedback',
    ...(settlePrefix ? { settlePrefix: resolve(settlePrefix), spliceFrame: 8,
      caveat: 'TAA-only recovery experiment; settled SSR inputs replace post-motion SSR evolution',
      sourceFrameIndices: frames.map(frame => frame.sourceFrameIndex ?? frame.frameIndex) } : {}),
    inputDigests: frames.map(f => f.digest), cycleStartFrameIndex: cycle[0].frameIndex,
    ...(integrationReference === undefined ? {} : { referenceKind: 'equal-weight-luminance-compressed-input-cycle',
      referenceCaveat: 'Captured-input integration, not geometric supersampling or full SSR ground truth' }),
    warmupFrames: journey ? 0 : warmupFrames, results }, null, 2));
} finally { device.destroy?.(); }
process.exit(0);
