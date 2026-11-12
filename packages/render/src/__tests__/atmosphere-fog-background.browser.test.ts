/// <reference types="@webgpu/types" />
import { vec3 } from '@forgeax/engine-math';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';
import backgroundModule from '../../../shader/src/atmosphere-background.wgsl?raw';
import composeModule from '../../../shader/src/atmosphere-compose.wgsl?raw';
import coordinates from '../../../shader/src/atmosphere-coordinates.wgsl?raw';
import optics from '../../../shader/src/atmosphere-optics.wgsl?raw';
import sampling from '../../../shader/src/atmosphere-sampling.wgsl?raw';
import tableAccess from '../../../shader/src/atmosphere-table-access.wgsl?raw';
import visibility from '../../../shader/src/atmosphere-visibility.wgsl?raw';
import cloud from '../../../shader/src/cloud.wgsl?raw';
import common from '../../../shader/src/common.wgsl?raw';
import fogModule from '../../../shader/src/fog.wgsl?raw';
import shadowPcf from '../../../shader/src/shadow-pcf.wgsl?raw';
import type { AtmosphereParameters, FogFrame } from '../extract/environment';
import { writeViewUbo } from '../record/view-ubo';
import type { CameraSnapshot } from '../render-contract';
import { earthAtmosphere } from './atmosphere-fixture';

// The shipped atmosphere composition and background programs, composed from
// their production modules and rendered on the GPU with constant tables:
// - Fog over Atmosphere fogs background pixels as distant fog at the
//   atmosphere exit and still tints finite surfaces;
// - Fog.skyOpacity scales only the background: 0 is bit-equal to fog off on
//   the sky, 1 is the physical distant fog, surfaces are identical for both;
// - the background below the horizon shows the virtual ground lit by the sun.

const SIZE = 8;
const SKY: readonly [number, number, number, number] = [0.3, 0.5, 0.9, 1];
const DEFINES = {
  STORAGE_BUFFER_AVAILABLE: true,
  EXTENDED_LIGHTING_AVAILABLE: false,
  PER_INSTANCE_REGION: false,
  ATMOSPHERE_UTILITY_SHADOWS: true,
};
const SUN_DIRECTION = vec3.normalize(vec3.create(), vec3.create(-0.3, -0.9, -0.3));

function camera(pitch: number): CameraSnapshot {
  // Camera 2 m above the atmosphere ground origin, looking along -z, pitched about x.
  const c = Math.cos(pitch);
  const s = Math.sin(pitch);
  const world = new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 2, 0, 1]);
  return {
    entityKey: 1,
    worldId: 0,
    historyVersion: 0,
    position: vec3.create(0, 2, 0),
    world,
    fov: Math.PI / 3,
    aspect: 1,
    near: 0.1,
    far: 1000,
    projection: 'perspective',
    orthoLeft: -1,
    orthoRight: 1,
    orthoBottom: -1,
    orthoTop: 1,
    tonemap: 'none',
    exposure: 1,
    whitePoint: 4,
    antialias: 'none',
    bloom: 'off',
    bloomThreshold: 1,
    bloomIntensity: 1,
    bloomSmoothWidth: 0.01,
    bloomRadius: 0,
    clearColor: [0, 0, 0, 1],
  };
}

function viewPayload(
  fog: FogFrame | undefined,
  atmosphere: AtmosphereParameters,
  pitch = 0,
): Float32Array {
  let payload = new Float32Array();
  const queue = {
    writeBuffer: (_buffer: Buffer, offset: number, data: Float32Array) => {
      if (offset === 0 && payload.length === 0) payload = data.slice();
      return { ok: true, value: undefined } as const;
    },
  } as unknown as RhiQueue;
  const light = {
    kind: 'directional',
    direction: SUN_DIRECTION,
    color: vec3.create(1, 1, 1),
    intensity: 1,
    contactShadowLength: 0,
  } as never;
  const lights = { point: [], spot: [] } as never;
  writeViewUbo(
    queue,
    {} as Buffer,
    camera(pitch),
    light,
    lights,
    [],
    0,
    undefined,
    undefined,
    fog,
    atmosphere,
  );
  return payload;
}

const FOG: FogFrame = {
  entityKey: 1,
  color: [0.85, 0.78, 0.74],
  density: 0.02,
  heightFalloff: 0,
  maxOpacity: 0.55,
  mode: 'exp',
  near: 0,
  far: 100,
  skyOpacity: 1,
};

// rgba16float is filterable and blendable on every WebGPU device.
const FLOAT_VIEW = new Float32Array(1);
const BITS_VIEW = new Uint32Array(FLOAT_VIEW.buffer);
function toHalf(value: number): number {
  FLOAT_VIEW[0] = value;
  const bits = BITS_VIEW[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  if (exponent <= 0) return sign;
  if (exponent >= 31) return sign | 0x7c00;
  return sign | (exponent << 10) | ((bits >>> 13) & 0x3ff);
}
function fromHalf(half: number): number {
  const exponent = (half >>> 10) & 0x1f;
  const fraction = half & 0x3ff;
  const sign = half & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

async function compose(entry: string): Promise<string> {
  // The fog law tail that samples View-bound atmosphere tables is not imported
  // by either program under test.
  const fog = fogModule
    .slice(0, fogModule.indexOf('fn height_fog(v:View'))
    .replace(/#import forgeax_view::atmosphere::[^\n]*\n/, '');
  return composeShader(
    entry,
    {
      // Dependency order: each module follows the modules it imports.
      'forgeax_view::common': common,
      'forgeax_view::fog': fog,
      // Named by the visibility module's non-utility branch; unused here.
      'forgeax_cloud::layer': cloud,
      'forgeax_pbr::shadow_pcf': shadowPcf,
      'forgeax_atmosphere::visibility': visibility,
      'forgeax_atmosphere::table_access': tableAccess,
      'forgeax_atmosphere::optics': optics,
      'forgeax_atmosphere::coordinates': coordinates,
      'forgeax_atmosphere::sampling': sampling,
    },
    DEFINES,
  );
}

function constantTexture(
  device: GPUDevice,
  value: readonly number[],
  size: [number, number, number] = [4, 4, 1],
  dimension: GPUTextureDimension = '2d',
): GPUTexture {
  const texture = device.createTexture({
    size,
    dimension,
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const count = size[0] * size[1] * size[2];
  const data = new Uint16Array(count * 4);
  for (let i = 0; i < count; i++) data.set(value.map(toHalf), i * 4);
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: size[0] * 8, rowsPerImage: size[1] },
    size,
  );
  return texture;
}

/** Group 1 of a program composed with ATMOSPHERE_UTILITY_SHADOWS: unshadowed air. */
function visibilityGroup(device: GPUDevice, pipeline: GPURenderPipeline, view: GPUBuffer) {
  const shadow = device.createTexture({
    size: [1, 1, 1],
    format: 'depth32float',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(1),
    entries: [
      { binding: 0, resource: shadow.createView({ dimension: '2d-array' }) },
      { binding: 1, resource: device.createSampler({ compare: 'greater-equal' }) },
      { binding: 2, resource: constantTexture(device, [1, 1, 1, 1]).createView() },
      { binding: 3, resource: device.createSampler() },
      { binding: 4, resource: { buffer: view } },
    ],
  });
}

async function readTarget(device: GPUDevice, target: GPUTexture): Promise<Float32Array> {
  const bytesPerRow = 256;
  const readback = device.createBuffer({
    size: bytesPerRow * SIZE,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow }, [SIZE, SIZE]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const rows = new Uint16Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  const pixels = new Float32Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++)
    for (let i = 0; i < SIZE * 4; i++)
      pixels[y * SIZE * 4 + i] = fromHalf(rows[(y * bytesPerRow) / 2 + i] ?? 0);
  return pixels;
}

const DEPTH_FILL = `
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{
  // Lower half of the target: one finite surface about 100 m away (reverse-Z).
  let p=array<vec2<f32>,6>(vec2(-1.0,-1.0),vec2(1.0,-1.0),vec2(1.0,0.0),vec2(-1.0,-1.0),vec2(1.0,0.0),vec2(-1.0,0.0))[i];
  return vec4<f32>(p,0.001,1.0);
}`;

async function composeFrame(
  device: GPUDevice,
  code: string,
  payload: Float32Array,
): Promise<Float32Array> {
  const view = device.createBuffer({
    size: payload.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(view, 0, payload);
  const depth = device.createTexture({
    size: [SIZE, SIZE],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const color = device.createTexture({
    size: [SIZE, SIZE],
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const encoder = device.createCommandEncoder();
  const fill = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: device.createShaderModule({ code: DEPTH_FILL }), entryPoint: 'vs' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    primitive: { topology: 'triangle-list' },
  });
  const depthPass = encoder.beginRenderPass({
    colorAttachments: [],
    depthStencilAttachment: {
      view: depth.createView(),
      depthClearValue: 0,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    },
  });
  depthPass.setPipeline(fill);
  depthPass.draw(6);
  depthPass.end();

  const module = device.createShaderModule({ code });
  const tables = [
    constantTexture(device, [1, 1, 1, 1]), // transmittance
    constantTexture(device, [0.02, 0.02, 0.02, 1]), // multiple scattering
    constantTexture(device, [0.01, 0.02, 0.04, 1], [4, 4, 4], '3d'), // AP luminance
    constantTexture(device, [0.9, 0.9, 0.9, 1], [4, 4, 4], '3d'), // AP transmittance
    constantTexture(device, [0.1, 0.12, 0.15, 1]), // distant sky light
  ];
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      { view: color.createView(), clearValue: [...SKY], loadOp: 'clear', storeOp: 'store' },
    ],
  });
  // Same two-draw RGB attenuation the renderer records (environment/compose.ts).
  for (const stage of ['extinction', 'inscatter'] as const) {
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'atmosphere_compose_vs' },
      fragment: {
        module,
        entryPoint: `atmosphere_${stage}_fs`,
        targets: [
          {
            format: 'rgba16float',
            blend: {
              color: {
                operation: 'add',
                srcFactor: stage === 'extinction' ? 'zero' : 'one',
                dstFactor: stage === 'extinction' ? 'src' : 'one',
              },
              alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: view } },
          { binding: 1, resource: depth.createView() },
          ...tables.map((texture, i) => ({ binding: i + 2, resource: texture.createView() })),
          { binding: 7, resource: device.createSampler() },
        ],
      }),
    );
    pass.setBindGroup(1, visibilityGroup(device, pipeline, view));
    pass.draw(3);
  }
  pass.end();
  device.queue.submit([encoder.finish()]);
  return readTarget(device, color);
}

async function backgroundFrame(
  device: GPUDevice,
  code: string,
  payload: Float32Array,
): Promise<Float32Array> {
  const view = device.createBuffer({
    size: payload.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(view, 0, payload);
  const color = device.createTexture({
    size: [SIZE, SIZE],
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const module = device.createShaderModule({ code });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'atmosphere_background_vs' },
    fragment: {
      module,
      entryPoint: 'atmosphere_background_fs',
      targets: [{ format: 'rgba16float' }],
    },
    primitive: { topology: 'triangle-list' },
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      { view: color.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: constantTexture(device, [0, 0, 0, 1]).createView() }, // sky view: no air light
        { binding: 1, resource: device.createSampler() },
        { binding: 2, resource: { buffer: view } },
        { binding: 3, resource: constantTexture(device, [1, 1, 1, 1]).createView() }, // clear air
        { binding: 4, resource: constantTexture(device, [0, 0, 0, 1]).createView() },
      ],
    }),
  );
  pass.setBindGroup(1, visibilityGroup(device, pipeline, view));
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  return readTarget(device, color);
}

async function gpu(): Promise<GPUDevice> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (adapter === null || adapter === undefined) throw new Error('atmosphere programs need WebGPU');
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (event) => {
    throw new Error((event as GPUUncapturedErrorEvent).error.message);
  });
  return device;
}

const rgb = (pixels: Float32Array, x: number, y: number) =>
  Array.from(pixels.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3));

const distance = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(...a.map((value, i) => value - (b[i] ?? 0)));

it('Fog over Atmosphere fogs background pixels at the atmosphere exit and tints finite surfaces', async () => {
  const device = await gpu();
  try {
    const code = await compose(composeModule);
    const module = device.createShaderModule({ code });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const clear = await composeFrame(device, code, viewPayload(undefined, earthAtmosphere));
    const fogged = await composeFrame(device, code, viewPayload(FOG, earthAtmosphere));
    expect(Array.from(fogged).every(Number.isFinite)).toBe(true);
    // Fog source: color + distant sky light * sun luminance + in-scattered sun
    // (constant tables: distant (0.1, 0.12, 0.15), clear transmittance, white sun).
    const source = FOG.color.map((c, i) => c + ([0.1, 0.12, 0.15][i] ?? 0) + 1 / (4 * Math.PI));
    for (let y = 0; y < SIZE / 2; y++)
      for (let x = 0; x < SIZE; x++) {
        // Upper half has depth 0: the background moves toward the fog source.
        for (const [i, value] of SKY.slice(0, 3).entries())
          expect(rgb(clear, x, y)[i], `background ${x},${y}`).toBeCloseTo(value, 3);
        expect(distance(rgb(fogged, x, y), source), `background ${x},${y}`).toBeLessThan(
          distance(rgb(clear, x, y), source) - 0.05,
        );
      }
    for (let y = SIZE / 2; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const surfaceClear = rgb(clear, x, y);
        const surfaceFogged = rgb(fogged, x, y);
        const delta = Math.max(
          ...surfaceClear.map((v, i) => Math.abs(v - (surfaceFogged[i] ?? 0))),
        );
        expect(delta, `surface ${x},${y}`).toBeGreaterThan(0.05);
      }
  } finally {
    device.destroy();
  }
});

it('Fog.skyOpacity scales fog on background pixels only', async () => {
  const device = await gpu();
  try {
    const code = await compose(composeModule);
    const clear = await composeFrame(device, code, viewPayload(undefined, earthAtmosphere));
    const physical = await composeFrame(
      device,
      code,
      viewPayload({ ...FOG, skyOpacity: 1 }, earthAtmosphere),
    );
    const half = await composeFrame(
      device,
      code,
      viewPayload({ ...FOG, skyOpacity: 0.5 }, earthAtmosphere),
    );
    const unfogged = await composeFrame(
      device,
      code,
      viewPayload({ ...FOG, skyOpacity: 0 }, earthAtmosphere),
    );
    const source = FOG.color.map((c, i) => c + ([0.1, 0.12, 0.15][i] ?? 0) + 1 / (4 * Math.PI));
    for (let y = 0; y < SIZE / 2; y++)
      for (let x = 0; x < SIZE; x++) {
        // skyOpacity 0: the sky is bit-equal to the fog-off frame.
        expect(rgb(unfogged, x, y), `background ${x},${y}`).toEqual(rgb(clear, x, y));
        // skyOpacity 1: the sky differs and moves toward the fog source.
        expect(distance(rgb(physical, x, y), source), `background ${x},${y}`).toBeLessThan(
          distance(rgb(clear, x, y), source) - 0.05,
        );
        // Intermediate values lie strictly between the two.
        const toPhysical = distance(rgb(half, x, y), rgb(physical, x, y));
        const toClear = distance(rgb(half, x, y), rgb(clear, x, y));
        expect(toPhysical, `background ${x},${y}`).toBeGreaterThan(0.01);
        expect(toClear, `background ${x},${y}`).toBeGreaterThan(0.01);
      }
    for (let y = SIZE / 2; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        // Finite surfaces are fogged identically for every skyOpacity.
        expect(rgb(unfogged, x, y), `surface ${x},${y}`).toEqual(rgb(physical, x, y));
        expect(rgb(half, x, y), `surface ${x},${y}`).toEqual(rgb(physical, x, y));
        expect(distance(rgb(physical, x, y), rgb(clear, x, y))).toBeGreaterThan(0.05);
      }
  } finally {
    device.destroy();
  }
});

it('lights the virtual ground below the horizon with the atmosphere ground albedo', async () => {
  const device = await gpu();
  try {
    const code = await compose(backgroundModule);
    const frame = (albedo: [number, number, number]) =>
      backgroundFrame(
        device,
        code,
        // No solar disc; the camera looks 10 degrees down so most rays end on the ground.
        viewPayload(
          undefined,
          { ...earthAtmosphere, groundAlbedo: albedo, sunAngularRadius: 0 },
          (-10 * Math.PI) / 180,
        ),
      );
    const grey = await frame([0.4, 0.4, 0.4]);
    const tinted = await frame([0.1, 0.2, 0.4]);
    // With clear air and a black sky table, a ground ray carries exactly
    // albedo * sun * cos(sun zenith) / pi.
    const cosine = -(SUN_DIRECTION[1] ?? 0);
    const bottom = SIZE - 1;
    for (let x = 0; x < SIZE; x++) {
      const g = rgb(grey, x, bottom);
      const t = rgb(tinted, x, bottom);
      for (const [i, albedo] of [0.4, 0.4, 0.4].entries())
        expect(g[i], `grey ${x} channel ${i}`).toBeCloseTo((albedo * cosine) / Math.PI, 3);
      for (const [i, albedo] of [0.1, 0.2, 0.4].entries())
        expect(t[i], `tinted ${x} channel ${i}`).toBeCloseTo((albedo * cosine) / Math.PI, 3);
      // Rays above the horizon are untouched by the ground term.
      expect(rgb(grey, x, 0)).toEqual([0, 0, 0]);
    }
  } finally {
    device.destroy();
  }
});
