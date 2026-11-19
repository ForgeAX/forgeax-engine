import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  composeShader,
  emit_reflection,
  parse,
  parseReflectionWire,
  validate,
} from '../../../naga/src/index';
import { projectShaderConditionals } from '../../../shader-compiler/src/conditionals';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

function reachableImports(modules: Record<string, string>): Record<string, string> {
  const selected: Record<string, string> = {};
  const include = (id: string) => {
    if (selected[id] !== undefined) return;
    const text = modules[id];
    if (text === undefined) throw new Error(`Missing test shader module ${id}`);
    selected[id] = text;
    for (const match of text.matchAll(/^#import\s+([^\s{]+?)(?=::\{|\s|$)/gm)) {
      if (match[1] !== undefined) include(match[1]);
    }
  };
  include('test::direct_split');
  return selected;
}

async function storageLightDataBytes(code: string): Promise<number> {
  const module = (await validate((await parse(code)).unwrap())).unwrap();
  try {
    const reflection = parseReflectionWire((await emit_reflection(module, '{}')).unwrap());
    const bytes = reflection.boundGlobals.find(({ group, binding }) => group === 2 && binding === 3)
      ?.typeDescriptor?.byteSize;
    if (bytes === undefined) throw new Error('Missing reflected storage light-data size');
    return bytes;
  } finally {
    module.free();
  }
}

function countedCluster(): string {
  const text = source('standard-cluster.wgsl');
  const signature = /fn ndc_position_to_cluster\([\s\S]*?\) -> vec3<u32> \{/;
  if (!signature.test(text)) throw new Error('Missing Standard cluster lookup');
  // Instrument the real lookup, leaving membership and lighting evaluation intact.
  return text.replace(
    signature,
    (match) => `
var<private> clusterLookupCalls: u32;
fn clusterLookupCount() -> u32 { return clusterLookupCalls; }
${match}
  clusterLookupCalls += 1u;`,
  );
}

function directLightSlotDeclaration(text: string): string {
  const signature = 'struct DirectLightSlot {';
  const start = text.indexOf(signature);
  const end = start < 0 ? -1 : text.indexOf('\n};', start);
  if (start < 0 || end < 0 || end - start > 2048) {
    throw new Error('Missing bounded production DirectLightSlot declaration in common.wgsl');
  }
  if (text.indexOf(signature, start + signature.length) >= 0) {
    throw new Error('Expected one production DirectLightSlot declaration in common.wgsl');
  }
  return text.slice(start, end + '\n};'.length);
}

const sharedLightingSource = source('standard-lighting.wgsl');
const environmentStart = sharedLightingSource.indexOf('struct SkylightUniforms');
if (environmentStart < 0) throw new Error('Missing production environment/direct boundary');
const productionCommon = source('common.wgsl');
const productionView = productionCommon.match(
  /struct AtmosphereMedium \{[\s\S]*?\n\};\nstruct View \{[\s\S]*?\n\};/,
)?.[0];
if (productionView === undefined) throw new Error('Missing production View declaration');
// The lookup uses the fragment's own screen position over the 16x4 viewport
// (written by the fragment entry); `projected` only mirrors the supplied
// (interpolated) NDC, which must not pick the cell.
const common = `
#define_import_path forgeax_view::common
${productionView}
var<private> view : View;
@group(0) @binding(0) var spotShadowMap: texture_depth_2d_array;
@group(0) @binding(1) var shadowSampler: sampler_comparison;
${directLightSlotDeclaration(productionCommon)}
@group(0) @binding(2) var shadowMap: texture_depth_2d_array;
${productionCommon.match(/struct ShadowCasterCascade \{[\s\S]*?\n\};/)?.[0] ?? ''}
var<private> shadowCasterCascade: ShadowCasterCascade;
${productionCommon.match(/fn directionalShadowCasterBias\([^}]+\}/)?.[0] ?? ''}
${productionCommon.match(/fn lightingChannelsMatch\([^}]+\}/)?.[0] ?? ''}
`;

// Execute the exact production direct-light owner with environment evaluation
// excluded and solar transport set to identity. Its real punctual, shadow,
// membership, channel and BRDF code remains intact. Alternating pixels contain
// a tiny Lambert component that the old HDR subtraction rounded away.
function assertDirectSplitPixels(
  pixels: Float32Array,
  output: 'diffuse' | 'radiance' | 'solar',
  lightCount: number,
): number[] {
  const frameCalls: number[] = [];
  let brightest = 0;
  for (let i = 0; i < 64; i++) {
    expect(pixels[256 + i * 4 + 3]).toBe(1);
    for (let c = 0; c < 3; c++) {
      const value = pixels[i * 4 + c] ?? Number.NaN;
      const reference = pixels[256 + i * 4 + c] ?? Number.NaN;
      if (output === 'radiance') {
        // The independent reference folds literals at a different scope;
        // native optimization may differ by a few binary32 rounding steps.
        const actualBits = new Uint32Array(new Float32Array([value]).buffer)[0] ?? 0;
        const referenceBits = new Uint32Array(new Float32Array([reference]).buffer)[0] ?? 0;
        expect(Math.abs(actualBits - referenceBits)).toBeLessThanOrEqual(4);
      }
      expect(
        Math.abs(value - reference),
        `count=${lightCount} pixel=${i} channel=${c}`,
      ).toBeLessThanOrEqual(Math.max(1e-15, Math.abs(reference) * 0.00001));
      brightest = Math.max(brightest, value);
    }
    frameCalls.push(pixels[i * 4 + 3] ?? Number.NaN);
  }
  if (lightCount === 0 && output !== 'solar') expect(brightest).toBe(0);
  else expect(brightest).toBeGreaterThan(0.05);
  return frameCalls;
}

function directSplitOracleSource(output: 'diffuse' | 'radiance' | 'solar'): string {
  return `
#import forgeax_standard::cluster::{clusterLookupCount, cluster_uniform}
#import test::direct_split::{evaluateStandardDirectSplit, evaluateStandardDirect}
#import forgeax_pbr::brdf::{standardOpaqueBrdfFromView, prepareDirectMultiScatterView, halfVectorTerms, directLightingAlpha}
#import forgeax_pbr::lighting_attenuation::{evalDistanceAttenuation}
#import forgeax_view::common::{view}
// Independent former combined-BRDF expression, retaining its operation order.
fn referencePoint(lightPos: vec3<f32>, radiance: vec3<f32>, worldPos: vec3<f32>, normal: vec3<f32>, direction: vec3<f32>, baseColor: vec3<f32>, f0: vec3<f32>) -> vec3<f32> {
  let toLight = lightPos - worldPos;
  let dSquared = max(dot(toLight, toLight), 1e-4);
  let l = toLight / sqrt(dSquared);
  let nl = dot(normal, l);
  let nv = dot(normal, direction);
  let terms = halfVectorTerms(nl, nv, dot(direction, l));
  let alpha = directLightingAlpha(0.25);
  let brdf = standardOpaqueBrdfFromView(baseColor, 0.3, alpha, f0,
    prepareDirectMultiScatterView(alpha, max(nv, 1e-5), f0, false), max(nl, 0.0), terms.x, terms.y, false);
  return brdf * radiance * max(nl, 0.0) * evalDistanceAttenuation(dSquared, 0.01, 2.0, 1e-4);
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  return vec4(f32((i << 1u) & 2u)*2.0-1.0, 1.0-f32(i & 2u)*2.0, 0.0, 1.0);
}
struct Output { @location(0) actual: vec4<f32>, @location(1) expected: vec4<f32> }
@fragment fn fs(@builtin(position) p: vec4<f32>) -> Output {
  view.viewportWidth = 16.0;
  view.viewportHeight = 4.0;
  view.lightDir = vec3<f32>(0.0, 0.0, -1.0);
  view.lightColor = vec3<f32>(1.0, 2.0, 3.0);
  view.lightingChannels = ${output === 'solar' ? '1u' : '0u'};
  let right = p.x >= 8.0;
  let far = p.y >= 2.0;
  let channels = select(1u, 2u, u32(p.y) % 2u != 0u);
  let ndc = vec3(((p.x / 16.0) * 2.0 - 1.0), 0.0, 0.5);
  let worldPos = vec3((p.x - 8.0) / 16.0, 0.0, 0.0);
  let normal = normalize(vec3(0.2, 0.0, 1.0));
  let viewDir = vec3(0.0, 0.0, 1.0);
  let baseColor = vec3(0.4, 0.6, 0.8) * select(1.0, 0.00000001, u32(p.x) % 2u != 0u);
  let f0 = vec3(0.06);
  let actual = ${output === 'radiance' ? 'evaluateStandardDirect' : 'evaluateStandardDirectSplit'}(worldPos, ndc, select(-2.0, -8.0, far), p.xy,
    normal, viewDir, baseColor, vec3(0.0), 0.3, 0.25, f0, 0.5, false, channels, ${output === 'radiance' ? '' : 'true, '}false).${output === 'radiance' ? 'radiance' : 'diffuse'};
  var expected = vec3(0.0);
  ${
    output === 'solar'
      ? `if (channels == 1u) {
    expected += baseColor * 0.7 / 3.14159265 * view.lightColor * max(normal.z, 0.0) * 0.5;
  }`
      : ''
  }
  if (cluster_uniform.grid.w != 0u) {
    // Independently selected cell membership and channels; real punctual BRDF.
    if (right && channels == 1u) {
      let toLight = vec3(-0.5, 0.0, 2.0) - worldPos;
      let dSquared = max(dot(toLight, toLight), 1e-4);
      ${
        output === 'radiance'
          ? `expected += referencePoint(vec3(-0.5, 0.0, 2.0), vec3(4.0, 2.0, 1.0), worldPos, normal, viewDir, baseColor, f0);`
          : `expected += baseColor * 0.7 / 3.14159265 * vec3(4.0, 2.0, 1.0)
        * max(dot(normal, toLight / sqrt(dSquared)), 0.0)
        * evalDistanceAttenuation(dSquared, 0.01, 2.0, 1e-4);`
      }
    }
    if (far && channels == 2u) {
      let toLight = vec3(0.5, 0.0, 3.0) - worldPos;
      let dSquared = max(dot(toLight, toLight), 1e-4);
      ${
        output === 'radiance'
          ? `expected += referencePoint(vec3(0.5, 0.0, 3.0), vec3(1.0, 3.0, 5.0), worldPos, normal, viewDir, baseColor, f0);`
          : `expected += baseColor * 0.7 / 3.14159265 * vec3(1.0, 3.0, 5.0)
        * max(dot(normal, toLight / sqrt(dSquared)), 0.0)
        * evalDistanceAttenuation(dSquared, 0.01, 2.0, 1e-4);`
      }
    }
  }
  return Output(vec4(actual, f32(clusterLookupCount())), vec4(expected, 1.0));
}`;
}

it.each([
  [true, 'diffuse'],
  [false, 'diffuse'],
  [true, 'radiance'],
  [false, 'radiance'],
  [true, 'solar'],
  [false, 'solar'],
] as const)('Standard direct storage=%s output=%s traverses membership once and preserves its components', async (storage, output) => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn cluster regression requires a GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const buffers: GPUBuffer[] = [];
  const textures: GPUTexture[] = [];
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const result = device.createBuffer({ size, usage });
    buffers.push(result);
    return result;
  };
  const texture = (descriptor: GPUTextureDescriptor) => {
    const result = device.createTexture(descriptor);
    textures.push(result);
    return result;
  };
  try {
    const defines = { CLUSTER_FORWARD_AVAILABLE: true, STORAGE_BUFFER_AVAILABLE: storage };
    const code = await composeShader(
      directSplitOracleSource(output),
      reachableImports(
        Object.fromEntries(
          Object.entries({
            ...Object.fromEntries(
              (await import('node:fs'))
                .readdirSync(new URL('../', import.meta.url), { recursive: true })
                .flatMap((file) => {
                  if (typeof file !== 'string' || !file.endsWith('.wgsl')) return [];
                  const text = source(file);
                  const id = text.match(/^#define_import_path\s+(\S+)/m)?.[1];
                  return id ? [[id, text]] : [];
                }),
            ),
            'forgeax_view::common': common,
            'test::direct_split': `#define_import_path test::direct_split
${sharedLightingSource
  .slice(0, environmentStart)
  .split('\n')
  .filter(
    (line) =>
      !line.startsWith('#define_import_path') &&
      !line.includes('::ibl_') &&
      !line.includes('::lighting_probe'),
  )
  .join('\n')}
${source('standard-lighting.wgsl').slice(source('standard-lighting.wgsl').indexOf('struct StandardDirect'))}`,
            'forgeax_view::atmosphere': `#define_import_path forgeax_view::atmosphere
#import forgeax_view::common::{View}
fn view_apply_direct_solar(v: View, radiance: vec3<f32>, position: vec3<f32>) -> vec3<f32> { return radiance; }`,
            'forgeax_pbr::lighting_directional': source('lighting-directional.wgsl'),
            'forgeax_standard::cluster_texture_data': source('cluster-texture-data.wgsl'),
            'forgeax_standard::cluster': countedCluster(),
            'forgeax_pbr::lighting_punctual': source('lighting-punctual.wgsl'),
            'forgeax_pbr::lighting_spot_modifiers': source('lighting-spot-modifiers.wgsl'),
            'forgeax_pbr::lighting_spot_projector': source('lighting-spot-projector.wgsl'),
            'forgeax_pbr::lighting_ies_profile': source('lighting-ies-profile.wgsl'),
            'forgeax_pbr::lighting_rect_area': source('lighting-rect-area.wgsl'),
            'forgeax_pbr::lighting_attenuation': source('lighting-attenuation.wgsl'),
            'forgeax_pbr::brdf': source('brdf.wgsl'),
            'forgeax_pbr::shadow_pcf': source('shadow-pcf.wgsl'),
          }).map(([id, text]) => [id, projectShaderConditionals(text, defines, 'all')]),
        ),
      ),
      defines,
    );
    const module = device.createShaderModule({ code });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{ format: 'rgba32float' }, { format: 'rgba32float' }],
      },
    });
    const depth = texture({
      size: [1, 1, 4],
      format: 'depth32float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const shadows = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: depth.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: device.createSampler({ compare: 'greater' }) },
      ],
    });
    const empty = device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [] });
    const actual = texture({
      size: [16, 4],
      format: 'rgba32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const expected = texture({
      size: [16, 4],
      format: 'rgba32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const readback = buffer(2048, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    // Match all six reflected vec4 rows in the 96-byte Standard Cluster uniform ABI.
    const uniform = buffer(96, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    // Match the renderer's 96-byte DirectLightSlot and grid.w admitted-count ABI.
    const lightData = new ArrayBuffer(storage ? await storageLightDataBytes(code) : 256 * 96);
    const lightFloats = new Float32Array(lightData);
    const lightWords = new Uint32Array(lightData);
    lightFloats.set([-0.5, 0, 2, 0.01, 4, 2, 1, 2]);
    lightFloats.set([0.5, 0, 3, 0.01, 1, 3, 5, 2], 24);
    for (let i = 0; i < 2; i++) {
      lightWords.set([0, 0xffffffff, 0xffffffff, 0xffffffff, 1 << i, 0, 0, 0], i * 24 + 16);
    }
    const indices = new Uint32Array([0, 1, 0, 1]);
    const entries: GPUBindGroupEntry[] = [{ binding: 6, resource: { buffer: uniform } }];
    let gridBuffer: GPUBuffer | undefined;
    let dataTexture: GPUTexture | undefined;
    if (storage) {
      const lights = buffer(lightData.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const indexList = buffer(
        indices.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      gridBuffer = buffer(32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(lights, 0, lightData);
      device.queue.writeBuffer(indexList, 0, indices);
      entries.push(
        { binding: 3, resource: { buffer: lights } },
        { binding: 4, resource: { buffer: gridBuffer } },
        { binding: 5, resource: { buffer: indexList } },
      );
    } else {
      dataTexture = texture({
        size: [1024, 2],
        format: 'rgba32uint',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      entries.push({ binding: 3, resource: dataTexture.createView() });
    }
    const clusters = device.createBindGroup({ layout: pipeline.getBindGroupLayout(2), entries });
    const calls: number[][] = [];
    for (const lightCount of [0, 2, 0]) {
      const payload = new ArrayBuffer(96);
      const u32 = new Uint32Array(payload);
      u32.set([2, 1, 2, lightCount], 0);
      new Float32Array(payload).set([1, 16, Math.log(16), 0], 4);
      // Six slot vec4s, grid at 256 slots, then the four-cell index list.
      u32.set([6, 256 * 24, 256 * 24 + 8, 1024], 16);
      u32.set([2, 1, 0, 0], 20);
      device.queue.writeBuffer(uniform, 0, payload);
      // Four cells: empty, first light, second light, both lights.
      const grid =
        lightCount === 0 ? new Uint32Array(8) : new Uint32Array([0, 0, 0, 1, 1, 1, 2, 2]);
      if (gridBuffer) device.queue.writeBuffer(gridBuffer, 0, grid);
      if (dataTexture) {
        const words = new Uint32Array(1024 * 2 * 4);
        words.set(lightWords);
        words.set(grid, 256 * 24);
        words.set(indices, 256 * 24 + 8);
        device.queue.writeTexture(
          { texture: dataTexture },
          words,
          { bytesPerRow: 1024 * 16 },
          [1024, 2],
        );
      }
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [actual, expected].map((target) => ({
          view: target.createView(),
          loadOp: 'clear',
          storeOp: 'store',
        })),
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, shadows);
      pass.setBindGroup(1, empty);
      pass.setBindGroup(2, clusters);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: actual },
        { buffer: readback, bytesPerRow: 256 },
        [16, 4],
      );
      encoder.copyTextureToBuffer(
        { texture: expected },
        { buffer: readback, offset: 1024, bytesPerRow: 256 },
        [16, 4],
      );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const pixels = new Float32Array(readback.getMappedRange()).slice();
      readback.unmap();
      expect(errors).toEqual([]);
      const frameCalls = assertDirectSplitPixels(pixels, output, lightCount);
      calls.push(frameCalls);
    }
    expect(calls, 'Empty admitted-light frames must not perform cluster lookup').toEqual(
      [0, 1, 0].map((count) => Array.from({ length: 64 }, () => count)),
    );
  } finally {
    for (const value of buffers) value.destroy();
    for (const value of textures) value.destroy();
    device.destroy();
  }
});
