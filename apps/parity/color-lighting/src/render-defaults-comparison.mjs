import { halfFloat } from '@forgeax/engine/math';
import { readShaderManifestPublication } from '@forgeax/engine/shader';
import { DataTexture, HalfFloatType, LinearFilter, LinearSRGBColorSpace, NoToneMapping, RGBAFormat, RenderTarget, UnsignedByteType } from 'three';
import { NodeMaterial, QuadMesh, WebGPURenderer } from 'three/webgpu';
import { texture } from 'three/tsl';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

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
// r184 truncates each separable Gaussian without normalizing it.
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
  const pass = async (marker, textures, values, output) => {
    const entry = manifest.entries.find((e) => e.wgsl.includes(marker));
    if (!entry) throw new Error(`Production shader is missing: ${marker}`);
    const module = device.createShaderModule({ code: entry.wgsl });
    const pipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module, entryPoint: 'vs_main' }, fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] } });
    const buffer = device.createBuffer({ size: values.length * 4, usage: 0x40 | 8 }); owned.push(buffer);
    device.queue.writeBuffer(buffer, 0, new Float32Array(values));
    const resources = [...textures.map((t) => t.createView()), sampler, { buffer }];
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({ binding, resource })) });
    const render = encoder.beginRenderPass({ colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store' }] });
    render.setPipeline(pipeline); render.setBindGroup(0, group); render.draw(3); render.end();
  };
  try {
    let result;
    if (effect === 'fxaa') {
      result = makeTexture(width, height);
      await pass('struct FxaaParams', [input], [0, 0, 0, 0], result);
    } else {
      const levels = [];
      let w = width, h = height, previous = input;
      for (let level = 0; level < 5; level++) {
        w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2));
        const current = makeTexture(w, h);
        await pass('struct BloomHorizontalParams', [previous], [parameters.threshold, parameters.smoothWidth, w, h, level, 0, 0, 0], current);
        const vertical = makeTexture(w, h);
        await pass('struct BloomVerticalParams', [current], [level, 0, 0, 0], vertical);
        levels.push(vertical); previous = vertical;
      }
      // The production composite upsamples the bloom component. A zero scene
      // isolates its additive contribution without changing that shader.
      const zero = makeTexture(width, height); result = makeTexture(width, height);
      await pass('struct BloomCompositeParams', [zero, ...levels], [1, parameters.radius, 0, 0], result);
    }
    const readback = device.createBuffer({ size: width * height * 8, usage: 1 | 8 }); owned.push(readback);
    encoder.copyTextureToBuffer({ texture: result }, { buffer: readback, bytesPerRow: width * 8 }, [width, height]);
    device.queue.submit([encoder.finish()]); await readback.mapAsync(1);
    const values = Array.from(new Uint16Array(readback.getMappedRange()), halfFloat.f16ToF32); readback.unmap();
    if (errors.length) throw new Error(errors.join('\n'));
    return values;
  } finally { for (const resource of owned) resource.destroy(); device.destroy(); }
}

async function run() {
  const manifest = await readShaderManifestPublication(await (await fetch('/shaders/manifest.json')).json());
  const report = { engineRevision: __FORGEAX_PRODUCT_HEAD__, reference: 'Three r184 / d3b629c0c2097cec664ad16369bb6eae3b10e335', inputSize: [width, height], bloomImpulseRadiance: 8 };
  for (const effect of ['fxaa', 'bloom']) {
    const data = effect === 'bloom' ? Uint16Array.from(pixels(effect), (value, i) => halfFloat.f32ToF16(i % 4 === 3 ? 1 : value * 8 / 255)) : pixels(effect), reference = await threeCapture(data, effect), actual = await forgeCapture(manifest, data, effect);
    if (![...actual, ...reference].every(Number.isFinite)) throw new Error(`${effect}: non-finite pixels`);
    present(effect, 'ForgeaX', actual, effect === 'bloom' ? 0.75 : 1);
    present(effect, 'Three r184 WebGPU', reference, effect === 'bloom' ? 0.75 : 1);
    report[effect] = difference(actual, reference);
    if (effect === 'bloom') {
      if (report.bloom.max > 0.01 || report.bloom.mean > 0.0005) throw new Error(`Bloom comparison failed: ${JSON.stringify(report.bloom)}`);
      report.bloom.meanSignal = { forgeax: mean(actual), three: mean(reference) };
      if (mean(actual) < 0.001 || mean(reference) < 0.001) throw new Error('Bloom impulse disappeared');
    }
    if (effect === 'fxaa') {
      const input = Array.from(data, (x) => x / 255);
      report.fxaa.changedFromInput = difference(actual, input).mean;
      if (report.fxaa.max > 0.01 || report.fxaa.mean > 0.0001 || report.fxaa.changedFromInput < 0.001) throw new Error(`FXAA comparison failed: ${JSON.stringify(report.fxaa)}`);
    }
  }
  const ramp = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) ramp.set([x, x, x, 255], (y * width + x) * 4);
  report.bloom.parameterCases = [];
  for (const radius of [0, 0.5, 1]) {
    const parameters = { threshold: 0.4, smoothWidth: 0.12, radius };
    const reference = await threeCapture(ramp, 'bloom', parameters);
    const actual = await forgeCapture(manifest, ramp, 'bloom', parameters);
    const delta = difference(actual, reference);
    report.bloom.parameterCases.push({ parameters, ...delta });
    if (delta.max > 0.01 || delta.mean > 0.001) throw new Error(`Bloom parameter comparison failed: ${JSON.stringify({ parameters, delta })}`);
  }
  const constant = pixels('constant');
  report.bloom.uniformGain = {
    forgeax: mean(await forgeCapture(manifest, constant, 'bloom')) / (64 / 255),
    three: mean(await threeCapture(constant, 'bloom')) / (64 / 255),
  };
  report.bloom.expectedThreeUniformGain = threeBloomUniformGain();
  if (Math.abs(report.bloom.uniformGain.forgeax - report.bloom.expectedThreeUniformGain) > 0.01 || Math.abs(report.bloom.uniformGain.three - report.bloom.expectedThreeUniformGain) > 0.01) throw new Error(`Bloom gain reference changed: ${JSON.stringify(report.bloom.uniformGain)}`);
  document.getElementById('status').textContent = JSON.stringify(report, null, 2);
  globalThis.__renderDefaultsComparison = report;
}
run().catch((error) => {
  document.getElementById('status').textContent = String(error.stack ?? error);
  globalThis.__renderDefaultsComparisonError = String(error.stack ?? error);
});
