import { mkdirSync, writeFileSync } from 'node:fs';
import { buildVisibilityDistanceField, createBoxGeometry } from '@forgeax/engine-geometry';
import { encodePng } from '@forgeax/engine-image/png';
import { vec3 } from '@forgeax/engine-math';
import { rebuildCardOwnerIndex } from '../../raytracing/card-owner-index';
import { GLOBAL_SDF_COMPOSE_WGSL, packGlobalSdfComposition } from '../../raytracing/global-sdf';
import {
  irradianceFieldKernelWgsl,
  packIrradianceFieldFrame,
  packIrradianceFieldUniform,
} from '../../raytracing/irradiance-field';
import { screenProbeWorldWgsl } from '../../raytracing/screen-probe-kernels';
import { packScreenProbeFrame, ScreenProbeRayStatus } from '../../raytracing/screen-probe-plan';
import { WORLD_CARD_RADIANCE_WGSL, worldTraversalWgsl } from '../../raytracing/world-traversal';

const QUERY = new Uint8Array(8);
new DataView(QUERY.buffer).setUint32(0, 256, true);
new DataView(QUERY.buffer).setFloat32(4, 1, true);

const DIAGNOSTIC = `
@group(0) @binding(5) var<storage,read> cards:array<Card>;
@group(0) @binding(6) var<storage,read> cardLit:array<vec4f>;
@group(0) @binding(10) var<uniform> settings:vec4u;
@group(0) @binding(11) var albedo:texture_2d<f32>;
@group(0) @binding(12) var normal:texture_2d<f32>;
@group(0) @binding(13) var emission:texture_2d<f32>;
@group(0) @binding(14) var f0:texture_2d<f32>;
@group(0) @binding(15) var cardDepth:texture_depth_2d;
struct InputRay { origin:vec4f,direction:vec4f }
@group(0) @binding(16) var<uniform> inputRay:InputRay;
@group(0) @binding(17) var<storage,read_write> observed:array<vec4f>;
${WORLD_CARD_RADIANCE_WGSL}
@compute @workgroup_size(1) fn observeWorld(){
 let r=Ray(inputRay.origin.xyz,0.0,inputRay.direction.xyz,10.0,vec4u(1u,0u,0u,0u));
 let h=traceWorld(r,256u,1.0);let c=worldCardRadiance(h,0.25,true,r);
 let candidates=worldHitCandidates(h);
 observed[0]=vec4f(f32(h.state.x),h.metrics.x,c.w,f32(candidates.state.y));
 observed[1]=h.position;observed[2]=h.normal;observed[3]=vec4f(c.xyz,1.0);
}`;

function associationFault(code: string): string {
  const needle = 'fn worldHitCandidates(hit: Hit) -> Candidates {';
  if (code.split(needle).length !== 2) throw Error('Unique actual association seam required');
  // Failure injection only: ordinary rows execute the complete production selector.
  return code.replace(
    needle,
    `${needle}
 if(settings.w!=0u){return Candidates(vec4u(1u,settings.w,hit.state.x,1u),vec4u(7u,0xffffffffu,0xffffffffu,0xffffffffu));}`,
  );
}

function triangleNear(
  origin: readonly number[],
  direction: readonly number[],
  positions: Float32Array,
  indices: Uint16Array | Uint32Array,
  transform: readonly number[],
): number {
  // Independent Float64 Moller-Trumbore oracle over the complete authored cube.
  const point = (index: number) =>
    [0, 1, 2].map(
      (axis) =>
        (transform[axis] ?? 0) * (positions[index * 3] ?? 0) +
        (transform[axis + 4] ?? 0) * (positions[index * 3 + 1] ?? 0) +
        (transform[axis + 8] ?? 0) * (positions[index * 3 + 2] ?? 0),
    );
  const sub = (a: readonly number[], b: readonly number[]) => a.map((v, i) => v - (b[i] ?? 0));
  const cross = (a: readonly number[], b: readonly number[]) => [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
  const dot = (a: readonly number[], b: readonly number[]) =>
    a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
  let nearest = Infinity;
  for (let i = 0; i < indices.length; i += 3) {
    const a = point(indices[i] ?? 0),
      e1 = sub(point(indices[i + 1] ?? 0), a),
      e2 = sub(point(indices[i + 2] ?? 0), a);
    const h = cross(direction, e2),
      determinant = dot(e1, h);
    if (Math.abs(determinant) < 1e-12) continue;
    const s = sub(origin, a),
      u = dot(s, h) / determinant,
      q = cross(s, e1),
      v = dot(direction, q) / determinant,
      t = dot(e2, q) / determinant;
    if (u >= 0 && v >= 0 && u + v <= 1 && t >= 0) nearest = Math.min(nearest, t);
  }
  return nearest;
}

async function prepareAuthoredWorld(
  direction: number[],
  buffer: (bytes: Uint8Array, usage?: number) => GPUBuffer,
  device: GPUDevice,
  dispatch: (pipeline: GPUComputePipeline, group: GPUBindGroup, count?: number) => void,
) {
  const d = vec3.create(direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? 0),
    axis = Math.abs(d[0] ?? 0) < 0.8 ? vec3.create(1, 0, 0) : vec3.create(0, 1, 0),
    u = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), axis, d)),
    v = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), d, u)),
    n = vec3.negate(vec3.create(), vec3.normalize(vec3.create(), d));
  const origin = direction.map((value) => Math.fround(-3 * value));
  const transform = [...u, 0, ...v, 0, ...d, 0, 0, 0, 0, 1];
  const geometry = createBoxGeometry(2, 2, 2).unwrap();
  if (!geometry.indices) throw Error('Complete authored indexed cube required');
  const positions = geometry.attributes.position as Float32Array;
  const nearest = triangleNear(origin, direction, positions, geometry.indices, transform);
  const field = (
    await buildVisibilityDistanceField(positions, geometry.indices, {
      voxelSize: 0.05,
      triangleSidedness: new Uint8Array(geometry.indices.length / 3),
    })
  ).unwrap();
  const packed = packGlobalSdfComposition(
    [{ instanceId: 7, geometryId: 1, mask: 255, transform, field }],
    {
      origin: [-4, -4, -4],
      dimensions: [33, 33, 33],
      spacing: 0.25,
      maxDistance: 4,
      coverageDistance: 0.25,
    },
    { sourceEpoch: 1 },
  ).unwrap();
  const world = [
    buffer(packed.data.voxels),
    buffer(packed.data.settings, 64 | 8),
    buffer(packed.data.instances),
    buffer(packed.data.fields),
    buffer(packed.data.bounds),
  ];
  if (!packed.sourceExpected) throw Error('Accepted producer source tuple is required');
  const compose = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ code: GLOBAL_SDF_COMPOSE_WGSL }),
      entryPoint: 'main',
    },
  });
  dispatch(
    compose,
    device.createBindGroup({
      layout: compose.getBindGroupLayout(0),
      entries: [world[2], world[3], world[4], world[1], world[0]].map((value, binding) => ({
        binding,
        resource: { buffer: value as GPUBuffer },
      })),
    }),
    Math.ceil(packed.voxelCount / 64),
  );
  return {
    d,
    u,
    v,
    n,
    origin,
    transform,
    indices: geometry.indices,
    positions,
    nearest,
    field,
    world,
    expectedSource: packed.sourceExpected,
  };
}

function prepareCardAtlases(
  device: GPUDevice,
  textures: GPUTexture[],
  atlas: (pixel: number[]) => GPUTexture,
  n: Float32Array,
) {
  // Octahedral coordinates first divide by the L1 norm.
  const sum = Math.abs(n[0] ?? 0) + Math.abs(n[1] ?? 0) + Math.abs(n[2] ?? 0);
  let ox = (n[0] ?? 0) / sum,
    oy = (n[1] ?? 0) / sum;
  if ((n[2] ?? 0) < 0) {
    const x = ox;
    ox = (1 - Math.abs(oy)) * (x >= 0 ? 1 : -1);
    oy = (1 - Math.abs(x)) * (oy >= 0 ? 1 : -1);
  }
  const albedo = atlas([0, 0, 0, 1]),
    normal = atlas([ox, oy, ox, oy]),
    emission = atlas([0, 0, 0, 0]),
    f0 = atlas([0, 0, 0, 1]);
  const depth = device.createTexture({ size: [2, 2], format: 'depth32float', usage: 4 | 16 });
  textures.push(depth);
  const clear = device.createCommandEncoder();
  clear
    .beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depth.createView(),
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    })
    .end();
  device.queue.submit([clear.finish()]);
  return { albedo, normal, emission, f0, depth };
}

async function prepareConsumerPipelines(
  device: GPUDevice,
  codes: Record<'world' | 'screen' | 'field', string>,
  world: GPUBuffer[],
  input: {
    card: GPUBuffer;
    lit: GPUBuffer;
    screenRays: GPUBuffer;
    fieldRays: GPUBuffer;
    screenProbes: GPUBuffer;
    fieldUniform: GPUBuffer;
    screenFrame: GPUBuffer;
    fieldFrame: GPUBuffer;
    settings: GPUBuffer;
    rayInput: GPUBuffer;
    fieldOrigins: GPUBuffer;
    observed: GPUBuffer;
  },
  atlases: [GPUTexture, GPUTexture, GPUTexture, GPUTexture, GPUTexture],
) {
  const {
    card,
    lit,
    screenRays,
    fieldRays,
    screenProbes,
    fieldUniform,
    screenFrame,
    fieldFrame,
    settings,
    rayInput,
    fieldOrigins,
    observed,
  } = input;
  const [albedo, normal, emission, f0, depth] = atlases;
  const pipelines = {} as Record<
    keyof typeof codes,
    { pipeline: GPUComputePipeline; group: GPUBindGroup }
  >;
  for (const name of ['world', 'screen', 'field'] as const) {
    const reads =
      name === 'world'
        ? [0, 2, 3, 4, 5, 6]
        : name === 'screen'
          ? [0, 2, 3, 4, 5, 6, 8]
          : [0, 2, 3, 4, 5, 6, 16];
    const writes = name === 'world' ? [17] : [7],
      uniforms = name === 'world' ? [1, 9, 10, 16] : name === 'screen' ? [1, 9, 10] : [1, 8, 9, 10];
    const layout = device.createBindGroupLayout({
      entries: [
        ...reads.map((binding) => ({
          binding,
          visibility: 4,
          buffer: { type: 'read-only-storage' as const },
        })),
        ...writes.map((binding) => ({
          binding,
          visibility: 4,
          buffer: { type: 'storage' as const },
        })),
        ...uniforms.map((binding) => ({
          binding,
          visibility: 4,
          buffer: { type: 'uniform' as const },
        })),
        ...[11, 12, 13, 14].map((binding) => ({
          binding,
          visibility: 4,
          texture: { sampleType: 'unfilterable-float' as const },
        })),
        { binding: 15, visibility: 4, texture: { sampleType: 'depth' } },
      ],
    });
    const resources: Record<number, GPUBuffer> = {
      0: world[0] as GPUBuffer,
      1: world[1] as GPUBuffer,
      2: world[2] as GPUBuffer,
      3: world[3] as GPUBuffer,
      4: world[4] as GPUBuffer,
      5: card,
      6: lit,
      7: name === 'screen' ? screenRays : fieldRays,
      8: name === 'screen' ? screenProbes : fieldUniform,
      9: name === 'screen' ? screenFrame : fieldFrame,
      10: settings,
      16: name === 'world' ? rayInput : fieldOrigins,
      17: observed,
    };
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({ code: codes[name] }),
        entryPoint:
          name === 'world'
            ? 'observeWorld'
            : name === 'screen'
              ? 'traceWorldProbes'
              : 'traceProbes',
      },
    });
    const group = device.createBindGroup({
      layout,
      entries: [
        ...[...reads, ...writes, ...uniforms].map((binding) => ({
          binding,
          resource: { buffer: resources[binding] as GPUBuffer },
        })),
        ...[albedo, normal, emission, f0, depth].map((texture, index) => ({
          binding: 11 + index,
          resource: texture.createView(),
        })),
      ],
    });
    pipelines[name] = { pipeline, group };
  }
  return pipelines;
}

function cardRowBytes(
  mode: string,
  d: Float32Array,
  u: Float32Array,
  v: Float32Array,
  n: Float32Array,
) {
  const cardBytes = new Uint8Array(80),
    cf = new Float32Array(cardBytes.buffer),
    cu = new Uint32Array(cardBytes.buffer);
  const shift = mode === 'unmapped-projection' ? 8 : 0;
  cf.set([
    -(d[0] ?? 0) - (u[0] ?? 0) - (v[0] ?? 0) + shift * (u[0] ?? 0),
    -(d[1] ?? 0) - (u[1] ?? 0) - (v[1] ?? 0) + shift * (u[1] ?? 0),
    -(d[2] ?? 0) - (u[2] ?? 0) - (v[2] ?? 0) + shift * (u[2] ?? 0),
    0,
    ...u,
    2,
    ...v,
    2,
    ...n,
    2,
  ]);
  cu.set([mode === 'absent-card' ? 99 : 7, mode === 'stale' ? 0 : 1, 0, 0], 16);
  rebuildCardOwnerIndex(cardBytes, 1);
  return cardBytes;
}

function writeCaseInputs(
  device: GPUDevice,
  input: { card: GPUBuffer; lit: GPUBuffer; settings: GPUBuffer; screenRays: GPUBuffer },
  mode: string,
  pending: number,
  bits: number,
  direction: number[],
  d: Float32Array,
  u: Float32Array,
  v: Float32Array,
  n: Float32Array,
) {
  const { card, lit, settings, screenRays } = input;
  const cardBytes = cardRowBytes(mode, d, u, v, n);
  device.queue.writeBuffer(card, 0, cardBytes);
  const values = new Float32Array(16),
    rgb = mode === 'mapped-color' ? [2, 1, 0.5] : [0, 0, 0];
  for (let i = 0; i < 4; i++) values.set([...rgb, mode === 'unlit' ? 0 : 1], i * 4);
  device.queue.writeBuffer(lit, 0, values);
  const flag =
    bits ||
    (mode === 'missing-candidate'
      ? 1
      : mode === 'overflow-candidate'
        ? 2
        : mode === 'invalid-normal-candidate'
          ? 4
          : 0);
  device.queue.writeBuffer(settings, 0, Uint32Array.from([1, 2, pending, flag]));
  const rayBytes = new Uint8Array(64 * 32),
    rf = new Float32Array(rayBytes.buffer),
    ru = new Uint32Array(rayBytes.buffer);
  for (let i = 0; i < 64; i++) ru[i * 8 + 3] = ScreenProbeRayStatus.culled << 12;
  rf.set(direction, 0);
  ru[3] = (ScreenProbeRayStatus.world << 12) | 512;
  device.queue.writeBuffer(screenRays, 0, rayBytes);
  return flag;
}

function supportComparisonImage(
  rows: readonly {
    expectedSupported: boolean;
    world: number[];
    screen: { state: number };
    field: number[];
  }[],
  out: string,
  stem: string,
) {
  const width = 320,
    height = rows.length * 12,
    image = new Uint8Array(width * height * 4);
  for (const [i, row] of rows.entries()) {
    const states = [
      row.expectedSupported,
      row.world[2] === 1 || row.world[2] === 2,
      row.screen.state === 0,
      row.field[7] === 1 || row.field[7] === 2,
    ];
    for (let y = i * 12; y < (i + 1) * 12; y++)
      for (let x = 0; x < width; x++) {
        const column = Math.floor(x / 64),
          color = column === 4 ? [0, 0, 0] : states[column] ? [115, 209, 151] : [240, 190, 76];
        image.set([...color, 255], (y * width + x) * 4);
      }
  }
  writeFileSync(`${out}/${stem}.png`, encodePng(width, height, image));
}

export async function runCardUnknownSupport(tagControls?: readonly number[]) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error('Actual GPU required');
  const device = await adapter.requestDevice(),
    buffers: GPUBuffer[] = [],
    textures: GPUTexture[] = [],
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const buffer = (bytes: Uint8Array, usage = 128 | 4 | 8) => {
    const value = device.createBuffer({ size: bytes.byteLength, usage, mappedAtCreation: true });
    new Uint8Array(value.getMappedRange()).set(bytes);
    value.unmap();
    buffers.push(value);
    return value;
  };
  const floats = (values: number[], usage?: number) =>
    buffer(new Uint8Array(Float32Array.from(values).buffer), usage);
  const read = async (value: GPUBuffer) => {
    const staging = buffer(new Uint8Array(value.size), 1 | 8),
      encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(value, 0, staging, 0, value.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(1);
    const bytes = new Uint8Array(staging.getMappedRange()).slice();
    staging.unmap();
    return bytes;
  };
  const dispatch = (pipeline: GPUComputePipeline, group: GPUBindGroup, count = 1) => {
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(count);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };
  const atlas = (pixel: number[]) => {
    const value = device.createTexture({ size: [2, 2], format: 'rgba32float', usage: 2 | 4 });
    device.queue.writeTexture(
      { texture: value },
      Float32Array.from([...pixel, ...pixel, ...pixel, ...pixel]),
      { bytesPerRow: 32 },
      [2, 2],
    );
    textures.push(value);
    return value;
  };
  try {
    const fieldCode = irradianceFieldKernelWgsl('global-sdf').traceProbes;
    const directionCode = `${fieldCode}
@compute @workgroup_size(1) fn observeDirection(){probeRays[0]=ProbeRay(vec4f(0),vec4f(probeDirection(0u,0u,0u,1u),0));}`;
    const directionBuffer = buffer(new Uint8Array(32));
    const directionPipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: directionCode }),
        entryPoint: 'observeDirection',
      },
    });
    dispatch(
      directionPipeline,
      device.createBindGroup({
        layout: directionPipeline.getBindGroupLayout(0),
        entries: [{ binding: 7, resource: { buffer: directionBuffer } }],
      }),
    );
    const direction = Array.from(
      new Float32Array((await read(directionBuffer)).buffer).slice(4, 7),
    );
    const {
      d,
      u,
      v,
      n,
      origin,
      transform,
      indices,
      positions,
      nearest,
      field,
      world,
      expectedSource,
    } = await prepareAuthoredWorld(direction, buffer, device, dispatch);
    const card = buffer(new Uint8Array(80)),
      lit = buffer(new Uint8Array(64)),
      settings = buffer(new Uint8Array(16), 64 | 8),
      observed = buffer(new Uint8Array(64));
    const rayInput = floats([...origin, 0, ...direction, 10], 64 | 8);
    const { albedo, normal, emission, f0, depth } = prepareCardAtlases(device, textures, atlas, n);
    const screenRays = buffer(new Uint8Array(64 * 32)),
      screenProbes = floats([...origin, 1, 0, 0, 0, 0]);
    const screenFrame = buffer(
      packScreenProbeFrame({
        worldSource: { traversal: 'global-sdf', expected: expectedSource },
        layout: {
          width: 4,
          height: 4,
          tilesX: 1,
          tilesY: 1,
          uniformCount: 1,
          adaptiveCapacity: 0,
          probeCount: 1,
        },
        downsample: 4,
        frameIndex: 0,
        importance: 'uniform',
        screenSteps: 0,
        thickness: 0.02,
        environment: [0.4, 0.5, 0.6],
        maxDistance: 10,
        shortRangeAo: 0,
        maxFrames: 8,
        sceneHistory: false,
        pixelHistory: false,
        probeHistory: false,
        worldBias: 0,
        cardMargin: 0.25,
        query: QUERY,
        reprojection: undefined,
      }),
      64 | 8,
    );
    const fieldFrame = buffer(
      packIrradianceFieldFrame({
        worldSource: { traversal: 'global-sdf', expected: expectedSource },
        probeBudget: 1,
        raysPerProbe: 1,
        frameIndex: 0,
        tileOffset: 0,
        tileBudget: 1,
        tileCount: 1,
        lightCount: 0,
        atlasWidth: 2,
        cardResolution: 2,
        radiosity: false,
        environment: [0.4, 0.5, 0.6],
        hysteresis: 0,
        maxDistance: 10,
        surfaceBias: 0,
        depthClamp: 10,
        cardMargin: 0.25,
        gather: [0, 0, 0, 0],
        query: QUERY,
        reflections: [0, 0],
      }),
      64 | 8,
    );
    const fieldUniform = buffer(
        packIrradianceFieldUniform(
          {
            origin: [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0],
            spacing: 1,
            dimensions: [1, 1, 1],
            probeCount: 1,
            levels: 1,
          },
          [{ window: [0, 0, 0], min: [0, 0, 0], max: [1, 1, 1] }],
        ),
        64 | 8,
      ),
      fieldOrigins = buffer(new Uint8Array(32)),
      fieldRays = buffer(new Uint8Array(32));
    const placement = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({
          code: irradianceFieldKernelWgsl('global-sdf').placeProbes,
        }),
        entryPoint: 'placeProbes',
      },
    });
    const list = buffer(new Uint8Array(Uint32Array.from([0x80000000]).buffer)),
      meta = buffer(new Uint8Array(16));
    dispatch(
      placement,
      device.createBindGroup({
        layout: placement.getBindGroupLayout(0),
        entries: [list, meta, fieldUniform, fieldFrame, fieldOrigins].map((value, binding) => ({
          binding,
          resource: { buffer: value },
        })),
      }),
    );
    const placed = Array.from(new Float32Array((await read(fieldOrigins)).buffer));
    const codes = {
      world: associationFault(
        worldTraversalWgsl('global-sdf') +
          `
struct ExpectedFrame { payload:array<vec4u,7>, expectedSource:vec4u }
@group(0) @binding(9) var<uniform> expectedWorld:ExpectedFrame;
fn worldSceneExpected()->vec4u{return expectedWorld.expectedSource;}
` +
          DIAGNOSTIC,
      ),
      screen: associationFault(screenProbeWorldWgsl('global-sdf')),
      field: associationFault(fieldCode),
    };
    if (tagControls) {
      // Lower-stage producer fault injection only. Geometry, ray direction,
      // placement and both consumers remain the complete production kernels.
      const needle =
        'fn worldCardRadiance(hit: Hit, projectionMargin: f32, pointSample: bool, ray: Ray) -> vec4f {';
      for (const name of ['world', 'screen', 'field'] as const) {
        if (codes[name].split(needle).length !== 2) throw Error('Unique Card producer required');
        codes[name] = codes[name].replace(
          needle,
          `${needle}\n if(settings.w>=0x10000000u){return vec4f(0,0,0,bitcast<f32>(settings.w));}`,
        );
      }
    }
    const pipelines = await prepareConsumerPipelines(
      device,
      codes,
      world,
      {
        card,
        lit,
        screenRays,
        fieldRays,
        screenProbes,
        fieldUniform,
        screenFrame,
        fieldFrame,
        settings,
        rayInput,
        fieldOrigins,
        observed,
      },
      [albedo, normal, emission, f0, depth],
    );
    const rows = [];
    const ordinaryModes = [
      'mapped-black',
      'mapped-color',
      'unmapped-projection',
      'stale',
      'absent-card',
      'unlit',
      'missing-candidate',
      'overflow-candidate',
      'invalid-normal-candidate',
    ];
    const cases = tagControls
      ? tagControls.map((bits) => ({ pending: 0, mode: `producer-tag-${bits.toString(16)}`, bits }))
      : [0, 1].flatMap((pending) => ordinaryModes.map((mode) => ({ pending, mode, bits: 0 })));
    for (const { pending, mode, bits } of cases) {
      const flag = writeCaseInputs(
        device,
        { card, lit, settings, screenRays },
        mode,
        pending,
        bits,
        direction,
        d,
        u,
        v,
        n,
      );
      for (const name of ['world', 'screen', 'field'] as const)
        dispatch(pipelines[name].pipeline, pipelines[name].group);
      const observedBytes = await read(observed);
      const worldData = Array.from(new Float32Array(observedBytes.buffer)),
        screenBytes = await read(screenRays),
        fieldData = Array.from(new Float32Array((await read(fieldRays)).buffer));
      rows.push({
        mode,
        pending,
        associationFailureInjection: flag,
        cardProducerTagInjection: bits,
        worldTagBits: new DataView(observedBytes.buffer).getUint32(8, true),
        expectedSupported: tagControls
          ? bits === 0x40000000
          : mode === 'mapped-black' || mode === 'mapped-color',
        world: worldData,
        screen: {
          state: (new DataView(screenBytes.buffer).getUint32(12, true) >>> 12) & 7,
          rgb: Array.from(new Float32Array(screenBytes.buffer).slice(4, 7)),
          distance: new DataView(screenBytes.buffer).getFloat32(28, true),
        },
        field: fieldData,
      });
    }
    await device.queue.onSubmittedWorkDone();
    const result = {
      scope: tagControls
        ? 'Real authored cube and production geometry/consumers. Only the lower Card tag producer is fault-injected; no geometry or consumer override. Nonfinite tags retain exact GPU bits because JSON numbers cannot represent NaN/Infinity.'
        : 'Real authored cube, actual production Global/Mesh trace, actual Field direction and placement, production Card/Screen/Field consumers. Only invalid-candidate rows inject an association failure; no geometry or consumer override.',
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      },
      direction,
      origin,
      placed,
      transform,
      authoredTriangleNearest: nearest,
      fieldPolicy: field.policy,
      rows,
      errors,
    };
    const out = process.env.FORGEAX_GI_SCENE_ARTIFACTS;
    const stem = tagControls ? 'card-tag-support' : 'card-unknown-support';
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(`${out}/${stem}.json`, JSON.stringify(result, null, 2));
      for (const [name, code] of Object.entries(codes))
        writeFileSync(`${out}/${tagControls ? 'card-tag' : 'card-unknown'}-${name}.wgsl`, code);
      writeFileSync(
        `${out}/authored-cube-positions.f32`,
        new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength),
      );
      writeFileSync(
        `${out}/authored-cube-indices.bin`,
        new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength),
      );
      supportComparisonImage(rows, out, stem);
    }
    return result;
  } finally {
    for (const value of buffers) value.destroy();
    for (const value of textures) value.destroy();
    device.destroy();
  }
}
