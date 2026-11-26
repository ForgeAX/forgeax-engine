import { prepareShaderProgramCompiler } from '@forgeax/engine/shader-compiler/program';
import { halfFloat } from '@forgeax/engine/math';
import { BLOOM_PREFILTER_WGSL, POST_SCENE_COLOR_HALF_WGSL, ShaderRegistry } from '@forgeax/engine/shader';
import { DataTexture, HalfFloatType, LinearFilter, LinearSRGBColorSpace, NodeMaterial, NoToneMapping, QuadMesh, REVISION, RGBAFormat, RenderTarget, UnsignedByteType, WebGPURenderer } from 'three-render-defaults/webgpu';
import { texture } from 'three-render-defaults/tsl';
import { fxaa } from 'three-render-defaults/addons/tsl/display/FXAANode.js';
import { bloom } from 'three-render-defaults/addons/tsl/display/BloomNode.js';

const width = 256, height = 128;
function pixels(kind) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const value = kind === 'constant' ? 64 : kind === 'bloom'
      ? (Math.hypot(x - 64, y - 64) < 3 || (x > 170 && x < 174 && y > 20 && y < 108) ? 255 : 0)
      : x < 128 ? (y > x * 0.73 + 8 ? 230 : 30)
      : y < 64 ? (y > (x - 128) * 0.31 ? 25 : 14)
      : ((x + 2 * y) % 17 < 2 ? 152 : 126);
    const color = kind === 'fxaa' && x < 128
      ? [value, Math.round(value * 0.62), Math.round(value * 0.33), 255]
      : [value, value, value, 255];
    data.set(color, i);
  }
  return data;
}
function present(id, label, data, gain = 1) {
  const figure = document.createElement('figure'), canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const rgba = Uint8ClampedArray.from(data, (v, i) => i % 4 === 3 ? 255 : 255 * Math.min(1, v * gain));
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  const caption = document.createElement('figcaption'); caption.textContent = label;
  figure.append(canvas, caption); document.getElementById(id).append(figure);
}
function difference(a, b) {
  let max = 0, total = 0, aboveByte = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) {
    const delta = Math.abs(a[i] - b[i]); max = Math.max(max, delta); total += delta;
    if (delta > 1.01 / 255) aboveByte++;
  }
  return { max, mean: total / (a.length * 0.75), aboveOneByte: aboveByte };
}
// Three r187 pairs adjacent Gaussian taps for bilinear sampling and keeps their unnormalized weights.
function threeBloomUniformGain() {
  let throughput = 1, gain = 0;
  for (const [level, radius] of [6, 10, 14, 18, 22].entries()) {
    const sigma = radius / 3;
    const weights = Array.from({ length: radius }, (_, i) => 0.39894 * Math.exp(-0.5 * i * i / (sigma * sigma)) / sigma);
    throughput *= (2 * weights.reduce((a, b) => a + b, 0) - weights[0]) ** 2;
    gain += (1 - level * 0.2) * throughput;
  }
  return gain;
}
const mean = (data) => data.filter((_, i) => i % 4 === 0).reduce((a, b) => a + b, 0) / (data.length / 4);

async function threeCapture(data, effect, parameters = { threshold: 0, radius: 0, smoothWidth: 0.01 }) {
  const canvas = document.createElement('canvas');
  const renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL: false });
  await renderer.init(); renderer.setSize(width, height, false);
  renderer.toneMapping = NoToneMapping; renderer.outputColorSpace = LinearSRGBColorSpace;
  const input = new DataTexture(data, width, height, RGBAFormat, data instanceof Uint16Array ? HalfFloatType : UnsignedByteType);
  input.minFilter = LinearFilter; input.magFilter = LinearFilter;
  input.colorSpace = LinearSRGBColorSpace; input.needsUpdate = true;
  const node = effect === 'fxaa' ? fxaa(texture(input)) : bloom(texture(input), 1, parameters.radius, parameters.threshold);
  if (effect === 'bloom') node.smoothWidth.value = parameters.smoothWidth;
  const material = new NodeMaterial(); material.fragmentNode = node; material.toneMapped = false;
  const quad = new QuadMesh(material);
  const target = new RenderTarget(width, height, { type: HalfFloatType, depthBuffer: false });
  target.texture.colorSpace = LinearSRGBColorSpace;
  try {
    renderer.setRenderTarget(target); await quad.renderAsync(renderer);
    const values = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
    return Array.from(values, halfFloat.f16ToF32);
  } finally {
    node.dispose?.(); target.dispose(); input.dispose(); material.dispose(); renderer.dispose();
  }
}

async function forgeCapture(manifest, data, effect, parameters = { threshold: 0, radius: 0, smoothWidth: 0.01 }) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  const owned = [], errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const makeTexture = (w, h, format = 'rgba16float') => {
    const t = device.createTexture({ size: [w, h], format, usage: 1 | 2 | 4 | 16 }); owned.push(t); return t;
  };
  const input = makeTexture(width, height, data instanceof Uint16Array ? 'rgba16float' : 'rgba8unorm');
  device.queue.writeTexture({ texture: input }, data, { bytesPerRow: width * 4 * data.BYTES_PER_ELEMENT }, [width, height]);
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const encoder = device.createCommandEncoder();
  const pass = async (marker, textures, values, output, inlineSource) => {
    const code = inlineSource ?? manifest.entries.find((entry) => entry.role === marker)?.wgsl;
    if (!code) throw new Error(`Production shader is missing: ${marker}`);
    const module = device.createShaderModule({ code });
    const pipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module, entryPoint: 'vs_main' }, fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] } });
    const buffer = values ? device.createBuffer({ size: values.length * 4, usage: 0x40 | 8 }) : undefined;
    if (buffer) { owned.push(buffer); device.queue.writeBuffer(buffer, 0, new Float32Array(values)); }
    const groupIndex = inlineSource ? 1 : 0;
    const entries = textures.map((texture, binding) => ({ binding, resource: texture.createView() }));
    if (!inlineSource) entries.push({ binding: entries.length, resource: sampler });
    if (buffer) entries.push({ binding: inlineSource ? 2 : entries.length, resource: { buffer } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(groupIndex), entries });
    const render = encoder.beginRenderPass({ colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store' }] });
    render.setPipeline(pipeline); render.setBindGroup(groupIndex, group); render.draw(3); render.end();
  };
  try {
    let result;
    if (effect === 'fxaa') {
      result = makeTexture(width, height);
      await pass('fxaa', [input], [0, 0, 0, 0], result);
    } else {
      const levels = [];
      let w = width, h = height, previous = input;
      for (let level = 0; level < 5; level++) {
        w = Math.ceil(w / 2); h = Math.ceil(h / 2);
        let seed = makeTexture(w, h);
        await pass('post-scene-color-half', [previous], undefined, seed, POST_SCENE_COLOR_HALF_WGSL);
        if (level === 0 && parameters.threshold >= 0) {
          const filtered = makeTexture(w, h);
          await pass('bloom-prefilter', [seed], [parameters.threshold, parameters.smoothWidth, 0, 0], filtered, BLOOM_PREFILTER_WGSL);
          seed = filtered;
        }
        levels.push({ w, h, seed });
        previous = seed;
      }
      let accumulated;
      for (let level = 4; level >= 0; level--) {
        const { w, h, seed } = levels[level];
        const horizontal = makeTexture(w, h);
        await pass('bloomHorizontal', [seed], [level, 0, 0, 0], horizontal);
        const next = makeTexture(w, h);
        const factor = 1 - level * 0.2;
        const weight = (factor * (1 - parameters.radius) + (1.2 - factor) * parameters.radius) / 3;
        await pass('bloomVertical', [horizontal, accumulated ?? horizontal], [level, weight, Number(accumulated !== undefined), 0], next);
        accumulated = next;
      }
      const zero = makeTexture(width, height); result = makeTexture(width, height);
      await pass('bloomComposite', [zero, accumulated], [1, 0, 0, 0], result);
    }
    const readback = device.createBuffer({ size: width * height * 8, usage: 1 | 8 }); owned.push(readback);
    encoder.copyTextureToBuffer({ texture: result }, { buffer: readback, bytesPerRow: width * 8 }, [width, height]);
    device.queue.submit([encoder.finish()]); await readback.mapAsync(1);
    const values = Array.from(new Uint16Array(readback.getMappedRange()), halfFloat.f16ToF32); readback.unmap();
    if (errors.length) throw new Error(errors.join('\n'));
    return values;
  } finally { for (const resource of owned) resource.destroy(); device.destroy(); }
}

// Independent integer-tap reference for the progressive Gaussian path.
function referenceBloom(data, parameters = { threshold: 0, smoothWidth: 0.01, radius: 0 }) {
  const quantize = (value) => halfFloat.f16ToF32(halfFloat.f32ToF16(value));
  const image = (w, h, value) => {
    const rgb = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) rgb[(y * w + x) * 3 + c] = quantize(value(x, y, c));
    return { w, h, rgb };
  };
  const texel = ({ w, h, rgb }, x, y, c) => rgb[(Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))) * 3 + c];
  const sample = (source, u, v, c) => {
    const x = u * source.w - 0.5, y = v * source.h - 0.5;
    const i = Math.floor(x), j = Math.floor(y);
    const dx = x - i, dy = y - j;
    return (1 - dy) * ((1 - dx) * texel(source, i, j, c) + dx * texel(source, i + 1, j, c)) +
      dy * ((1 - dx) * texel(source, i, j + 1, c) + dx * texel(source, i + 1, j + 1, c));
  };
  const unpack = data instanceof Uint16Array ? (v) => halfFloat.f16ToF32(v) : (v) => v / 255;
  let source = image(width, height, (x, y, c) => unpack(data[(y * width + x) * 4 + c]));
  const seeds = [];
  for (let level = 0; level < 5; level++) {
    const down = image(Math.ceil(source.w / 2), Math.ceil(source.h / 2), (x, y, c) => 0.25 *
      (texel(source, x * 2, y * 2, c) + texel(source, x * 2 + 1, y * 2, c) +
        texel(source, x * 2, y * 2 + 1, c) + texel(source, x * 2 + 1, y * 2 + 1, c)));
    source = level === 0 && parameters.threshold >= 0
      ? image(down.w, down.h, (x, y, c) => {
          const luminance = [0.2126, 0.7152, 0.0722].reduce((sum, weight, channel) => sum + weight * texel(down, x, y, channel), 0);
          const t = parameters.smoothWidth === 0 ? Number(luminance > parameters.threshold) :
            Math.max(0, Math.min(1, (luminance - parameters.threshold) / parameters.smoothWidth));
          return texel(down, x, y, c) * t * t * (3 - 2 * t);
        })
      : down;
    seeds.push(source);
  }
  let accumulated;
  for (let level = 4; level >= 0; level--) {
    const seed = seeds[level], count = 6 + 4 * level, sigma = count / 3;
    const offsets = Array.from({ length: count * 2 - 1 }, (_, i) => i - count + 1);
    const coefficients = offsets.map((i) => Math.exp(-0.5 * (i / sigma) ** 2));
    const total = coefficients.reduce((a, b) => a + b, 0);
    const filter = (from, x, y, c, dx, dy) => offsets.reduce((sum, offset, i) =>
      sum + coefficients[i] * texel(from, x + dx * offset, y + dy * offset, c), 0) / total;
    const horizontal = image(seed.w, seed.h, (x, y, c) => filter(seed, x, y, c, 1, 0));
    const factor = 1 - 0.2 * level;
    const weight = (factor * (1 - parameters.radius) + (1.2 - factor) * parameters.radius) / 3;
    const coarse = accumulated;
    accumulated = image(seed.w, seed.h, (x, y, c) => filter(horizontal, x, y, c, 0, 1) * weight +
      (coarse ? sample(coarse, (x + 0.5) / seed.w, (y + 0.5) / seed.h, c) : 0));
  }
  return Array.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? 1 : quantize(
    sample(accumulated, ((i >> 2) % width + 0.5) / width, (Math.floor((i >> 2) / width) + 0.5) / height, i % 4),
  ));
}

function verifyFxaa(actual, inputData, parity) {
  const input = Array.from(inputData, (value) => value / 255);
  const changedFromInput = difference(actual, input).mean;
  const metrics = { ...parity, changedFromInput };
  if (metrics.max > 0.01 || metrics.mean > 0.0001 || metrics.changedFromInput < 0.001) {
    throw new Error(`FXAA comparison failed: ${JSON.stringify(metrics)}`);
  }
  return metrics;
}

async function run() {
  if (REVISION !== '187') throw new Error(`Expected Three r187, loaded r${REVISION}`);
  const referenceRevision = `r${REVISION}`;
  const shaderRegistry = new ShaderRegistry({
    manifestUrl: '/shaders/manifest.json',
    prepareProgramCompiler: prepareShaderProgramCompiler,
  });
  (await shaderRegistry.loadManifest()).unwrap();
  const manifest = { entries: [...shaderRegistry.entries()] };
  const report = { engineRevision: __FORGEAX_PRODUCT_HEAD__, reference: `Three ${referenceRevision}`, referenceRevision, inputSize: [width, height], bloomImpulseRadiance: 8 };
  for (const effect of ['fxaa', 'bloom']) {
    const data = effect === 'bloom' ? Uint16Array.from(pixels(effect), (value, i) => halfFloat.f32ToF16(i % 4 === 3 ? 1 : value * 8 / 255)) : pixels(effect), reference = await threeCapture(data, effect), actual = await forgeCapture(manifest, data, effect);
    if (![...actual, ...reference].every(Number.isFinite)) throw new Error(`${effect}: non-finite pixels`);
    present(effect, 'ForgeAX', actual, effect === 'bloom' ? 0.75 : 1);
    present(effect, `Three ${referenceRevision} WebGPU`, reference, effect === 'bloom' ? 0.75 : 1);
    report[effect] = difference(actual, reference);
    if (effect === 'bloom') {
      report.bloom.progressiveReference = difference(actual, referenceBloom(data));
      const check = report.bloom.progressiveReference;
      if (check.max > 0.01 || check.mean > 0.0005) throw new Error(`Progressive Bloom comparison failed: ${JSON.stringify(check)}`);
      report.bloom.meanSignal = { forgeax: mean(actual), three: mean(reference) };
      if (mean(actual) < 0.001 || mean(reference) < 0.001) throw new Error('Bloom impulse disappeared');
    }
    if (effect === 'fxaa') report.fxaa = verifyFxaa(actual, data, report.fxaa);
  }
  const ramp = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) ramp.set([x, x, x, 255], (y * width + x) * 4);
  report.bloom.parameterCases = [];
  for (const radius of [0, 0.5, 1]) {
    const parameters = { threshold: 0.4, smoothWidth: 0.12, radius };
    const reference = await threeCapture(ramp, 'bloom', parameters);
    const actual = await forgeCapture(manifest, ramp, 'bloom', parameters);
    const delta = difference(actual, reference);
    const progressive = difference(actual, referenceBloom(ramp, parameters));
    report.bloom.parameterCases.push({ parameters, three: delta, progressive });
    if (progressive.max > 0.01 || progressive.mean > 0.001) throw new Error(`Bloom parameter comparison failed: ${JSON.stringify({ parameters, delta })}`);
  }
  const constant = pixels('constant');
  report.bloom.uniformGain = {
    forgeax: mean(await forgeCapture(manifest, constant, 'bloom')) / (64 / 255),
    three: mean(await threeCapture(constant, 'bloom')) / (64 / 255),
  };
  report.bloom.expectedThreeUniformGain = threeBloomUniformGain();
  if (Math.abs(report.bloom.uniformGain.forgeax - 1) > 0.01 || Math.abs(report.bloom.uniformGain.three - report.bloom.expectedThreeUniformGain) > 0.01) throw new Error(`Bloom gain reference changed: ${JSON.stringify(report.bloom.uniformGain)}`);
  document.getElementById('status').textContent = JSON.stringify(report, null, 2);
  globalThis.__renderDefaultsComparison = report;
}
run().catch((error) => {
  document.getElementById('status').textContent = String(error.stack ?? error);
  globalThis.__renderDefaultsComparisonError = String(error.stack ?? error);
});
