#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { decodeTape, buildFrameModel, openReplay, halfToFloat } from '@forgeax/engine-rhi-debug';
import { bootstrapDawn } from '../../../shared/scripts/rhi-debug-verify.mjs';
import { writeReferencePng } from '../../../shared/png-codec.mjs';
import { auditTileReflection, auditTileSeams, mirrorSegmentDistance } from './audit-tile-reflection.mjs';

// The analytic formula precedes RGBA16F attachment conversion. Its two
// representable neighbors are legal rounding results, not composition errors.
// Keep the raw absolute error separately; apply the existing arithmetic
// tolerance only to distance outside this format-derived interval.
export function reflectionFormulaError(expected, actual, alternateExpected = expected) {
  assert.ok(Number.isFinite(expected) && Number.isFinite(actual));
  assert.ok(Number.isFinite(alternateExpected));
  const error = value => {
    const spacing = 2 ** Math.max(-24, Math.floor(Math.log2(Math.abs(value))) - 10);
    const lower = Math.floor(value / spacing) * spacing;
    const upper = Math.ceil(value / spacing) * spacing;
    return Math.max(0, lower - actual, actual - upper);
  };
  return Math.min(error(expected), error(alternateExpected));
}

// WGSL permits inexact division and reassociation (§15.7.4-5). Retain the
// exact-coordinate reference and this f32 reciprocal evaluation separately.
// The latter is observed in a diagnostic GPU invocation of the recorded
// compose shader; it can cross an FP16 bin at high-contrast texel boundaries.
// https://www.w3.org/TR/WGSL/#floating-point-accuracy
export function reflectionTexelCoordinate(pixel, fullSize, mipSize, f32Reciprocal = false) {
  if (!f32Reciprocal) return (pixel + 1) / fullSize * mipSize - 0.5;
  const f = Math.fround;
  return f(f(f(pixel + 1) * f(1 / fullSize)) * f(mipSize)) - 0.5;
}

// The captured shader bindings identify the resources. Never pin transient
// handle IDs or count an admitted graph as evidence of reflected pixels.
export async function inspectSsrTape(tapePath) {
  const bytes = new Uint8Array(readFileSync(tapePath));
  const decoded = decodeTape(bytes);
  if (!decoded.ok) throw decoded.error;
  const tape = decoded.value;
  const model = buildFrameModel(tape);
  const materialTextureSpecialization = [];
  for (const entryPoint of ['fs_gbuffer', 'fs_main', 'fs_temporal']) {
    const draws = model.works.filter(w => w.pipeline.shaders.some(s => s.entryPoint === entryPoint)
      && w.pipeline.descriptor?.desc?.fragment?.constants?.['64000'] !== undefined);
    const masks = {};
    for (const draw of draws) {
      const mask = draw.pipeline.descriptor.desc.fragment.constants['64000'];
      masks[mask] = (masks[mask] ?? 0) + 1;
    }
    materialTextureSpecialization.push({ entryPoint, masks });
    if (process.env.SSR_EXPECT_TEXTURE_SPECIALIZATION === '1') {
      assert.ok(masks[0] > 0 && masks[17] > 0,
        `${entryPoint}: tiles require distinct no-map and base-color/emissive-map PSOs: ${JSON.stringify(masks)}`);
      for (const draw of draws) {
        const source = draw.pipeline.shaders.find(s => s.stage === 'fragment')?.source;
        assert.match(source ?? '', /textureSample\(\s*baseColorTexture(?:_\d+)?\s*,/,
          `work ${draw.workIndex}: shared shader lost the authored arrow texture sampling path`);
      }
    }
  }
  const work = (entry) => {
    const candidates = model.works.filter((w) =>
      w.pipeline.shaders.some((s) => s.entryPoint === entry));
    assert.equal(candidates.length, 1, `expected one ${entry} dispatch`);
    return candidates[0];
  };
  const trace = work('ssr_trace');
  const temporal = work('ssr_temporal');
  const compositionWorks = model.works.filter((w) => w.pipeline.shaders.some((s) => s.entryPoint === 'fs_ssr_compose'));
  assert.ok(compositionWorks.length > 0, 'no material composition draw');
  const compose = compositionWorks.at(-1);
  // The hardware roughness sampler consumes the resolved presentation
  // pyramid in premultiplied-radiance form. Older captures stored straight
  // RGB and premultiplied in this audit's manual footprint helper.
  const compositionSource = compose.pipeline.shaders.find((s) => s.entryPoint === 'fs_ssr_compose')?.source ?? '';
  const temporalSource = temporal.pipeline.shaders.find((s) => s.entryPoint === 'ssr_temporal')?.source ?? '';
  const resolvedStores = [...temporalSource.matchAll(/textureStore\(resolvedOutput[^\n]*/g)].map((match) => match[0]);
  const presentationPremultiplied = compositionSource.includes('radianceSampler')
    && resolvedStores.some((store) => store.includes('*'));
  // A hardware trilinear sample is evaluated in implementation-defined f32
  // order before the final RGBA16F attachment conversion. Keep the legacy
  // interval for manual footprints and use a bounded, explicit allowance for
  // this one filtered path rather than hiding the raw formula error.
  const formulaIntervalTolerance = presentationPremultiplied ? 0.01 : 0.005;
  const fullscreenComposition = compose.pipeline.shaders.some(s => s.entryPoint === 'vs_ssr_compose');
  if (fullscreenComposition) assert.equal(compositionWorks.length, 1, 'SSR must compose each pixel once');
  const radianceBinding = fullscreenComposition ? 0 : 20;
  const fallbackBinding = fullscreenComposition ? 1 : 21;
  const receiverAdmission = fullscreenComposition && compose.bindings.some(b => b.groupIndex === 0 && b.binding === 5);
  const binding = (w, slot) => {
    const b = w.bindings.find((b) => b.groupIndex === 0 && b.binding === slot);
    assert.ok(b?.resourceId, `missing binding ${slot} at work ${w.workIndex}`);
    return b.resourceId;
  };
  assert.equal(binding(trace, 4), binding(temporal, 0));
  if (receiverAdmission) assert.equal(binding(compose, 5), binding(trace, 5), 'composition must consume the trace shared View');
  const hasHitReactivity = trace.bindings.some(b => b.groupIndex === 0 && b.binding === 8);
  if (hasHitReactivity) {
    assert.equal(binding(trace, 7), binding(temporal, 4), 'trace and history must share Standard source metadata');
    assert.equal(binding(trace, 8), binding(temporal, 11), 'history must consume the trace-produced reactivity');
  }
  const textureForView = id => {
    const resource = model.resources.find(r => r.resourceId === id);
    assert.equal(resource?.kind, 'texture-view');
    return resource.descriptor.sourceHandleId;
  };
  for (const w of compositionWorks) {
    // Temporal writes mip zero; material sampling exposes the same physical
    // reflection texture's full pyramid through a different view.
    assert.equal(textureForView(binding(temporal, 7)), textureForView(binding(w, radianceBinding)));
    assert.equal(binding(trace, 2), w.attachments.colorViewHandleIds[0]);
    assert.equal(w.pipeline.descriptor.desc.fragment.targets[0].blend.color.dstFactor, 'one');
  }
  const backend = await bootstrapDawn('SSR selected-work audit', tape);
  const traceSteps = process.env.SSR_TRACE_STEPS === undefined ? undefined : Number(process.env.SSR_TRACE_STEPS);
  if (traceSteps !== undefined) assert.ok(Number.isInteger(traceSteps) && traceSteps >= 1 && traceSteps <= 2048);
  const traceSourcePath = process.env.SSR_TRACE_SOURCE;
  let traceSource;
  if (traceSourcePath !== undefined) {
    const { compileShader } = await import('../../../../packages/shader-compiler/dist/index.mjs');
    const result = await compileShader(readFileSync(resolve(traceSourcePath), 'utf8'), {
      id: 'forgeax_ssr::trace',
      imports: { 'forgeax_view::common': readFileSync(new URL('../../../../packages/shader/src/common.wgsl', import.meta.url), 'utf8') },
    });
    if (!result.ok) throw result.error;
    traceSource = result.value.wgsl;
  }
  let candidate;
  const opened = await openReplay(tape, {
    device: backend.freshDevice, createShaderModule: (device, descriptor) => {
      if ((traceSteps === undefined && traceSource === undefined) || !descriptor.code.includes('fn ssr_trace(')) return backend.rhiWebgpu.createShaderModule(device, descriptor);
      const constant = /(const SSR_TRACE_MAX_COARSE_STEPS[_\d]*\s*:\s*u32\s*=\s*)\d+u?\s*;/;
      const baseCode = traceSource ?? descriptor.code;
      assert.ok(constant.test(baseCode), 'The selected trace must expose its bounded coarse-step constant');
      const code = traceSteps === undefined ? baseCode
        : baseCode.replace(constant, (_, prefix) => `${prefix}${traceSteps}u;`);
      const digest = createHash('sha256').update(code).digest('hex');
      const path = resolve(dirname(tapePath), `ssr-trace-candidate-${digest}.wgsl`);
      writeFileSync(path, code);
      candidate = { traceSteps, sourcePath: traceSourcePath === undefined ? undefined : resolve(traceSourcePath), digest, path };
      return backend.rhiWebgpu.createShaderModule(device, { ...descriptor, code });
    },
  });
  if (!opened.ok) throw opened.error;
  const replay = opened.value;
  try {
    const readId = async (id, workIndex, subresource) => {
      const result = await replay.readResourceAtWork(id, workIndex, subresource);
      if (!result.ok) throw result.error;
      const r = result.value;
      assert.equal(r.provenance.selectedWorkIndex, workIndex);
      const data = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength);
      const values = r.format?.endsWith('16float')
        ? Array.from({ length: r.bytes.length / 2 }, (_, i) => halfToFloat(data.getUint16(i * 2, true)))
        : r.format === 'rgba8unorm' ? Array.from(r.bytes, (v) => v / 255)
        : Array.from({ length: r.bytes.length / 4 }, (_, i) => data.getFloat32(i * 4, true));
      assert.ok(values.every(Number.isFinite), `non-finite ${r.resourceId}`);
      return { ...r, values };
    };
    const read = (w, slot) => readId(binding(w, slot), w.workIndex);
    const traced = await read(trace, 4);
    let hitReactivity;
    if (hasHitReactivity) {
      const mask = await read(trace, 8);
      assert.equal(mask.format, 'r32float');
      assert.equal(mask.width, traced.width);
      assert.equal(mask.height, traced.height);
      assert.ok(mask.values.every(v => v >= 0 && v <= 1));
      // Rejected moving occluders deliberately retain reactivity on a miss.
      // Radiance admission is not the validity contract for this mask.
      hitReactivity = { resourceId: binding(trace, 8), sourceResourceId: binding(trace, 7),
        producerWorkIndex: trace.workIndex, consumerWorkIndex: temporal.workIndex,
        width: mask.width, height: mask.height, positive: mask.values.filter(v => v > 0).length,
        reactiveMisses: mask.values.filter((v, i) => v > 0 && traced.values[i * 4 + 3] <= 0).length,
        maximum: mask.values.reduce((a, b) => Math.max(a, b), 0) };
    }
    if (process.env.SSR_EXPORT_TRACE_INPUTS === '1') {
      const inputs = { artifactDigest: createHash('sha256').update(bytes).digest('hex'), workIndex: trace.workIndex };
      for (const [name, slot] of Object.entries({ depth: 0, normal: 1, color: 2, camera: 5, fallback: 6 })) {
        const data = await read(trace, slot);
        const path = resolve(dirname(tapePath), `ssr-input-${name}.bin`);
        writeFileSync(path, data.bytes);
        inputs[name] = { path, format: data.format, width: data.width, height: data.height,
          digest: createHash('sha256').update(data.bytes).digest('hex') };
      }
      writeFileSync(resolve(dirname(tapePath), 'ssr-trace-inputs.json'), JSON.stringify(inputs, null, 2));
    }
    const resolved = await read(temporal, 7);
    const reflectionTexture = textureForView(binding(compose, radianceBinding));
    const reflectionLevels = model.resources.find(r => r.resourceId === reflectionTexture).descriptor.desc.mipLevelCount ?? 1;
    const pyramid = [resolved];
    for (let level = 1; level < reflectionLevels; level++) {
      pyramid.push(await readId(reflectionTexture, compose.workIndex, { mipLevel: level, arrayLayer: 0 }));
    }
    const sampleReflection = (x, y, roughness, width, height, receiverBase, f32Reciprocal = false) => {
      const lod = roughness * roughness * (pyramid.length - 1);
      const bilinear = level => {
        if (level === 0 && receiverBase !== undefined) return receiverBase;
        const mip = pyramid[level];
        // The producer traces full-res pixel 2*p. Its half-res texel origin
        // differs by half a full-res pixel from a conventional downsample.
        const px = reflectionTexelCoordinate(x, width, mip.width, f32Reciprocal);
        const py = reflectionTexelCoordinate(y, height, mip.height, f32Reciprocal);
        const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
        const sum = [0, 0, 0, 0];
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const p = (Math.max(0, Math.min(mip.height - 1, iy + dy)) * mip.width + Math.max(0, Math.min(mip.width - 1, ix + dx))) * 4;
          const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy), a = mip.values[p + 3];
          for (let c = 0; c < 3; c++) sum[c] += mip.values[p + c] * (presentationPremultiplied ? 1 : a) * weight;
          sum[3] += a * weight;
        }
        return sum;
      };
      const low = Math.floor(lod), fraction = lod - low;
      const a = bilinear(low), b = bilinear(Math.min(low + 1, pyramid.length - 1));
      const sample = a.map((v, c) => v * (1 - fraction) + b[c] * fraction);
      return [...sample.slice(0, 3).map(v => v / Math.max(sample[3], 1e-6)), sample[3]];
    };
    const sceneId = binding(trace, 2);
    const base = await readId(sceneId, temporal.workIndex);
    const fallback = await readId(binding(compose, fallbackBinding), temporal.workIndex);
    const composed = await readId(sceneId, compose.workIndex);
    if (process.env.SSR_PIXEL !== undefined) {
      const [x, y] = process.env.SSR_PIXEL.split(',').map(Number);
      assert.ok(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < base.width && y < base.height);
      const timeline = [];
      let previous = base.values.slice((y * base.width + x) * 4, (y * base.width + x) * 4 + 4);
      for (const w of compositionWorks) {
        const result = await replay.readResourceAtWork(sceneId, w.workIndex);
        if (!result.ok) throw result.error;
        const bytes = result.value.bytes;
        const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const pixel = [0, 1, 2, 3].map((c) => halfToFloat(data.getUint16(((y * base.width + x) * 4 + c) * 2, true)));
        if (pixel.some((v, i) => v !== previous[i])) timeline.push({ workIndex: w.workIndex, before: previous, after: pixel });
        previous = pixel;
      }
      console.log(JSON.stringify({ pixel: [x, y], compositionTimeline: timeline }));
    }
    const history = await read(temporal, 5);
    const temporalParams = await read(temporal, 6);
    const taaWorks = model.works.filter((w) => w.pipeline.shaders.some((s) =>
      s.source.includes('fn fs_taa_resolve(')));
    const sceneTemporal = await read(temporal, 4);
    const previousSsr = await read(temporal, 3);
    const normal = await read(trace, 1);
    const taaInputs = [];
    for (const w of taaWorks) {
      const id = (slot) => w.bindings.find((b) => b.groupIndex === 1 && b.binding === slot)?.resourceId;
      const p = await readId(id(8), w.workIndex);
      const integers = new Uint32Array(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength / 4);
      const output = await readId(w.attachments.colorViewHandleIds[0], w.workIndex);
      const previous = await readId(id(2), w.workIndex);
      const deltas = [];
      for (let pixel = 0; pixel < output.values.length; pixel += 4) {
        if (normal.values[pixel + 1] < 0.999 || normal.values[pixel + 3] > 0.1) continue;
        deltas.push(Math.max(...[0, 1, 2].map((c) => Math.abs(output.values[pixel + c] - previous.values[pixel + c]))));
      }
      deltas.sort((a, b) => a - b);
      taaInputs.push({ workIndex: w.workIndex, currentJitterUv: p.values.slice(0, 2),
        historyValid: integers[2], frameIndex: integers[3], staticSmoothFloor: {
          pixels: deltas.length, meanFrameDelta: deltas.reduce((sum, v) => sum + v, 0) / Math.max(1, deltas.length),
          p95FrameDelta: deltas[Math.floor(deltas.length * 0.95)] ?? 0,
        } });
    }
    let reflected = 0, accumulated = 0, reactiveReceivers = 0, invalidTemporalReceivers = 0;
    for (let y = 0; y < traced.height; y++) for (let x = 0; x < traced.width; x++) {
      const p = (y * traced.width + x) * 4;
      if (traced.values[p + 3] <= 0) continue;
      reflected++;
      if ([0, 1, 2].some((c) => Math.abs(traced.values[p + c] - resolved.values[p + c]) > 0.001)) accumulated++;
      const full = (y * 2 * sceneTemporal.width + x * 2) * 4;
      if (sceneTemporal.values[full + 3] >= 1) reactiveReceivers++;
      if (sceneTemporal.values[full + 2] < 0) invalidTemporalReceivers++;
    }
    const depth = await read(trace, 0);
    const materialWork = model.works.find((w) => w.pipeline.shaders.some((s) => s.entryPoint === 'fs_gbuffer'));
    const material = await readId(materialWork.attachments.colorViewHandleIds[1], trace.workIndex);
    const materialResponse = fullscreenComposition ? await readId(binding(compose, 2), compose.workIndex) : undefined;
    const camera = await read(trace, 5);
    if (process.env.SSR_EXPORT_COMPOSE_INPUTS === '1') {
      const exported = { artifactDigest: createHash('sha256').update(bytes).digest('hex'),
        workIndex: compose.workIndex, shader: compose.pipeline.shaders.find(s => s.entryPoint === 'fs_ssr_compose').source,
        textures: [] };
      for (const [name, levels] of [['radiance', pyramid], ['fallback', [fallback]],
        ['response', [materialResponse]], ['normal', [normal]]]) {
        const entries = [];
        for (const [level, data] of levels.entries()) {
          const path = resolve(dirname(tapePath), `compose-${name}-${level}.bin`);
          writeFileSync(path, data.bytes);
          entries.push({ path, width: data.width, height: data.height, format: data.format,
            bytesPerRow: data.bytesPerRow, digest: createHash('sha256').update(data.bytes).digest('hex') });
        }
        exported.textures.push({ name, levels: entries });
      }
      const path = resolve(dirname(tapePath), 'compose-view.bin');
      writeFileSync(path, camera.bytes);
      exported.view = { path, digest: createHash('sha256').update(camera.bytes).digest('hex') };
      writeFileSync(resolve(dirname(tapePath), 'compose-inputs.json'), JSON.stringify(exported, null, 2));
    }
    for (const [name, resource] of [['trace', traced], ['resolved', resolved], ['base', base], ['composed', composed]]) {
      const rgba = new Uint8Array(resource.width * resource.height * 4);
      const confidence = new Uint8Array(rgba.length);
      for (let p = 0; p < rgba.length; p += 4) {
        for (let c = 0; c < 3; c++) rgba[p + c] = Math.round(Math.pow(Math.max(0, Math.min(1, resource.values[p + c])), 1 / 2.2) * 255);
        rgba[p + 3] = 255;
        confidence.set([0, 1, 2].map(() => Math.round(resource.values[p + 3] * 255)).concat(255), p);
      }
      const imagePrefix = candidate === undefined ? '' : `trace-${traceSteps ?? candidate.digest}-`;
      writeFileSync(resolve(dirname(tapePath), `${imagePrefix}${name}.png`), writeReferencePng(rgba, resource.width, resource.height));
      if (name === 'trace') writeFileSync(resolve(dirname(tapePath), `${imagePrefix}confidence.png`), writeReferencePng(confidence, resource.width, resource.height));
    }
    const tileOracle = process.env.SSR_FIXTURE === 'tiles'
      ? auditTileReflection({ traced, base, depth, normal, camera }) : undefined;
    const seamOracle = process.env.SSR_FIXTURE === 'tiles'
      ? auditTileSeams({ traced, base, depth, normal, camera }) : undefined;
    // Keep nearest-source evidence intact. Linear agreement measures filtered
    // hit color, not subpixel geometric coverage at the source silhouette.
    const linearSeamOracle = process.env.SSR_FIXTURE === 'tiles'
      ? auditTileSeams({ traced, base, depth, normal, camera, colorFilter: 'linear' }) : undefined;
    // View UBO [236..239] is the captured SSR authoring tail. Do not hide
    // rough pavers when inspecting prefilter-independent hit geometry.
    const admittedSeamOracle = process.env.SSR_FIXTURE === 'tiles'
      ? auditTileSeams({ traced, base, depth, normal, camera, colorFilter: 'linear', maxRoughness: camera.values[238] }) : undefined;
    const sourceFilteredSeamOracle = process.env.SSR_FIXTURE === 'tiles'
      ? auditTileSeams({ traced, base, depth, normal, camera, fallback, colorFilter: 'linear-admitted', maxRoughness: camera.values[238] }) : undefined;
    const inv = camera.values.slice(44, 60);
    const normalize = (v) => { const length = Math.hypot(...v); return v.map((c) => c / length); };
    const luts = new Map();
    for (const w of fullscreenComposition
      ? model.works.filter(w => w.pipeline.shaders.some(s => s.entryPoint === 'fs_gbuffer'))
      : compositionWorks) {
      const source = w.pipeline.shaders.find((s) => s.stage === 'fragment').source;
      const match = source.match(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var brdfLut(?:_\d+)?\s*:/);
      assert.ok(match, 'no captured BRDF LUT binding');
      const id = w.bindings.find((b) => b.groupIndex === Number(match[1]) && b.binding === Number(match[2])).resourceId;
      if (!luts.has(id)) luts.set(id, await readId(id, w.workIndex));
    }
    assert.equal(luts.size, 1, 'this fixture oracle requires one shared BRDF LUT');
    const lut = luts.values().next().value;
    assert.equal(lut.format, 'rg16float');
    const sampleLut = (u, v) => {
      const x = Math.max(0, Math.min(lut.width - 1, u * lut.width - 0.5));
      const y = Math.max(0, Math.min(lut.height - 1, v * lut.height - 0.5));
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const at = (a, b, c) => lut.values[(b * lut.width + a) * 2 + c];
      return [0, 1].map((c) => (at(x0, y0, c) * (1 - fx) + at(Math.min(x0 + 1, lut.width - 1), y0, c) * fx) * (1 - fy)
        + (at(x0, Math.min(y0 + 1, lut.height - 1), c) * (1 - fx) + at(Math.min(x0 + 1, lut.width - 1), Math.min(y0 + 1, lut.height - 1), c) * fx) * fy);
    };
    const finalWork = model.works.at(-1);
    assert.ok(finalWork.workIndex > compose.workIndex);
    const consumers = model.works.filter((w) => w.workIndex > compose.workIndex &&
      w.bindings.some((b) => b.resourceId === composed.resourceId));
    assert.ok(consumers.length > 0, 'SSR composed texture never reaches a later draw');
    const finalSource = await replay.readResourceAtWork(composed.resourceId, finalWork.workIndex);
    if (!finalSource.ok) throw finalSource.error;
    assert.deepEqual(finalSource.value.bytes, composed.bytes, 'a later pass overwrote the SSR contribution');
    const confidence = (r) => {
      const a = r.values.filter((_, i) => i % 4 === 3);
      return { pixels: a.length, positive: a.filter((v) => v > 0).length,
        maximum: a.reduce((maximum, value) => Math.max(maximum, value), 0) };
    };
    let changedPixels = 0;
    let maxDelta = 0;
    let maxFormulaError = 0;
    let maxFormulaIntervalError = 0;
    let formulaIntervalWitness;
    let formulaWitness;
    let witness;
    const receiverCoverage = { incompatiblePixels: 0, contaminatedPixels: 0, compatibleNeighborPixels: 0, maximumDelta: 0, witnesses: [] };
    // A counterfactual arithmetic witness, not a proposed composition rule:
    // removing the base-alpha cap also needs independent receiver admission.
    const upperEdgeMipClipping = { baseAlphaCapApplied: !receiverAdmission, bandReceiverPixels: 16, roughnessGroups: {}, witness: null, maximumRemovedHdr: 0 };
    const receiverAwareComposition = compose.pipeline.shaders.some(shader => shader.source.includes('fn ssrReceiverWeight('));
    const receiverReconstruction = compose.pipeline.shaders.some(shader => shader.source.includes('fn ssrReceiverSample('));
    const normalWeight = agreement => {
      const fraction = Math.max(0, Math.min(1, (agreement - 0.9) / 0.09));
      return fraction * fraction * (3 - 2 * fraction);
    };
    const reconstructReceiver = (x, y, n, f32Reciprocal = false) => {
      const px = reflectionTexelCoordinate(x, base.width, resolved.width, f32Reciprocal);
      const py = reflectionTexelCoordinate(y, base.height, resolved.height, f32Reciprocal);
      const fx = px - Math.floor(px), fy = py - Math.floor(py);
      let totalWeight = 0;
      const value = [0, 0, 0, 0];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = Math.max(0, Math.min(resolved.width - 1, Math.floor(px) + dx));
        const sy = Math.max(0, Math.min(resolved.height - 1, Math.floor(py) + dy));
        const p = (sy * 2 * base.width + sx * 2) * 4;
        const candidateNormal = normalize(normal.values.slice(p, p + 3).map(value => value * 2 - 1));
        const agreement = n.reduce((sum, value, axis) => sum + value * candidateNormal[axis], 0);
        const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * normalWeight(agreement);
        const index = (sy * resolved.width + sx) * 4, alpha = resolved.values[index + 3];
        for (let c = 0; c < 3; c++) value[c] += weight * (presentationPremultiplied ? 1 : alpha) * resolved.values[index + c];
        value[3] += weight * alpha;
        totalWeight += weight;
      }
      return { value: value.map(v => v / Math.max(totalWeight, 1e-6)), totalWeight };
    };
    for (let y = 0; y < base.height; y++) {
      for (let x = 0; x < base.width; x++) {
        const p = (y * base.width + x) * 4;
        const t = (Math.min(Math.floor(y / 2), resolved.height - 1) * resolved.width
          + Math.min(Math.floor(x / 2), resolved.width - 1)) * 4;
        let delta = 0;
        const clip = [(x + 0.5) / base.width * 2 - 1, 1 - (y + 0.5) / base.height * 2, depth.values[y * base.width + x], 1];
        const world = [0, 1, 2, 3].map((r) => clip.reduce((sum, value, i) => sum + inv[i * 4 + r] * value, 0));
        const v = normalize([0, 1, 2].map((i) => camera.values[24 + i] - world[i] / world[3]));
        const n = normalize(normal.values.slice(p, p + 3).map((c) => c * 2 - 1));
        const sourcePixel = (Math.min(Math.floor(y / 2), resolved.height - 1) * 2 * base.width
          + Math.min(Math.floor(x / 2), resolved.width - 1) * 2) * 4;
        const sourceNormal = normalize(normal.values.slice(sourcePixel, sourcePixel + 3).map(value => value * 2 - 1));
        const agreement = n.reduce((sum, value, axis) => sum + value * sourceNormal[axis], 0);
        const receiverBase = receiverReconstruction ? reconstructReceiver(x, y, n) : undefined;
        const receiverWeight = receiverAwareComposition && !receiverReconstruction ? normalWeight(agreement) : 1;
        const baseConfidence = receiverBase?.value[3] ?? resolved.values[t + 3];
        const nv = Math.max(0.001, n.reduce((sum, c, i) => sum + c * v[i], 0));
        const roughness = normal.values[p + 3];
        const reflection = sampleReflection(x, y, roughness, base.width, base.height, receiverBase?.value,
          presentationPremultiplied);
        const outline = admittedSeamOracle?.outsideSilhouette.upperEdge;
        if (outline !== undefined && materialResponse !== undefined && n[1] > 0.999 && Math.abs(world[1] / world[3] + 1.025) < 0.002
          && roughness < camera.values[238] && receiverBase?.totalWeight > 0) {
          const distance = Math.min(...outline.segments.map(segment => mirrorSegmentDistance([x + 0.5, y + 0.5], segment)));
          if (distance <= upperEdgeMipClipping.bandReceiverPixels) {
            const key = roughness.toFixed(3);
            const group = upperEdgeMipClipping.roughnessGroups[key] ??= { pixels: 0, capped: 0, zeroBaseWithFilteredHit: 0, maximumRemovedHdr: 0 };
            group.pixels++;
            const removedConfidence = Math.max(0, reflection[3] - baseConfidence) * fallback.values[p + 3];
            if (removedConfidence > 0.001) {
              group.capped++;
              if (baseConfidence <= 0.001) group.zeroBaseWithFilteredHit++;
              const removedHdr = Math.max(...[0, 1, 2].map(c => Math.abs(removedConfidence
                * (reflection[c] * materialResponse.values[p + c] - fallback.values[p + c]))));
              group.maximumRemovedHdr = Math.max(group.maximumRemovedHdr, removedHdr);
              if (removedHdr > upperEdgeMipClipping.maximumRemovedHdr) {
                upperEdgeMipClipping.maximumRemovedHdr = removedHdr;
                upperEdgeMipClipping.witness = { pixel: [x, y], roughness, distance,
                  baseConfidence, filtered: reflection, response: materialResponse.values.slice(p, p + 3),
                  fallback: fallback.values.slice(p, p + 4), removedConfidence, removedHdr };
              }
            }
          }
        }
        const [a, b] = sampleLut(nv, roughness);
        const limit = Math.max(0, Math.min(1, camera.values[238]));
        const fade = Math.max(0, Math.min(1, (roughness - limit * 0.8) / Math.max(limit * 0.2, 1e-8)));
        const currentReceiverConfidence = receiverBase?.totalWeight > 1e-6 && Number.isFinite(camera.values[239])
          && camera.values[239] > 0.5 && roughness >= 0 && roughness < limit
          ? 1 - fade * fade * (3 - 2 * fade) : 0;
        const effectiveConfidence = Math.min(reflection[3], receiverAdmission ? currentReceiverConfidence : baseConfidence);
        for (let c = 0; c < 3; c++) {
          delta = Math.max(delta, Math.abs(composed.values[p + c] - base.values[p + c]));
          // The carrier uses ordinary Standard dielectric/metallic surfaces:
          // derive their F0 from captured albedo/metallic, not an authored copy.
          const metallic = material.values[p + 3];
          const f0 = 0.04 * (1 - metallic) + material.values[p + c] * metallic;
          const fresnel = f0 + (Math.max(1 - roughness, f0) - f0) * (1 - nv) ** 5;
          // Material composition rasterizes real covered geometry. A half-res
          // trace sample adjacent to a silhouette must not imply a sky draw.
          const coverage = depth.values[y * base.width + x] < 1 ? fallback.values[p + 3] : 0;
          // The fullscreen stage consumes the stored response, not a second
          // BRDF evaluated from quantized G-buffer normals. Inspect its actual
          // input to isolate composition from the material producer.
          const response = materialResponse?.values[p + c] ?? (fresnel * a + b);
          const expected = base.values[p + c] + effectiveConfidence * coverage * receiverWeight
            * (reflection[c] * response - fallback.values[p + c]);
          if ((baseConfidence > 0 || delta > 0.005) && Number.isFinite(expected)) {
            const error = Math.abs(composed.values[p + c] - expected);
            const exactCoordinateError = reflectionFormulaError(expected, composed.values[p + c]);
            let alternateExpected = expected;
            if (exactCoordinateError > 0) {
              const alternativeBase = receiverReconstruction ? reconstructReceiver(x, y, n, true) : undefined;
              const alternative = sampleReflection(x, y, roughness, base.width, base.height, alternativeBase?.value, true);
              const alternativeConfidence = Math.min(alternative[3], receiverAdmission
                ? currentReceiverConfidence : (alternativeBase?.value[3] ?? baseConfidence));
              alternateExpected = base.values[p + c] + alternativeConfidence * coverage * receiverWeight
                * (alternative[c] * response - fallback.values[p + c]);
            }
            const intervalError = reflectionFormulaError(expected, composed.values[p + c], alternateExpected);
            if (intervalError > maxFormulaIntervalError) {
              maxFormulaIntervalError = intervalError;
              formulaIntervalWitness = { x, y, channel: c, expected, actual: composed.values[p + c],
                base: base.values[p + c], response, reflection, effectiveConfidence, coverage,
                receiverWeight, roughness, fallback: fallback.values[p + c], intervalError, alternateExpected };
            }
            if (error > maxFormulaError) {
              maxFormulaError = error;
              formulaWitness = { x, y, channel: c, expected, actual: composed.values[p + c],
                depth: depth.values[y * base.width + x], normal: normal.values.slice(p, p + 4),
                material: material.values.slice(p, p + 4), response, reconstructedResponse: fresnel * a + b, coverage, nv, a, b,
                radiance: reflection, baseRadiance: resolved.values.slice(t, t + 4), fallback: fallback.values.slice(p, p + 4) };
            }
          }
        }
        if (delta > 1e-4) changedPixels++;
        const incompatible = receiverBase === undefined ? agreement < 0.9 : receiverBase.totalWeight === 0;
        if (receiverBase !== undefined && agreement < 0.9 && baseConfidence > 0.01 && delta > 0.005) receiverCoverage.compatibleNeighborPixels++;
        if (fallback.values[p + 3] > 0.5 && incompatible && resolved.values[t + 3] > 0.01) {
          receiverCoverage.incompatiblePixels++;
          if (delta > 0.005) {
            receiverCoverage.contaminatedPixels++;
            receiverCoverage.maximumDelta = Math.max(receiverCoverage.maximumDelta, delta);
            if (receiverCoverage.witnesses.length < 8) receiverCoverage.witnesses.push({ pixel: [x,y], agreement, delta, normal: n, sourceNormal });
          }
        }
        if (delta > maxDelta) {
          maxDelta = delta;
          witness = { x, y, base: base.values.slice(p, p + 4), fallback: fallback.values.slice(p, p + 4),
            resolved: resolved.values.slice(t, t + 4), composed: composed.values.slice(p, p + 4) };
        }
      }
    }
    const report = {
      hitReactivity,
      mode: candidate === undefined ? 'recorded-replay' : 'counterfactual-trace-replay',
      oracleSourceDigest: createHash('sha256').update(readFileSync(new URL('./audit-tile-reflection.mjs', import.meta.url))).digest('hex'),
      ...(candidate === undefined ? {} : { candidate }),
      artifact: { kind: 'rhi-tape', path: resolve(tapePath), digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` },
      formatVersion: tape.header.formatVersion,
      traceShaderSha256: createHash('sha256').update(trace.pipeline.shaders.find(s => s.entryPoint === 'ssr_trace').source).digest('hex'),
      composeShaderSha256: createHash('sha256').update(compose.pipeline.shaders.find(s => s.entryPoint === 'fs_ssr_compose').source).digest('hex'),
      materialTextureSpecialization,
      works: [trace, temporal, ...compositionWorks].map((w) => ({ workIndex: w.workIndex, eventIndex: w.eventIndex,
        entryPoints: w.pipeline.shaders.map((s) => s.entryPoint), bindings: w.bindings })),
      trace: confidence(traced), resolved: confidence(resolved),
      temporalCoordinates: { currentJitterUv: temporalParams.values.slice(4, 6),
        previousJitterUv: temporalParams.values.slice(6, 8),
        taaWorkIndices: taaWorks.map((w) => w.workIndex) },
      temporalAccumulation: { reflected, accumulated, reactiveReceivers, invalidTemporalReceivers,
        ssrHistoryValid: new Uint32Array(temporalParams.bytes.buffer, temporalParams.bytes.byteOffset, 1)[0],
        previousHistoryNonzero: previousSsr.values.filter((v, i) => i % 4 === 3 && v > 0).length, taaInputs },
      tileOracle, seamOracle, linearSeamOracle, admittedSeamOracle, sourceFilteredSeamOracle,
      outputConsumers: consumers.map((w) => ({ workIndex: w.workIndex, eventIndex: w.eventIndex,
        shaders: w.pipeline.shaders.map((s) => s.entryPoint), attachments: w.attachments })),
      historyDepthMaximum: confidence(history).maximum,
      composition: { changedPixels, maxDelta, maxFormulaError, maxFormulaIntervalError, formulaIntervalTolerance, formulaIntervalWitness, formulaWitness, receiverCoverage, upperEdgeMipClipping, oracle: presentationPremultiplied
        ? 'ordinary Standard: captured G-buffer, View and material BRDF LUT with RGBA16F conversion plus bounded hardware-filter f32 interval'
        : 'ordinary Standard: captured G-buffer, View and material BRDF LUT with RGBA16F conversion interval', witness },
    };
    writeFileSync(resolve(dirname(tapePath), candidate === undefined ? 'ssr-selected-work.json'
      : `ssr-trace-${traceSteps ?? candidate.digest}-work.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ artifact: report.artifact, mode: report.mode, candidate: report.candidate,
      traceShaderSha256: report.traceShaderSha256, trace: report.trace,
      resolved: report.resolved, tileOracle, seamOracle, linearSeamOracle, admittedSeamOracle, sourceFilteredSeamOracle, composition: report.composition, outputConsumers: report.outputConsumers }, null, 2));
    assert.ok(report.trace.positive > 0, 'SSR trace has no reflected hit pixels');
    if (process.env.SSR_EXPECT_FIRST_FRAME === '1') {
      assert.equal(report.temporalAccumulation.ssrHistoryValid, 0, 'First-frame SSR must not reuse history');
      assert.equal(report.temporalAccumulation.previousHistoryNonzero, 0, 'First-frame SSR history must be empty');
      for (const input of taaInputs) {
        assert.equal(input.historyValid, 0, 'First-frame TAA must not reuse history');
        assert.equal(input.frameIndex, 0, 'First-frame TAA must start at sample zero');
      }
    }
    if (taaWorks.length > 0) assert.ok(invalidTemporalReceivers / Math.max(1, reflected) < 0.02,
      'TAA jitter invalidates motion coverage on visible SSR receivers');
    assert.ok(report.resolved.positive > 0, 'SSR temporal resolve lost every hit');
    assert.ok(changedPixels > 0 && maxDelta > 1e-3, 'SSR contributes no measurable scene delta');
    assert.ok(maxFormulaIntervalError < formulaIntervalTolerance,
      `SSR composition violates the reflection delta formula outside its admitted interval (${maxFormulaIntervalError} >= ${formulaIntervalTolerance})`);
    if (process.env.SSR_EXPECT_RECEIVER_COVERAGE === '1') {
      assert.equal(receiverCoverage.contaminatedPixels, 0,
        `Half-resolution SSR leaks across differently-facing receivers: ${JSON.stringify(receiverCoverage)}`);
    }
    assert.ok(report.historyDepthMaximum > 1, 'history does not contain positive view distance');
    if (seamOracle !== undefined) {
      assert.ok(seamOracle.receiverNormalMaxDeviation < 1e-5,
        `Unmapped flat floor has a perturbed G-buffer normal: ${seamOracle.receiverNormalMaxDeviation}`);
      const edge = seamOracle.groups['upper-edge'];
      assert.ok(edge.eligible >= 100, 'Wall-outline acceptance requires enough camera-visible mirror rays');
      assert.ok(edge.missed / edge.eligible < 0.02,
        `SSR loses the finite wall-top outline: ${edge.missed}/${edge.eligible} visible rays missed`);
    }
    return report;
  } finally {
    await replay.dispose();
    backend.freshDevice.destroy?.();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  assert.ok(process.argv[2], 'usage: inspect-ssr-tape.mjs <frame.rhitape>');
  await inspectSsrTape(resolve(process.argv[2]));
  process.exit(0);
}
