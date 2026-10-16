import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { composeShader } from '../../naga/dist/index.mjs';
import { directDfgLutBytes } from '@forgeax/engine-shader';
import { runDirectDfgWebgpu } from './direct-dfg-webgpu.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { values } = parseArgs({ options: { out: { type: 'string' }, 'old-ref': { type: 'string', default: 'ee236692c' }, width: { type: 'string', default: '1280' }, height: { type: 'string', default: '720' } } });
if (!values.out || !/^[a-f0-9]{7,40}$/.test(values['old-ref'])) throw Error('Usage: node build-direct-dfg-webgpu.mjs --out NEW_DIRECTORY [--old-ref COMMIT_HEX] [--width 1280 --height 720]');
const extent = [Number(values.width), Number(values.height)];
if (extent.some(size => !Number.isSafeInteger(size) || size < 64 || size > 4096)) throw Error('extent must be 64–4096');
const oldCommit = execFileSync('git', ['rev-parse', '--verify', values['old-ref']], { cwd: root, encoding: 'utf8' }).trim();
const old = execFileSync('git', ['show', oldCommit + ':packages/shader/src/brdf.wgsl'], { cwd: root, encoding: 'utf8' });
const current = await readFile(resolve(root, 'packages/shader/src/brdf.wgsl'), 'utf8');
if (!old.includes('var<private> three_r184_dfg_lut') || current.includes('var<private> three_r184_dfg_lut')) throw Error('expected historical private-array and current no-array production BRDF');
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const words = [...(old.match(/var<private> three_r184_dfg_lut[\s\S]*?\);/)?.[0] ?? '').matchAll(/0x([a-f0-9]{8})u/g)];
if (words.length !== 256) throw Error('historical table must contain 256 RG16F texels');
const referenceBytes = Buffer.alloc(1024);
words.forEach((word, index) => referenceBytes.writeUInt32LE(Number.parseInt(word[1], 16), index * 4));
if (!referenceBytes.equals(Buffer.from(directDfgLutBytes()))) throw Error('production DFG table differs from historical source bytes');
// The historical combination remains independent of the current BRDF. Only
// sampling changes, so native filtering is compared against native filtering.
const reference = old.replace(/fn sampleThreeR184DfgLut\([\s\S]*?\n\}/, `
@group(0) @binding(1) var referenceLut: texture_2d<f32>;
@group(0) @binding(2) var referenceFiltering: sampler;
fn sampleThreeR184DfgLut(roughness: f32, dotNV: f32) -> vec2<f32> {
  return textureSampleLevel(referenceLut, referenceFiltering,
    clamp(vec2<f32>(roughness, dotNV), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rg;
}`);
if (reference === old) throw Error('historical sampling function was not found');
const shaders = {};
for (const mode of ['private-array', 'fit', 'texture', 'native-reference']) {
  const historical = mode === 'private-array' || mode === 'native-reference';
  const name = historical ? 'threeR184DirectMultiScatter' : 'directMultiScatter';
  const args = historical ? '' : mode === 'texture' ? ', true, lut, filtering' : ', false';
  shaders[mode] = await composeShader(`
#import forgeax_pbr::brdf::{${name}}
@group(0) @binding(0) var<uniform> params: vec4<f32>;
${mode === 'texture' ? '@group(0) @binding(1) var lut: texture_2d<f32>;\n@group(0) @binding(2) var filtering: sampler;' : ''}
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = position.xy / params.xy;
  var color = vec3<f32>(0.0);
  for (var light = 0u; light < 4u; light++) {
    let nl = fract(uv.y + f32(light) * 0.25);
    color += ${name}(uv.x, uv.y, nl, vec3<f32>(0.04, 0.3, 0.9)${args});
  }
  return vec4<f32>(color, 1.0);
}
`, { 'forgeax_pbr::brdf': mode === 'native-reference' ? reference : mode === 'private-array' ? old : current }, mode === 'texture' ? { DIRECT_DFG_LUT_AVAILABLE: true } : {});
}
const input = { extent, shaders, lutBytes: Array.from(directDfgLutBytes()), referenceBytes: Array.from(referenceBytes), source: {
  oldCommit, oldBrdf: digest(old), currentBrdf: digest(current), lut: digest(directDfgLutBytes()),
  nativeReferenceBrdf: digest(reference), referenceLut: digest(referenceBytes),
  shaders: Object.fromEntries(Object.entries(shaders).map(([mode, source]) => [mode, digest(source)])),
} };
await mkdir(values.out, { recursive: false });
await writeFile(resolve(values.out, 'inputs.json'), JSON.stringify(input, null, 2));
await writeFile(resolve(values.out, 'run.js'), `const input=await(await fetch('./inputs.json')).json();\nglobalThis.runDfg=()=>(${runDirectDfgWebgpu.toString()})(input);\ndocument.querySelector('button').onclick=async()=>{document.querySelector('button').disabled=true;const result=await runDfg();globalThis.dfgResult=result;document.querySelector('pre').textContent=JSON.stringify(result,null,2);document.querySelector('button').disabled=false;};\n`);
await writeFile(resolve(values.out, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Direct DFG WebGPU comparison</title><style>body{font:16px system-ui;background:#14202a;color:#eee;margin:32px}button{font:inherit;padding:12px}pre{white-space:pre-wrap}</style><h1>Direct DFG · WebGPU</h1><p>Private array / UE fit / optional texture. Four-light fragment workload; GPU time and approximation error are separate.</p><button>Run bounded comparison</button><pre>Confirm Mac CPU and GPU headroom before running.</pre><script type="module" src="./run.js"></script>');
console.log(JSON.stringify({ out: resolve(values.out), extent, source: input.source }));
