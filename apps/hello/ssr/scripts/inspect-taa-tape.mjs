import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeTape, buildFrameModel, openReplay, halfToFloat } from '@forgeax/engine-rhi-debug';
import { bootstrapDawn } from '../../../shared/scripts/rhi-debug-verify.mjs';

// Static-camera TAA evidence, independently of the optional SSR pass roster.
const path = resolve(process.argv[2]);
const bytes = new Uint8Array(readFileSync(path));
const tape = decodeTape(bytes).unwrap();
const model = buildFrameModel(tape);
const works = model.works.filter(w => w.pipeline.shaders.some(s => s.source.includes('fn fs_taa_resolve(')));
assert.equal(works.length, 1);
const w = works[0];
// Explicit counterfactual replay: retain the captured resources, commands and
// history, changing only TAA. Never publish this as a live-frame observation.
const candidatePath = process.argv[3] === undefined || process.argv[3].startsWith('--') ? undefined : resolve(process.argv[3]);
const traceShaderPath = process.argv.find(arg => arg.startsWith('--trace-shader='))?.slice(15);
const ssrTemporalShaderPath = process.argv.find(arg => arg.startsWith('--ssr-temporal-shader='))?.slice(22);
let traceCandidate;
if (traceShaderPath !== undefined) {
  assert.equal(candidatePath, undefined, 'Change one shader owner per counterfactual');
  const { compileShader } = await import('../../../../packages/shader-compiler/dist/index.mjs');
  const compiled = await compileShader(readFileSync(resolve(traceShaderPath), 'utf8'), {
    id: 'forgeax_ssr::trace',
    imports: { 'forgeax_view::common': readFileSync(new URL('../../../../packages/shader/src/common.wgsl', import.meta.url), 'utf8') },
  });
  assert.ok(compiled.ok, JSON.stringify(compiled.error));
  traceCandidate = compiled.value.wgsl;
}
let ssrTemporalCandidate;
if (ssrTemporalShaderPath !== undefined) {
  assert.ok(traceCandidate !== undefined && candidatePath === undefined, 'SSR temporal counterfactual requires its trace producer and unchanged TAA');
  const { compileShader } = await import('../../../../packages/shader-compiler/dist/index.mjs');
  const compiled = await compileShader(readFileSync(resolve(ssrTemporalShaderPath), 'utf8'), {
    id: 'forgeax_ssr::temporal',
    imports: { 'forgeax_view::common': readFileSync(new URL('../../../../packages/shader/src/common.wgsl', import.meta.url), 'utf8') },
  });
  assert.ok(compiled.ok, JSON.stringify(compiled.error));
  ssrTemporalCandidate = compiled.value.wgsl;
}
const requestedPixel = process.argv.find(arg => arg.startsWith('--pixel='))?.slice(8).split(',').map(Number);
if (requestedPixel) assert.ok(requestedPixel.length === 2 && requestedPixel.every(v => Number.isInteger(v) && v >= 0));
const rawCurrent = process.argv.includes('--current-raster');
const threeBlend = process.argv.includes('--three-blend');
const centerBounds = process.argv.includes('--center-bounds');
const probeOutput = process.argv.find(arg => arg.startsWith('--probe-output='))?.slice(15);
if (probeOutput !== undefined) {
  assert.ok(['current', 'clipped-history', 'unclipped-resolve'].includes(probeOutput), 'Unknown TAA probe output');
  assert.ok(candidatePath === undefined && !rawCurrent && !threeBlend && !centerBounds,
    'A diagnostic output uses the captured shader without counterfactual edits');
}
assert.ok(!rawCurrent || candidatePath !== undefined, 'A current-raster experiment requires an explicit candidate shader');
let candidateSource = candidatePath === undefined ? undefined : readFileSync(candidatePath, 'utf8').replace(/^#define_import_path.*$/gm, '');
if (probeOutput !== undefined) {
  const captured = w.pipeline.shaders.find(shader => shader.entryPoint === 'fs_main');
  assert.ok(captured?.source.includes('fn fs_taa_resolve('));
  // Read Naga's emitted local names from the actual call sites. Refuse an
  // unfamiliar shader shape instead of substituting the working-tree source.
  const clips = [...captured.source.matchAll(/let (\w+) = clipTaaHistory\(([^;]+)\);/g)];
  const blends = [...captured.source.matchAll(/let (\w+) = blendTaaHistory\((\w+\.xyz), (\w+), (\w+)\);/g)];
  const outputs = [...captured.source.matchAll(/return TaaResolveOutput\(vec4<f32>\((\w+), (\w+\.w)\),/g)];
  assert.equal(clips.length, 1);
  assert.equal(blends.length, 1);
  assert.equal(outputs.length, 1);
  const [, clipped, clipArguments] = clips[0];
  const argumentsList = clipArguments.split(',').map(argument => argument.trim());
  assert.ok(argumentsList.length === 2 || argumentsList.length === 3);
  const historyRgb = argumentsList.at(-1);
  const [, , currentRgb, blendHistory, weight] = blends[0];
  if (argumentsList.length === 3) assert.equal(argumentsList[0], currentRgb);
  assert.equal(blendHistory, clipped);
  const expression = probeOutput === 'current' ? currentRgb : probeOutput === 'clipped-history' ? clipped
    : `blendTaaHistory(${currentRgb}, ${historyRgb}, ${weight})`;
  candidateSource = captured.source.replace(outputs[0][0], `return TaaResolveOutput(vec4<f32>(${expression}, ${outputs[0][2]}),`);
}
if (centerBounds) {
  assert.ok(candidateSource?.includes('if (x == 0 && y == 0) { continue; }'));
  candidateSource = candidateSource.replaceAll('array<vec3<f32>, 8>', 'array<vec3<f32>, 9>')
    .replace('if (x == 0 && y == 0) { continue; }', '')
    .replace('i < 8u', 'i < 9u');
}
if (rawCurrent) {
  assert.ok(candidateSource.includes('in.uv + params.currentJitterUv'));
  candidateSource = candidateSource.replace('in.uv + params.currentJitterUv', 'in.uv');
}
if (threeBlend) {
  assert.ok(candidateSource !== undefined);
  const weighting = /  let unbiasedLumaDelta =[\s\S]*?  let progressiveWeight = [^;]+;/;
  assert.ok(weighting.test(candidateSource));
  candidateSource = candidateSource.replace(weighting,
    '  let progressiveWeight = taaAccumulationWeight(params.temporalFrameIndex, 0.95);');
  const blend = 'mix(current.rgb, clippedHistoryRgb, historyWeight)';
  assert.ok(candidateSource.includes(blend));
  candidateSource = candidateSource.replace(blend, 'probeThreeBlend(current.rgb, clippedHistoryRgb, historyWeight)');
  candidateSource += `
fn probeThreeBlend(current : vec3<f32>, history : vec3<f32>, historyWeight : f32) -> vec3<f32> {
  let compressedCurrent = current / (1.0 + max(current.r, max(current.g, current.b)));
  let compressedHistory = history / (1.0 + max(history.r, max(history.g, history.b)));
  let wc = (1.0 - historyWeight) / (1.0 + luminance(compressedCurrent));
  let wh = historyWeight / (1.0 + luminance(compressedHistory));
  return (current * wc + history * wh) / max(wc + wh, 0.00001);
}
`;
}
const candidateShaderDigest = candidateSource === undefined ? undefined : createHash('sha256').update(candidateSource).digest('hex');
const candidateArtifact = candidateSource === undefined ? undefined : resolve(dirname(path), `taa-candidate-${candidateShaderDigest}.wgsl`);
if (candidateArtifact !== undefined) writeFileSync(candidateArtifact, candidateSource);
const backend = await bootstrapDawn('TAA continuous-frame audit', tape);
const replay = (await openReplay(tape, { device: backend.freshDevice, createShaderModule: (device, descriptor) => backend.rhiWebgpu.createShaderModule(device,
  traceCandidate !== undefined && descriptor.code.includes('fn ssr_trace(')
    ? { ...descriptor, code: traceCandidate }
    : ssrTemporalCandidate !== undefined && descriptor.code.includes('fn ssr_temporal(')
      ? { ...descriptor, code: ssrTemporalCandidate }
    : candidateSource !== undefined && descriptor.code.includes('fn fs_taa_resolve(')
    ? { ...descriptor, code: candidateSource } : descriptor) })).unwrap();
try {
  const binding = slot => w.bindings.find(b => b.groupIndex === 1 && b.binding === slot).resourceId;
  const read = async (id, workIndex = w.workIndex) => {
    const r = (await replay.readResourceAtWork(id, workIndex)).unwrap();
    assert.ok(['rgba16float', 'r32float', 'rgba8unorm', 'r8unorm'].includes(r.format), 'Pixel diagnostics require an explicitly decoded format');
    const d = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength);
    const half = r.format === 'rgba16float';
    const unorm = r.format === 'rgba8unorm' || r.format === 'r8unorm';
    const values = new Float32Array(r.bytes.length / (half ? 2 : unorm ? 1 : 4));
    for (let i = 0; i < values.length; i++) values[i] = half ? halfToFloat(d.getUint16(i * 2, true)) : unorm ? r.bytes[i] / 255 : d.getFloat32(i * 4, true);
    return { ...r, values, channels: r.format === 'r32float' || r.format === 'r8unorm' ? 1 : 4 };
  };
  const p = (await replay.readResourceAtWork(binding(8), w.workIndex)).unwrap();
  const pf = new Float32Array(p.bytes.buffer, p.bytes.byteOffset, 4);
  const pu = new Uint32Array(p.bytes.buffer, p.bytes.byteOffset, 4);
  const out = await read(w.attachments.colorViewHandleIds[0]);
  const current = await read(binding(0));
  const previous = await read(binding(2));
  const temporal = await read(w.attachments.colorViewHandleIds[1]);
  const previousTemporal = await read(binding(4));
  const stabilityBinding = w.bindings.find(b => b.groupIndex === 1 && b.binding === 9);
  const stability = stabilityBinding === undefined ? undefined : await read(w.attachments.colorViewHandleIds[2]);
  const priorStability = stabilityBinding === undefined ? undefined : await read(stabilityBinding.resourceId);
  if (stability) {
    assert.equal(stability.format, 'r8unorm');
    assert.equal(priorStability.format, 'r8unorm');
    assert.notEqual(stabilityBinding.resourceId, binding(4));
  }
  const ssrTraceWork = model.works.find(work => work.pipeline.shaders.some(shader => shader.entryPoint === 'ssr_trace'));
  const ssrTemporalWork = model.works.find(work => work.pipeline.shaders.some(shader => shader.entryPoint === 'ssr_temporal'));
  const ssrBinding = (work, slot) => work.bindings.find(b => b.groupIndex === 0 && b.binding === slot).resourceId;
  let scenePose;
  if (ssrTraceWork) {
    const viewBinding = ssrBinding(ssrTraceWork, 5);
    const view = (await replay.readResourceAtWork(viewBinding, ssrTraceWork.workIndex)).unwrap();
    const values = new DataView(view.bytes.buffer, view.bytes.byteOffset, view.bytes.byteLength);
    scenePose = { resourceId: viewBinding, workIndex: ssrTraceWork.workIndex,
      position: [24, 25, 26].map(index => values.getFloat32(index * 4, true)),
      // Render's View UBO owns the unjittered matrix at floats 196..211.
      unjitteredViewProjection: Array.from({ length: 16 }, (_, index) => values.getFloat32((196 + index) * 4, true)) };
  }
  let secondaryReactivity;
  if (p.bytes.byteLength >= 20 && new DataView(p.bytes.buffer, p.bytes.byteOffset).getUint32(16, true) === 1) {
    assert.ok(ssrTraceWork, 'Secondary source mask requires its captured producer');
    assert.equal(binding(10), ssrBinding(ssrTraceWork, 8), 'Final TAA must consume the trace-owned mask');
    const mask = await read(binding(10));
    const scene = await read(binding(6));
    const witnesses = [];
    let changedStationaryPixels = 0;
    for (let pixel = 0; pixel < out.width * out.height; pixel++) {
      const offset = pixel * 4;
      if (Math.hypot(temporal.values[offset], temporal.values[offset + 1]) > 1e-5
          || temporal.values[offset + 3] <= 0) continue;
      // Closest-depth metadata selection is allowed to dilate receiver
      // motion. Restrict witnesses to neighborhoods stationary everywhere.
      const x = pixel % out.width, y = Math.floor(pixel / out.width);
      let localMotion = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const q = (Math.max(0, Math.min(out.height - 1, y + dy)) * out.width
          + Math.max(0, Math.min(out.width - 1, x + dx))) * 4;
        localMotion = Math.max(localMotion, Math.hypot(scene.values[q], scene.values[q + 1]), scene.values[q + 3]);
      }
      if (localMotion > 1e-5) continue;
      changedStationaryPixels++;
      assert.equal(stability.values[pixel], 0, 'Source motion must reset final TAA stability');
      if (witnesses.length < 8) witnesses.push({ pixel: [x, y], reactive: temporal.values[offset + 3], stability: stability.values[pixel] });
    }
    secondaryReactivity = { producerWorkIndex: ssrTraceWork.workIndex, consumerWorkIndex: w.workIndex,
      resource: binding(10), sourcePositivePixels: mask.values.filter(v => v > 0).length,
      changedStationaryPixels, witnesses };
  }
  const ssrTrace = ssrTraceWork === undefined ? undefined : await read(ssrBinding(ssrTraceWork, 4), ssrTraceWork.workIndex);
  const ssrResolved = ssrTemporalWork === undefined ? undefined : await read(ssrBinding(ssrTemporalWork, 7), ssrTemporalWork.workIndex);
  const ssrHistory = ssrTemporalWork === undefined ? undefined : await read(ssrBinding(ssrTemporalWork, 3), ssrTemporalWork.workIndex);
  const confidenceResource = slot => ssrTemporalWork?.bindings.find(b => b.groupIndex === 0 && b.binding === slot)?.resourceId;
  const previousConfidence = confidenceResource(9) === undefined ? undefined : await read(confidenceResource(9), ssrTemporalWork.workIndex);
  const resolvedConfidence = confidenceResource(10) === undefined ? undefined : await read(confidenceResource(10), ssrTemporalWork.workIndex);
  const composeWork = model.works.find(work => work.pipeline.shaders.some(shader => shader.entryPoint === 'fs_ssr_compose'));
  const compositionInputs = composeWork === undefined ? undefined : {};
  // One replay session owns a mutable event cursor. Resource readbacks must
  // execute serially; concurrent seek/replay calls corrupt its pass state.
  if (composeWork) for (const [name, slot] of [['fallback', 1], ['response', 2], ['normalRoughness', 3]]) {
    compositionInputs[name] = await read(ssrBinding(composeWork, slot), composeWork.workIndex);
  }
  const deltas = [];
  let invalid = 0, reactive = 0, depthRejected = 0, moving = 0;
  // Upper central wall region excludes the reflective floor and screen edges.
  for (let y = Math.floor(out.height * 0.15); y < out.height * 0.45; y++) {
    for (let x = Math.floor(out.width * 0.2); x < out.width * 0.8; x++) {
      const i = (y * out.width + x) * 4;
      const t = temporal.values;
      invalid += Number(t[i + 2] < 0);
      reactive += Number(t[i + 3] >= 1);
      moving += Number(Math.hypot(t[i], t[i + 1]) > 0.00001);
      depthRejected += Number(Math.abs(t[i + 2] - previousTemporal.values[i + 2]) > 0.0025 + t[i + 2] * 0.01);
      deltas.push(Math.max(...[0, 1, 2].map(c => Math.abs(out.values[i + c] - previous.values[i + c]))));
    }
  }
  deltas.sort((a, b) => a - b);
  const effectiveTaaSource = candidateSource ?? w.pipeline.shaders.find(shader => shader.source.includes('fn fs_taa_resolve(')).source;
  const clipStreakEncoding = effectiveTaaSource.includes('fn resolveTaaClipping(');
  const acceptedAge = value => Math.min(128, Math.round(value * (clipStreakEncoding ? 255 : 128)));
  const reducedBounds = /fn taaNeighborhood\([\s\S]*?\)\s*->\s*TaaBounds/.test(effectiveTaaSource);
  const footprintCount = reducedBounds ? 25 : Number(effectiveTaaSource.match(/fn taaNeighborhood\([\s\S]*?\)\s*->\s*array<vec3<f32>,\s*(\d+)u?>/)?.[1]);
  const edgeRegion = (top, bottom) => {
    const changes = [];
    const fixedRegionChanges = [];
    const worstPixels = [];
    let requested;
    let rejected = 0;
    for (let y = Math.floor(out.height * top); y < out.height * bottom; y++) {
      for (let x = Math.floor(out.width * 0.15); x < out.width * 0.85; x++) {
        const i = (y * out.width + x) * 4;
        const delta = Math.max(...[0, 1, 2].map(c => Math.abs(out.values[i + c] - previous.values[i + c])));
        fixedRegionChanges.push(delta);
        const isRequested = requestedPixel?.[0] === x && requestedPixel?.[1] === y;
        if (isRequested || worstPixels.length < 10 || delta > worstPixels[worstPixels.length - 1].delta) {
          const sampleX = x + (rawCurrent ? 0 : pf[0]) * out.width;
          const sampleY = y + (rawCurrent ? 0 : pf[1]) * out.height;
          const raw = (px, py) => {
            const offset = (Math.max(0, Math.min(out.height - 1, py)) * out.width + Math.max(0, Math.min(out.width - 1, px))) * 4;
            return [...current.values.slice(offset, offset + 3)];
          };
          const x0 = Math.floor(sampleX), y0 = Math.floor(sampleY);
          const fx = sampleX - x0, fy = sampleY - y0;
          const taps = [raw(x0, y0), raw(x0 + 1, y0), raw(x0, y0 + 1), raw(x0 + 1, y0 + 1)];
          const filteredCurrent = [0, 1, 2].map(c => taps[0][c] * (1 - fx) * (1 - fy) + taps[1][c] * fx * (1 - fy) + taps[2][c] * (1 - fx) * fy + taps[3][c] * fx * fy);
          const centerX = Math.floor(sampleX + 0.5), centerY = Math.floor(sampleY + 0.5);
          const neighborhood = [-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dx => raw(centerX + dx, centerY + dy)));
          // Derive support from the shader actually executed, not today's
          // working tree. Historical floor-aligned and symmetric variants
          // must not be reported as the same neighborhood.
          let clippingFootprint;
          if ([16, 25].includes(footprintCount)) {
            const symmetric = footprintCount === 25;
            const offsets = symmetric ? [-2, -1, 0, 1, 2] : [-1, 0, 1, 2];
            const anchorX = symmetric ? centerX : x0, anchorY = symmetric ? centerY : y0;
            const settled = stability !== undefined && acceptedAge(stability.values[y * out.width + x]) >= 8;
            clippingFootprint = { side: offsets.length, anchor: [anchorX, anchorY], settled,
              samples: offsets.flatMap(dy => offsets.map(dx => {
                const px = anchorX + dx, py = anchorY + dy;
                const useCurrent = !settled && (Math.abs(px - centerX) > 1 || Math.abs(py - centerY) > 1 || (px === centerX && py === centerY));
                return { x: px, y: py, useCurrent, rgb: useCurrent ? filteredCurrent : raw(px, py) };
              })) };
          }
          const reflection = ssrTrace === undefined ? undefined : Object.fromEntries([
            ['trace', ssrTrace], ['resolved', ssrResolved], ['previousHistory', ssrHistory],
            ['previousSurfaceOrLegacyConfidence', previousConfidence], ['resolvedSurfaceOrLegacyConfidence', resolvedConfidence],
          ].filter(([, resource]) => resource !== undefined).map(([name, resource]) => {
            const offset = (Math.floor(centerY / 2) * resource.width + Math.floor(centerX / 2)) * resource.channels;
            return [name, [...resource.values.slice(offset, offset + resource.channels)]];
          }));
          const composition = compositionInputs === undefined ? undefined : [-1, 0, 1].flatMap(dy =>
            [-1, 0, 1].map(dx => ({ x: centerX + dx, y: centerY + dy,
              ...Object.fromEntries(Object.entries(compositionInputs).map(([name, resource]) => {
                const offset = (Math.max(0, Math.min(resource.height - 1, centerY + dy)) * resource.width
                  + Math.max(0, Math.min(resource.width - 1, centerX + dx))) * resource.channels;
                return [name, [...resource.values.slice(offset, offset + resource.channels)]];
              })),
            })));
          const witness = { x, y, delta, filteredCurrent, neighborhood, clippingFootprint, reflection, composition,
            ...(stability === undefined ? {} : { stability: stability.values[y * out.width + x], priorStability: priorStability.values[y * out.width + x] }),
            output: [...out.values.slice(i, i + 3)], history: [...previous.values.slice(i, i + 3)],
            temporal: [...temporal.values.slice(i, i + 4)], previousTemporal: [...previousTemporal.values.slice(i, i + 4)] };
          if (isRequested) requested = witness;
          worstPixels.push(witness);
          worstPixels.sort((a, b) => b.delta - a.delta);
          worstPixels.length = Math.min(10, worstPixels.length);
        }
        const gradient = Math.max(...[out.values, previous.values].flatMap(values =>
          [4, out.width * 4].flatMap(offset => [0, 1, 2].map(c => Math.abs(values[i + c] - values[i + offset + c])))));
        if (gradient < 0.15) continue;
        const t = temporal.values, p = previousTemporal.values;
        if (t[i + 2] < 0 || p[i + 2] < 0 || t[i + 3] >= 1 || Math.abs(t[i + 2] - p[i + 2]) > 0.0025 + t[i + 2] * 0.01) rejected++;
        changes.push(delta);
      }
    }
    changes.sort((a, b) => a - b);
    fixedRegionChanges.sort((a, b) => a - b);
    return { pixels: changes.length, rejected, mean: changes.reduce((a, b) => a + b, 0) / Math.max(1, changes.length),
      p95: changes[Math.floor(changes.length * 0.95)] ?? 0, p99: changes[Math.floor(changes.length * 0.99)] ?? 0,
      above003: changes.filter(v => v > 0.03).length,
      fixedRegion: { pixels: fixedRegionChanges.length, p99: fixedRegionChanges[Math.floor(fixedRegionChanges.length * 0.99)], maximum: fixedRegionChanges.at(-1) }, worstPixels, requested };
  };
  const result = { digest: createHash('sha256').update(bytes).digest('hex'), workIndex: w.workIndex,
    mode: ssrTemporalCandidate !== undefined ? 'counterfactual-ssr-replay' : traceCandidate !== undefined ? 'counterfactual-ssr-trace-replay' : probeOutput !== undefined ? 'instrumented-taa-replay' : candidateSource === undefined ? 'recorded-replay' : 'counterfactual-taa-replay',
    ...(traceCandidate === undefined ? {} : { traceShaderPath: resolve(traceShaderPath), traceShaderDigest: createHash('sha256').update(traceCandidate).digest('hex') }),
    ...(ssrTemporalCandidate === undefined ? {} : { ssrTemporalShaderPath: resolve(ssrTemporalShaderPath), ssrTemporalShaderDigest: createHash('sha256').update(ssrTemporalCandidate).digest('hex') }),
    ...(probeOutput === undefined ? {} : { probeOutput, outputMeaning: 'Intermediate GPU value; output/history deltas are not frame-flicker metrics' }),
    ...(candidateSource === undefined ? {} : { candidatePath, candidateArtifact, candidateTransform: [rawCurrent && 'current-raster', threeBlend && 'three-blend', centerBounds && 'center-bounds'].filter(Boolean), candidateShaderDigest }),
    shaderDigest: createHash('sha256').update(w.pipeline.shaders.map(s => s.source).join('\n')).digest('hex'),
    dimensions: { width: out.width, height: out.height },
    outputDigests: Object.fromEntries(Object.entries({ taaColor: out, taaTemporal: temporal,
      taaStability: stability, ssrTrace, ssrResolved }).filter(([, row]) => row !== undefined)
      .map(([name, row]) => [name, createHash('sha256').update(row.bytes).digest('hex')])),
    ...(stability === undefined ? {} : { stabilityHistory: {
      format: stability.format,
      encoding: clipStreakEncoding ? 'age-and-signed-clip-streak' : 'normalized-age-128',
      output: w.attachments.colorViewHandleIds[2], input: stabilityBinding.resourceId,
      settledPixels: stability.values.filter(value => acceptedAge(value) === 128).length,
      resetPixels: stability.values.filter(value => value === 0).length,
      pixels: stability.values.length,
    } }),
    ssr: model.works.some(w => w.pipeline.shaders.some(s => s.entryPoint === 'ssr_trace')),
    frameIndex: pu[3], historyValid: pu[2], jitter: [...pf.slice(0, 2)], secondaryReactivity, scenePose,
    wallEdges: edgeRegion(0.2, 0.5), contactEdges: edgeRegion(0.47, 0.56), reflectionEdges: edgeRegion(0.52, 0.78),
    staticWall: { pixels: deltas.length, invalid, reactive, moving, depthRejected,
      meanDelta: deltas.reduce((a, b) => a + b, 0) / deltas.length, p95Delta: deltas[Math.floor(deltas.length * 0.95)] } };
  if (requestedPixel) assert.ok(result.wallEdges.requested || result.contactEdges.requested || result.reflectionEdges.requested,
    'Requested pixel is outside the inspected wall/reflection regions');
  const reportName = ssrTemporalCandidate !== undefined ? 'taa-ssr-counterfactual-work.json' : traceCandidate !== undefined ? 'taa-trace-counterfactual-work.json' : probeOutput !== undefined ? `taa-probe-${probeOutput}.json` : candidateSource === undefined ? 'taa-selected-work.json' : 'taa-counterfactual-work.json';
  // Several chronological tapes may share a directory. Keep each inspection
  // bound to its input name instead of overwriting the preceding frame.
  const prefix = basename(path) === 'frame.rhitape' ? '' : `${basename(path, '.rhitape')}-`;
  writeFileSync(resolve(dirname(path), `${prefix}${reportName}`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { replay.dispose(); }
// Dawn's native event loop outlives its disposed replay in a standalone CLI.
process.exit(0);
