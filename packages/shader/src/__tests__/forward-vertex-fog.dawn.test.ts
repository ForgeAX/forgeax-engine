import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const viewDeclaration = source('common.wgsl').match(
  /struct AtmosphereMedium \{[\s\S]*?\n\};\nstruct View \{[\s\S]*?\n\};/,
)?.[0];
if (viewDeclaration === undefined) throw Error('Missing production View declaration');
const atmosphereFlags = [
  'view_atmosphere_aerial_enabled',
  'view_atmosphere_fast_ap',
  'view_atmosphere_affects_height_fog',
]
  .map((name) => {
    const body = source('common.wgsl').match(new RegExp(`fn ${name}\\([\\s\\S]*?\\n\\}`))?.[0];
    if (body === undefined) throw Error(`Missing production View helper ${name}`);
    return body;
  })
  .join('\n');

const width = 32;
const height = 8;
const worlds = [
  [-2, 0, -4],
  [3, 4, -10],
  [-2, 8, -20],
] as const;
const fogColor = [0.25, 0.5, 0.75];
const color = [1.4, 0.3, 2.2];
const backdrop = [0.12, 0.28, 0.09];
const transmission = [0.2, 0.4, 0.1];

it('fogs only covered foreground samples before the native 4x sky resolve', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('MSAA fog acceptance requires a GPU adapter');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  const code = await composeShader(
    `
#import forgeax_view::common::{View}
#import forgeax_view::fog::{vertex_height_fog, forward_fog}
fn frame() -> View {
  var v: View;
  v.fogColorDensity = vec4f(0.2,0.2,0.2,0.069314718);
  v.fogHeightOpacity = vec4f(0,1,0,0);
  v.fogSky = vec4f(1,1,0.069314718,0);
  return v;
}
struct Vertex { @builtin(position) clip: vec4f, @location(0) fog: f32 }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Vertex {
  let points = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return Vertex(vec4f(points[i],0.5,1),vertex_height_fog(frame(),vec3f(0,0,-10)));
}
@fragment fn fs(in: Vertex) -> @location(0) vec4f {
  return vec4f(forward_fog(frame(),vec3f(0,0,-10),in.fog,vec3f(0),1),1);
}`,
    {
      'forgeax_view::common': `#define_import_path forgeax_view::common\n${viewDeclaration}\n${atmosphereFlags}`,
      'forgeax_view::fog': source('fog.wgsl'),
      'forgeax_view::atmosphere': `#define_import_path forgeax_view::atmosphere
#import forgeax_view::common::{View}
struct Air { luminance: vec3f, transmittance: vec3f }
fn view_atmosphere(v: View, p: vec3f) -> Air { return Air(vec3f(0),vec3f(1)); }
fn view_solar_transmittance(v: View, p: vec3f) -> vec3f { return vec3f(1); }
fn view_distant_sky_light(v: View) -> vec3f { return vec3f(0); }`,
    },
    {},
  );
  expect(code).not.toContain('sample_index');
  const module = device.createShaderModule({ code });
  const pipeline = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    multisample: { count: 4, mask: 3 },
  });
  const target = device.createTexture({
    size: [8, 8],
    format: 'rgba8unorm',
    sampleCount: 4,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const resolved = device.createTexture({
    size: [8, 8],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 256 * 8,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView(),
          resolveTarget: resolved.createView(),
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: [1, 1, 1, 1],
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: resolved },
      { buffer: readback, bytesPerRow: 256 },
      [8, 8],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(readback.getMappedRange());
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const pixel = pixels.subarray(y * 256 + x * 4, y * 256 + x * 4 + 4);
        for (const channel of pixel.subarray(0, 3)) expect(channel).toBeGreaterThanOrEqual(140);
        for (const channel of pixel.subarray(0, 3)) expect(channel).toBeLessThanOrEqual(141);
        expect(pixel[3]).toBe(255);
      }
    readback.unmap();
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    target.destroy();
    resolved.destroy();
    readback.destroy();
    device.destroy();
  }
});

type Law = 'exp' | 'exp2' | 'linear';
function transmittance(position: readonly number[], orthographic: boolean, law: Law): number {
  const [x = 0, y = 0, z = 0] = position;
  let opacity: number;
  if (law === 'linear') {
    const t = Math.max(0, Math.min(1, (-z - 2) / 18));
    opacity = 0.8 * t * t * (3 - 2 * t);
  } else if (law === 'exp2') {
    opacity = 0.8 * (1 - Math.exp(-((0.065 * -z) ** 2)));
  } else {
    const distance = orthographic ? -z : Math.hypot(x, y - 2, z);
    const dy = orthographic ? 0 : y - 2;
    const opticalHeight = 0.1 * dy;
    const integral =
      Math.abs(opticalHeight) < 0.001
        ? 1 - opticalHeight / 2 + opticalHeight ** 2 / 6
        : -Math.expm1(-opticalHeight) / opticalHeight;
    const density = 0.065 * Math.exp(-0.1 * (orthographic ? y : 2));
    opacity = 0.8 * (1 - Math.exp(-density * distance * integral));
  }
  return 1 - opacity;
}

function verifyVertexFogPixels(
  actual: Float32Array,
  orthographic: boolean,
  law: 'linear' | 'exp' | 'exp2',
  route: 'legacy' | 'disabled' | 'vertex',
): void {
  const ts = worlds.map((p) => transmittance(p, orthographic, law));
  let approximationGap = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const l1 = (2 * (x + 0.5)) / width / 4;
      const l2 = (2 - (2 * (y + 0.5)) / height) / 4;
      const weights = [1 - l1 - l2, l1 / (orthographic ? 1 : 2), l2 / (orthographic ? 1 : 4)];
      const sum = weights.reduce((a, b) => a + b, 0);
      const position = [0, 1, 2].map(
        (axis) => weights.reduce((a, w, i) => a + w * (worlds[i]?.[axis] ?? 0), 0) / sum,
      );
      const interpolated = weights.reduce((a, w, i) => a + w * (ts[i] ?? 0), 0) / sum;
      const t =
        route === 'legacy'
          ? transmittance(position, orthographic, law)
          : route === 'disabled'
            ? 1
            : interpolated;
      const composition = Math.floor(x / 8);
      const coverage = composition === 2 ? 0.4 : 1;
      const expected =
        route === 'legacy'
          ? [0, 0, 0]
          : color.map(
              (c, i) =>
                (c - (backdrop[i] ?? 0)) * t +
                (backdrop[i] ?? 0) +
                (composition === 3
                  ? 0
                  : (1 - (transmission[i] ?? 0)) * (fogColor[i] ?? 0) * (1 - t) * coverage),
            );
      expected.push(route === 'legacy' ? 1 : t);
      for (let channel = 0; channel < 4; channel++) {
        expect(
          actual[(y * width + x) * 4 + channel],
          `pixel ${x},${y} channel ${channel}`,
        ).toBeCloseTo(expected[channel] ?? 0, 5);
      }
      approximationGap = Math.max(
        approximationGap,
        Math.abs(interpolated - transmittance(position, orthographic, law)),
      );
    }
  // Reject a fragment-integral implementation masquerading as vertex fog.
  if (route === 'vertex') expect(approximationGap).toBeGreaterThan(0.001);
}

it.each([
  [false, 'exp', 'vertex'],
  [true, 'exp', 'vertex'],
  [false, 'exp2', 'vertex'],
  [true, 'exp2', 'vertex'],
  [false, 'linear', 'vertex'],
  [true, 'linear', 'vertex'],
  [false, 'exp', 'legacy'],
  [false, 'exp', 'disabled'],
] as const)('vertex fog projection orthographic=%s law=%s route=%s preserves interpolation and blend transport', async (orthographic, law, route) => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw Error('Native vertex fog acceptance requires a GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  let target: GPUTexture | undefined;
  let readback: GPUBuffer | undefined;
  try {
    const lawLanes =
      law === 'linear' ? '20.0, 2.0, -0.8' : `${law === 'exp2' ? '-' : ''}0.065, 0.1, 0.8`;
    const [density, falloff, opacity] = lawLanes.split(', ');
    const code = await composeShader(
      `
#import forgeax_view::common::{View}
#import forgeax_view::fog::{vertex_height_fog, forward_fog_transmission, translucent_fog_transmission}
fn fog_view() -> View {
  var v: View;
  v.cameraPos = vec3<f32>(0.0, 2.0, 0.0);
  v.temporalProjection.z = ${orthographic ? '1.0' : '0.0'};
  v.worldViewProj = mat4x4<f32>(vec4<f32>(1.0,0.0,0.0,0.0),
    vec4<f32>(0.0,1.0,0.0,0.0), vec4<f32>(0.0,0.0,${orthographic ? '1.0,0.0' : '-1.0,-1.0'}), vec4<f32>(0.0));
  v.fogColorDensity = vec4<f32>(0.25,0.5,0.75,${density});
  v.fogHeightOpacity = vec4<f32>(${falloff},${route === 'disabled' ? '0.0' : opacity},0.0,0.0);
  v.fogSky.y = ${route === 'legacy' ? '0.0' : '1.0'};
  v.fogSky.z = ${0.065 * Math.exp(-0.1 * 2)};
  return v;
}
struct Output { @builtin(position) clip: vec4<f32>, @location(0) transmittance: f32, @location(1) world: vec3<f32> }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Output {
  let ndc = array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));
  let world = array<vec3<f32>,3>(vec3<f32>(-2.0,0.0,-4.0),vec3<f32>(3.0,4.0,-10.0),vec3<f32>(-2.0,8.0,-20.0));
  let weights = array<f32,3>(1.0,${orthographic ? '1.0,1.0' : '2.0,4.0'});
  return Output(vec4<f32>(ndc[i]*weights[i],0.5*weights[i],weights[i]),vertex_height_fog(fog_view(),world[i]),world[i]);
}
@fragment fn fs(in: Output) -> @location(0) vec4<f32> {
  var v = fog_view();
  v.fogHeightOpacity.z = floor(in.clip.x / 8.0);
  let rgb = forward_fog_transmission(v,in.world,in.transmittance,vec3<f32>(1.4,0.3,2.2),0.4,
    vec3<f32>(0.12,0.28,0.09),vec3<f32>(0.2,0.4,0.1));
  ${
    route === 'legacy'
      ? `
  // Test the unchanged per-fragment route with the same hardware-interpolated
  // position; CPU barycentrics are not bit-exact hardware interpolants.
  let reference = translucent_fog_transmission(v,in.world,vec3<f32>(1.4,0.3,2.2),0.4,
    vec3<f32>(0.12,0.28,0.09),vec3<f32>(0.2,0.4,0.1));
  return vec4<f32>(rgb-reference,in.transmittance);`
      : 'return vec4<f32>(rgb,in.transmittance);'
  }
}`,
      {
        'forgeax_view::common': `#define_import_path forgeax_view::common\n${viewDeclaration}\n${atmosphereFlags}`,
        'forgeax_view::fog': source('fog.wgsl'),
        // This owner tests ordinary height fog only. Full atmosphere has its
        // maintained transport owners and is deliberately not evaluated here.
        'forgeax_view::atmosphere': `#define_import_path forgeax_view::atmosphere
#import forgeax_view::common::{View}
struct Air { luminance: vec3<f32>, transmittance: vec3<f32> }
fn view_atmosphere(v: View, p: vec3<f32>) -> Air { return Air(vec3<f32>(0.0),vec3<f32>(1.0)); }
fn view_solar_transmittance(v: View, p: vec3<f32>) -> vec3<f32> { return vec3<f32>(1.0); }
fn view_distant_sky_light(v: View) -> vec3<f32> { return vec3<f32>(0.0); }`,
      },
      {},
    );
    const module = device.createShaderModule({ code });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] },
    });
    target = device.createTexture({
      size: [width, height],
      format: 'rgba32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const bytesPerRow = width * 16;
    readback = device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow }, [
      width,
      height,
    ]);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.getMappedRange());
    verifyVertexFogPixels(actual, orthographic, law, route);
    expect(errors).toEqual([]);
    readback.unmap();
  } finally {
    readback?.destroy();
    target?.destroy();
    device.destroy();
  }
});
