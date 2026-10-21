import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';

const source = readFileSync(
  new URL('../../../shader/src/lighting-directional.wgsl', import.meta.url),
  'utf8',
);

// Compile the actual receiver and PCF functions against a frozen depth field.
// Expected coverage is analytic, independent of production sampling code.
function shaderFunction(name: string): string {
  const start = source.indexOf(`fn ${name}(`);
  if (start < 0) throw new Error(`missing production function ${name}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated production function ${name}`);
}

it('preserves PCF coverage with receiver-plane depth and real comparison filtering', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  expect(adapter).not.toBeNull();
  if (adapter === null) throw new Error('Native GPU adapter is required');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const depth = device.createTexture({
    size: [8, 8, 3],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const output = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const seed = device.createShaderModule({
      code: `
      override blockerDepth: f32;
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
        let p = array<vec2<f32>, 3>(vec2(-1.0,-1.0),vec2(3.0,-1.0),vec2(-1.0,3.0));
        return vec4(p[i], 0.0, 1.0);
      }
      @fragment fn fs(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 {
        return select(0.0, blockerDepth, u32(p.x) == 3u);
      }`,
    });
    const seedPipelines = await Promise.all(
      [0.41, 0.59, 0.51].map((blockerDepth) =>
        device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module: seed, entryPoint: 'vs' },
          fragment: { module: seed, entryPoint: 'fs', targets: [], constants: { blockerDepth } },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
        }),
      ),
    );
    const receiver = shaderFunction('_sampleShadowForCascade').replace(
      /#ifdef DIRECTIONAL_PCSS_AVAILABLE[\s\S]*?#endif/g,
      '',
    );
    const module = device.createShaderModule({
      code: await composeShader(
        `
      struct View {
        depthBias: f32, normalBias: f32,
        splitPlanes: array<vec4<f32>,4>, directionalShadowFilter: vec4<f32>,
      }
      const view = View(0.0, 1.0, array<vec4<f32>,4>(vec4(1.0,1.0,1.0,0.0),vec4(1.0,1.0,1.0,1.0),vec4(1.0,1.0,1.0,0.0),vec4(1.0)), vec4(2.0));
      const MAX_PCF_HALF = 2;
      @group(0) @binding(0) var shadowMap: texture_depth_2d_array;
      @group(0) @binding(1) var shadowSampler: sampler_comparison;
      @group(0) @binding(2) var<storage,read_write> result: array<vec4<f32>>;
      fn _cascadeLightViewProj(layer: u32) -> mat4x4<f32> {
        return mat4x4<f32>(vec4(1.0,0.0,0.0,0.0),vec4(0.0,1.0,0.0,0.0),vec4(0.0,0.0,1.0,0.0),vec4(0.0,0.0,0.0,1.0));
      }
      ${shaderFunction('_directionalReceiverDepthBias')}
      ${shaderFunction('_directionalReceiverPlaneGradient')}
      ${readFileSync(new URL('../../../shader/src/shadow-pcf.wgsl', import.meta.url), 'utf8').replace(/^#define_import_path.*$/gm, '')}
      ${receiver}
      @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let normals = array<vec3<f32>,4>(vec3(-0.4,0.0,1.0),vec3(0.4,0.0,1.0),vec3(0.0,0.0,1.0),vec3(-0.4,0.0,1.0));
        let p = vec3(select(0.0,-0.6875,id.x==3u),0.0,0.5);
        let n = normalize(normals[id.x]);
        let l = vec3(0.0,0.0,1.0);
        let layer = select(id.x,0u,id.x==3u);
        result[id.x] = vec4(_sampleShadowForCascade(p,layer,n,l,0u,vec2(0.0)), _directionalReceiverPlaneGradient(layer,n,l), 0.0);
      }`,
        {
          'forgeax_view::common': readFileSync(
            new URL('../../../shader/src/common.wgsl', import.meta.url),
            'utf8',
          ),
        },
        { STORAGE_BUFFER_AVAILABLE: true },
      ),
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: depth.createView({ dimension: '2d-array' }) },
        {
          binding: 1,
          resource: device.createSampler({
            compare: 'greater',
            minFilter: 'linear',
            magFilter: 'linear',
          }),
        },
        { binding: 2, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    for (let layer = 0; layer < 3; layer++) {
      const raster = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 }),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
      });
      const seedPipeline = seedPipelines[layer];
      if (seedPipeline === undefined) throw new Error('Missing frozen depth-layer pipeline');
      raster.setPipeline(seedPipeline);
      raster.draw(3);
      raster.end();
    }
    const compute = encoder.beginComputePass();
    compute.setPipeline(pipeline);
    compute.setBindGroup(0, bindings);
    compute.dispatchWorkgroups(4);
    compute.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 64);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const rows = Array.from(new Float32Array(readback.getMappedRange()));
    readback.unmap();
    expect(errors).toEqual([]);
    const coverage = [5 / 6, 5 / 6, 2 / 3, 1];
    const gradients = [0.1, -0.1, 0, 0.1];
    const artifact = process.env.TERRAIN_PCF_GRADIENT_ARTIFACT;
    if (artifact !== undefined) {
      mkdirSync(dirname(artifact), { recursive: true });
      writeFileSync(
        artifact,
        JSON.stringify(
          {
            receiverSourceSha256: createHash('sha256').update(source).digest('hex'),
            rows,
            expectedCoverage: coverage,
            expectedGradients: gradients,
            boundary:
              'Actual production functions, raster-written depth32float and linear greater sampler; analytic coverage tolerance 0.000005.',
          },
          null,
          2,
        ),
      );
    }
    for (const [i, expected] of coverage.entries()) {
      expect(rows[i * 4], `coverage case ${i}: ${JSON.stringify(rows)}`).toBeCloseTo(expected, 5);
      expect(rows[i * 4 + 2]).toBe(0);
    }
    for (const [i, gradient] of gradients.entries()) {
      expect(rows[i * 4 + 1]).toBeCloseTo(gradient, 5);
    }
  } finally {
    depth.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
