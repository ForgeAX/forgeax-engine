import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mat4, vec3 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import { gbufferSource } from './standard-gbuffer.fixture';

// Independent analytic raster inputs and mirror-box oracle reproduce the ordinary
// plane + cube example. No captured GPU handles, pixels or shader outputs are fixtures.
it.each([
  0, 0.07, -0.07,
])('keeps the reflected cube silhouette connected without exterior rays (camera offset %f)', async (offset) => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const source = (name: string) =>
    readFileSync(resolve(`packages/shader/src/${name}.wgsl`), 'utf8');
  const compile = async (name: string, id: string) => {
    const result = await compiler.compileShader(source(name), {
      id,
      imports: {
        'forgeax_view::common': source('common'),
        'forgeax_pbr::gbuffer': gbufferSource,
        'forgeax_depth_pyramid::sample': source('depth-pyramid-sample'),
      },
    });
    if (!result.ok) throw result.error;
    return result.value.wgsl;
  };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  try {
    const size = 512,
      half = size / 2;
    const projection = mat4.create(),
      camera = mat4.create(),
      vp = mat4.create(),
      inverse = mat4.create();
    mat4.perspectiveReverseZ(projection, Math.PI / 3, 1, 0.1, 20);
    mat4.lookAt(
      camera,
      vec3.create(6 + offset, 3, 6 - offset),
      vec3.create(offset, 0, -offset),
      vec3.create(0, 1, 0),
    );
    mat4.multiply(vp, projection, camera);
    mat4.invert(inverse, vp);
    const values = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    values.set(vp);
    values.set([6 + offset, 3, 6 - offset], 24);
    values.set(inverse, 44);
    values.set([0.1, 20, 0, 0], 228);
    values.set([12, 0.2, 0.65, 1], 236);
    const view = device.createBuffer({
      size: VIEW_UNIFORM_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    device.queue.writeBuffer(view, 0, values);
    const sampled = GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT;
    const depth = device.createTexture({
      size: [size, size],
      format: 'depth32float',
      usage: sampled,
    });
    const color = () =>
      device.createTexture({ size: [size, size], format: 'rgba16float', usage: sampled });
    const normal = device.createTexture({ size: [size, size], format: 'r32uint', usage: sampled }),
      radiance = color(),
      fallback = color(),
      temporal = color();
    const pyramid = device.createTexture({
      size: [half, half],
      mipLevelCount: 9,
      format: 'r32float',
      usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_STORAGE_BINDING,
    });
    const traced = device.createTexture({
      size: [half, half],
      format: 'rgba16float',
      usage: GPU_TEXTURE_USAGE_STORAGE_BINDING | GPU_TEXTURE_USAGE_COPY_SRC,
    });
    const reactive = device.createTexture({
      size: [half, half],
      format: 'r32float',
      usage: GPU_TEXTURE_USAGE_STORAGE_BINDING,
    });
    const seed = device.createShaderModule({
      code: `
${gbufferSource.replace(/^#define_import_path.*$/gm, '')}
@group(0) @binding(0) var<uniform> vp: mat4x4<f32>;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32> {
 let p=array<vec2<f32>,3>(vec2<f32>(-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));return vec4<f32>(p[i],0.0,1.0);
}
struct Out { @builtin(frag_depth) depth:f32, @location(0) normal:u32, @location(1) color:vec4<f32>, @location(2) fallback:vec4<f32>, @location(3) temporal:vec4<f32> };
@fragment fn fs(@builtin(position) p:vec4<f32>)->Out {
 let screen=vec2<f32>(p.x/${size}.0*2.0-1.0,1.0-p.y/${size}.0*2.0)/sqrt(3.0);
 let eye=vec3<f32>(${6 + offset},3.0,${6 - offset});
 let d=vec3<f32>(-2.0/3.0,-1.0/3.0,-2.0/3.0)+screen.x*vec3<f32>(sqrt(0.5),0.0,-sqrt(0.5))+screen.y*vec3<f32>(-1.0/sqrt(18.0),sqrt(8.0/9.0),-1.0/sqrt(18.0));
 let lower=min((vec3<f32>(-1.0)-eye)/d,(vec3<f32>(1.0)-eye)/d);
 let upper=max((vec3<f32>(-1.0)-eye)/d,(vec3<f32>(1.0)-eye)/d);
 let enter=max(max(lower.x,lower.y),lower.z);let leave=min(min(upper.x,upper.y),upper.z);
 var t=select(1e6,(-1.0-eye.y)/d.y,d.y<0.0);var n=vec3<f32>(0.0,1.0,0.0);var c=vec3<f32>(0.1,0.2,0.4);var roughness=0.08;
 if (enter>0.0 && enter<leave && enter<t) {
  t=enter;let hit=eye+d*t;let a=abs(hit);n=vec3<f32>(0.0);
  if(a.x>=a.y && a.x>=a.z){n.x=sign(hit.x);}else if(a.y>=a.z){n.y=sign(hit.y);}else{n.z=sign(hit.z);}
  c=vec3<f32>(1.0,0.05,0.02);roughness=0.4;
 }
 let clip=vp*vec4<f32>(eye+d*t,1.0);var out:Out;
 out.depth=clamp(clip.z/clip.w,0.0,1.0);out.normal=encodeStandardNormalRoughness(n,roughness);out.color=vec4<f32>(c,1.0);out.fallback=vec4<f32>(0.1,0.1,0.1,1.0);out.temporal=vec4<f32>(0.0);return out;
}`,
    });
    const seedPipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: seed, entryPoint: 'vs' },
      fragment: {
        module: seed,
        entryPoint: 'fs',
        targets: [
          { format: 'r32uint' },
          ...Array.from({ length: 3 }, () => ({ format: 'rgba16float' as const })),
        ],
      },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    });
    const compute = async (name: string, id: string, entryPoint: string) =>
      device.createComputePipelineAsync({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({ code: await compile(name, id) }),
          entryPoint,
        },
      });
    const seedPyramid = await compute(
      'depth-pyramid-seed',
      'forgeax_depth_pyramid::seed',
      'depth_pyramid_seed',
    );
    const reducePyramid = await compute(
      'depth-pyramid-reduce',
      'forgeax_depth_pyramid::reduce',
      'depth_pyramid_reduce',
    );
    const trace = await compute('ssr-trace', 'forgeax_ssr::trace', 'ssr_trace');
    const encoder = device.createCommandEncoder();
    const raster = encoder.beginRenderPass({
      colorAttachments: [normal, radiance, fallback, temporal].map((t) => ({
        view: t.createView(),
        loadOp: 'clear' as const,
        storeOp: 'store' as const,
        clearValue: [0, 0, 0, 0],
      })),
      depthStencilAttachment: {
        view: depth.createView(),
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    raster.setPipeline(seedPipeline);
    raster.setBindGroup(
      0,
      device.createBindGroup({
        layout: seedPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: view } }],
      }),
    );
    raster.draw(3);
    raster.end();
    const dispatch = (
      pipeline: GPUComputePipeline,
      entries: GPUBindGroupEntry[],
      extent: number,
    ) => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
      );
      pass.dispatchWorkgroups(Math.ceil(extent / 8), Math.ceil(extent / 8));
      pass.end();
    };
    for (let level = 0; level < 9; level++) {
      dispatch(
        level === 0 ? seedPyramid : reducePyramid,
        [
          {
            binding: 0,
            resource:
              level === 0
                ? depth.createView()
                : pyramid.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
          },
          { binding: 1, resource: pyramid.createView({ baseMipLevel: level, mipLevelCount: 1 }) },
          ...(level === 0 ? [{ binding: 2, resource: { buffer: view } }] : []),
        ],
        half >> level,
      );
    }
    dispatch(
      trace,
      [depth, normal, radiance, pyramid, traced]
        .map<GPUBindGroupEntry>((t, binding) => ({ binding, resource: t.createView() }))
        .concat([
          { binding: 5, resource: { buffer: view } },
          { binding: 6, resource: fallback.createView() },
          { binding: 7, resource: temporal.createView() },
          { binding: 8, resource: reactive.createView() },
        ]),
      half,
    );
    const readback = device.createBuffer({
      size: half * half * 8,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    });
    encoder.copyTextureToBuffer({ texture: traced }, { buffer: readback, bytesPerRow: half * 8 }, [
      half,
      half,
    ]);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ);
    const words = new Uint16Array(readback.getMappedRange().slice(0));
    readback.unmap();
    const hits = new Uint8Array(half * half);
    // Mirror-box slab intersections are independent of the GPU march and depth-pyramid.
    for (let y = 0; y < half; y++)
      for (let x = 0; x < half; x++) {
        const sx = (((2 * x + 0.5) / size) * 2 - 1) / Math.sqrt(3),
          sy = (1 - ((2 * y + 0.5) / size) * 2) / Math.sqrt(3);
        const d = [
          -2 / 3 + sx * Math.SQRT1_2 - sy / Math.sqrt(18),
          -1 / 3 + sy * Math.sqrt(8 / 9),
          -2 / 3 - sx * Math.SQRT1_2 - sy / Math.sqrt(18),
        ] as const;
        let enter = -Infinity,
          leave = Infinity;
        const bounds = [
          [-1, 1],
          [-3, -1],
          [-1, 1],
        ] as const;
        const eye = [6 + offset, 3, 6 - offset] as const;
        for (const axis of [0, 1, 2] as const) {
          const [lo, hi] = bounds[axis];
          const a = (lo - eye[axis]) / d[axis],
            b = (hi - eye[axis]) / d[axis];
          enter = Math.max(enter, Math.min(a, b));
          leave = Math.min(leave, Math.max(a, b));
        }
        hits[y * half + x] = Number(enter > 0 && enter < leave);
      }
    let interior = 0,
      misses = 0,
      exteriorHits = 0;
    for (let y = 180; y < half - 1; y++)
      for (let x = 1; x < half - 1; x++) {
        const footprint = [-1, 0, 1].flatMap((dy) =>
          [-1, 0, 1].map((dx) => hits[(y + dy) * half + x + dx] === 1),
        );
        const offset = (y * half + x) * 4;
        const confident = (words[offset + 3] ?? 0) >= 0x3800; // positive half >= 0.5
        if (footprint.every(Boolean)) {
          interior++;
          if (!confident) misses++;
        }
        if (!footprint.some(Boolean) && confident && (words[offset] ?? 0) >= 0x3800) exteriorHits++;
      }
    expect(await device.popErrorScope()).toBeNull();
    expect(interior).toBeGreaterThan(1000);
    expect({ misses, exteriorHits }).toEqual({ misses: 0, exteriorHits: 0 });
  } finally {
    device.destroy();
  }
}, 30_000);
