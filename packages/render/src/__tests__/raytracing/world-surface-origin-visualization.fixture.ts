import { createHash } from 'node:crypto';
import { encodePng } from '@forgeax/engine-image/png';
import type { ExactAuthoredMesh } from './world-silhouette-exact.fixture';

type Point = readonly [number, number, number];
type Bounds = readonly [number, number, number, number];
interface ObservedHit {
  readonly state: readonly number[];
  readonly position: readonly number[];
}
export interface SurfaceOriginVisualizationRecord {
  readonly name: string;
  readonly position: Point;
  readonly direction: Point;
  readonly end: number;
  readonly actualReferenceOrigin: readonly number[];
  readonly actualOrigin: readonly number[];
  readonly reference: ObservedHit;
  readonly shifted: ObservedHit;
}

const WIDTH = 512;
const HEIGHT = 256;
const IDENTITY = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
const OWNER_COLORS = [
  [0.45, 0.45, 0.5, 1],
  [0.15, 0.4, 0.95, 1],
  [0.1, 0.85, 0.3, 1],
  [1, 0.6, 0.1, 1],
] as const;

/** Diagnostic side elevation only; no Engine lighting or World dispatch. */
export const WORLD_SURFACE_ORIGIN_VISUALIZATION_WGSL = `
struct Draw { transform:mat4x4f, bounds:vec4f, color:vec4f }
@group(0) @binding(0) var<uniform> draw:Draw;
@vertex fn visualizeVertex(@location(0) position:vec3f)->@builtin(position) vec4f {
 let p=draw.transform*vec4f(position,1);
 let x=2.0*(p.x-draw.bounds.x)/(draw.bounds.y-draw.bounds.x)-1.0;
 let y=2.0*(p.z-draw.bounds.z)/(draw.bounds.w-draw.bounds.z)-1.0;
 return vec4f(x,y,clamp(0.5-p.y*0.1,0.0,1.0),1);
}
@fragment fn visualizeFragment()->@location(0) vec4f {return draw.color;}
`;

function point(values: readonly number[]): Point {
  if (values.length < 3 || !values.slice(0, 3).every(Number.isFinite))
    throw Error('Three finite actual coordinates required');
  return [values[0] as number, values[1] as number, values[2] as number];
}

function meshBounds(meshes: readonly ExactAuthoredMesh[]): Bounds {
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  if (meshes.length === 0) throw Error('Actual authored meshes required');
  for (const mesh of meshes) {
    const p = mesh.positions,
      m = mesh.transform;
    if (
      p.length === 0 ||
      p.length % 3 !== 0 ||
      mesh.indices.length === 0 ||
      mesh.indices.length % 3 !== 0 ||
      m.length !== 16 ||
      !p.every(Number.isFinite) ||
      !m.every(Number.isFinite) ||
      m[3] !== 0 ||
      m[7] !== 0 ||
      m[11] !== 0 ||
      m[15] !== 1
    )
      throw Error('Complete finite authored affine triangle mesh required');
    if (mesh.indices.some((index) => index >= p.length / 3))
      throw Error('Authored triangle index outside original vertex span');
    for (let i = 0; i < p.length; i += 3) {
      const x =
        (m[0] as number) * (p[i] as number) +
        (m[4] as number) * (p[i + 1] as number) +
        (m[8] as number) * (p[i + 2] as number) +
        (m[12] as number);
      const z =
        (m[2] as number) * (p[i] as number) +
        (m[6] as number) * (p[i + 1] as number) +
        (m[10] as number) * (p[i + 2] as number) +
        (m[14] as number);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  }
  return [minX, maxX, minZ, maxZ];
}

function ray(
  hit: ObservedHit,
  origin: readonly number[],
  record: SurfaceOriginVisualizationRecord,
) {
  const start = point(origin),
    direction = point(record.direction),
    state = hit.state[0];
  if (!Number.isInteger(state) || state === undefined || state < 0 || hit.state.length !== 4)
    throw Error('Complete actual GPU hit state required');
  if (!Number.isFinite(record.end) || record.end < 0 || direction.every((v) => v === 0))
    throw Error('Actual finite query direction and interval required');
  const certified = state === 1;
  const end: Point = certified
    ? point(hit.position)
    : [
        start[0] + direction[0] * record.end,
        start[1] + direction[1] * record.end,
        start[2] + direction[2] * record.end,
      ];
  return {
    start,
    end,
    certified,
    state: Array.from(hit.state),
    endpointKind: certified ? 'GPU-hit' : 'query-limit',
  };
}

/** CPU packing metadata: marker positions never come from expected owners. */
export function surfaceOriginVisualizationPlan(
  meshes: readonly ExactAuthoredMesh[],
  record: SurfaceOriginVisualizationRecord,
) {
  const [minX, maxX, minZ, maxZ] = meshBounds(meshes),
    marginX = Math.max((maxX - minX) * 0.05, 0.03125),
    marginZ = Math.max((maxZ - minZ) * 0.05, 0.03125),
    position = point(record.position);
  return {
    width: WIDTH,
    height: HEIGHT,
    record: record.name,
    scope:
      'Input geometry and actual GPU ray diagnostic; not GI lighting, Renderer or performance acceptance',
    view: 'Orthographic side elevation: world X right, Z up, viewed from positive Y; ray overlays ignore mesh depth',
    markers:
      'Diamond=actual GPU origin; cross=state1 GPU hit only; clear/unknown has no hit marker',
    panels: [
      {
        name: 'scene-overview',
        bounds: [minX - marginX, maxX + marginX, minZ - marginZ, maxZ + marginZ] as Bounds,
      },
      {
        name: 'receiver-blocker-origin-closeup',
        bounds: [
          position[0] - 0.375,
          position[0] + 0.375,
          position[2] - 0.03125,
          position[2] + 0.21875,
        ] as Bounds,
      },
    ],
    rays: [
      {
        name: 'reference',
        color: [0.1, 0.95, 1, 1],
        ...ray(record.reference, record.actualReferenceOrigin, record),
      },
      {
        name: 'shifted',
        color: [1, 0.2, 0.65, 1],
        ...ray(record.shifted, record.actualOrigin, record),
      },
    ],
    meshes: meshes.map((mesh) => ({
      id: mesh.id,
      vertices: mesh.positions.length / 3,
      triangles: mesh.indices.length / 3,
      color: OWNER_COLORS[mesh.id] ?? OWNER_COLORS[0],
      sha256: Object.fromEntries(
        (['positions', 'indices', 'transform'] as const).map((key) => [
          key,
          createHash('sha256')
            .update(new Uint8Array(mesh[key].buffer, mesh[key].byteOffset, mesh[key].byteLength))
            .digest('hex'),
        ]),
      ),
    })),
  };
}

function rayLines(row: ReturnType<typeof ray>, bounds: Bounds) {
  const dx = ((bounds[1] - bounds[0]) * 3) / (WIDTH / 2 - 2),
    dz = ((bounds[3] - bounds[2]) * 3) / (HEIGHT - 2),
    p = row.start,
    q = row.end;
  const diamond = [
    [p[0] - dx, p[1], p[2]],
    [p[0], p[1], p[2] + dz],
    [p[0], p[1], p[2] + dz],
    [p[0] + dx, p[1], p[2]],
    [p[0] + dx, p[1], p[2]],
    [p[0], p[1], p[2] - dz],
    [p[0], p[1], p[2] - dz],
    [p[0] - dx, p[1], p[2]],
  ];
  const cross = row.certified
    ? [
        [q[0] - dx, q[1], q[2] - dz],
        [q[0] + dx, q[1], q[2] + dz],
        [q[0] - dx, q[1], q[2] + dz],
        [q[0] + dx, q[1], q[2] - dz],
      ]
    : [];
  return Float32Array.from([row.start, row.end, ...diamond, ...cross].flat());
}

/** Borrows the already-selected device; only owned offscreen resources retire. */
export async function rasterizeSurfaceOriginVisualization(
  device: GPUDevice,
  meshes: readonly ExactAuthoredMesh[],
  record: SurfaceOriginVisualizationRecord,
) {
  const metadata = surfaceOriginVisualizationPlan(meshes, record),
    buffers: GPUBuffer[] = [],
    textures: GPUTexture[] = [];
  const buffer = (values: Float32Array | Uint32Array, usage: number) => {
    const b = device.createBuffer({ size: values.byteLength, usage, mappedAtCreation: true });
    buffers.push(b);
    new Uint8Array(b.getMappedRange()).set(
      new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
    );
    b.unmap();
    return b;
  };
  device.pushErrorScope('validation');
  let scoped = true;
  try {
    const module = device.createShaderModule({ code: WORLD_SURFACE_ORIGIN_VISUALIZATION_WGSL });
    const messages = (await module.getCompilationInfo()).messages.filter(
      (message) => message.type === 'error',
    );
    if (messages.length) throw Error(messages.map((message) => message.message).join('\n'));
    const layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 1 | 2, buffer: { type: 'uniform' } }],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const descriptor = {
      layout: pipelineLayout,
      vertex: {
        module,
        entryPoint: 'visualizeVertex',
        buffers: [
          {
            arrayStride: 12,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as const }],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'visualizeFragment',
        targets: [{ format: 'rgba8unorm' as const }],
      },
    };
    const solid = await device.createRenderPipelineAsync({
      ...descriptor,
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });
    const overlay = await device.createRenderPipelineAsync({
      ...descriptor,
      primitive: { topology: 'line-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'always' },
    });
    const color = device.createTexture({
      size: [WIDTH, HEIGHT],
      format: 'rgba8unorm',
      usage: 16 | 1,
    });
    textures.push(color);
    const depth = device.createTexture({
      size: [WIDTH, HEIGHT],
      format: 'depth32float',
      usage: 16,
    });
    textures.push(depth);
    const geometry = meshes.map((mesh) => ({
      vertex: buffer(mesh.positions, 32),
      index: buffer(mesh.indices, 16),
      count: mesh.indices.length,
    }));
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: color.createView(),
            clearValue: [0.025, 0.035, 0.06, 1],
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
    const group = (transform: Float32Array, bounds: Bounds, color: readonly number[]) =>
      device.createBindGroup({
        layout,
        entries: [
          {
            binding: 0,
            resource: {
              buffer: buffer(Float32Array.from([...transform, ...bounds, ...color]), 64),
            },
          },
        ],
      });
    for (const [panelIndex, panel] of metadata.panels.entries()) {
      pass.setViewport((panelIndex * WIDTH) / 2 + 1, 1, WIDTH / 2 - 2, HEIGHT - 2, 0, 1);
      pass.setScissorRect((panelIndex * WIDTH) / 2 + 1, 1, WIDTH / 2 - 2, HEIGHT - 2);
      pass.setPipeline(solid);
      for (const [i, mesh] of meshes.entries()) {
        const gpu = geometry[i];
        if (!gpu) throw Error('One GPU mesh per authored source required');
        pass.setBindGroup(
          0,
          group(mesh.transform, panel.bounds, OWNER_COLORS[mesh.id] ?? OWNER_COLORS[0]),
        );
        pass.setVertexBuffer(0, gpu.vertex);
        pass.setIndexBuffer(gpu.index, 'uint32');
        pass.drawIndexed(gpu.count);
      }
      pass.setPipeline(overlay);
      for (const row of metadata.rays) {
        const lines = rayLines(row, panel.bounds);
        pass.setBindGroup(0, group(IDENTITY, panel.bounds, row.color));
        pass.setVertexBuffer(0, buffer(lines, 32));
        pass.draw(lines.length / 3);
      }
    }
    pass.end();
    const staging = device.createBuffer({ size: WIDTH * HEIGHT * 4, usage: 1 | 8 });
    buffers.push(staging);
    encoder.copyTextureToBuffer({ texture: color }, { buffer: staging, bytesPerRow: WIDTH * 4 }, [
      WIDTH,
      HEIGHT,
    ]);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(1);
    let rgba: Uint8Array;
    try {
      rgba = new Uint8Array(staging.getMappedRange()).slice();
    } finally {
      staging.unmap();
    }
    scoped = false;
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return { png: encodePng(WIDTH, HEIGHT, rgba), metadata };
  } finally {
    try {
      if (scoped) await device.popErrorScope();
    } finally {
      for (const b of buffers) {
        if (b.mapState === 'mapped') b.unmap();
        b.destroy();
      }
      for (const texture of textures) texture.destroy();
    }
  }
}
