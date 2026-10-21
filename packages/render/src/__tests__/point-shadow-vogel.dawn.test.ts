import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';

it('Point PCF uses the Three five-sample spherical footprint across cube faces and widths', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Native GPU adapter required');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  const depth = device.createTexture({ size: [32, 32, 6], format: 'depth32float', usage: 0x14 });
  const output = device.createBuffer({ size: 192 * 16, usage: 0x84 });
  const readback = device.createBuffer({ size: 192 * 16, usage: 0x09 });
  try {
    const seed = device.createShaderModule({
      code: `
      @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position)vec4f {
        let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1);
      }
      @fragment fn fs(@builtin(position) p:vec4f)->@builtin(frag_depth)f32 {
        return select(0.25,0.75,(u32(p.x)+u32(p.y))%3u==0u);
      }`,
    });
    const seedPipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: seed, entryPoint: 'vs' },
      fragment: { module: seed, entryPoint: 'fs', targets: [] },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    });
    const shared = readFileSync(
      new URL('../../../shader/src/shadow-pcf.wgsl', import.meta.url),
      'utf8',
    ).replace(/^#define_import_path.*$/gm, '');
    const module = device.createShaderModule({
      code: await composeShader(
        `${shared}
      @group(0) @binding(0) var map:texture_depth_cube_array;
      @group(0) @binding(1) var compare:sampler_comparison;
      @group(0) @binding(2) var<storage,read_write> result:array<vec4f>;
      @compute @workgroup_size(8) fn main(@builtin(global_invocation_id) id:vec3u) {
        let index=id.x%64u;
        let p=vec2f(f32(index%8u)/3.5-1.0,f32(index/8u)/3.5-1.0);
        let directions=array<vec3f,6>(vec3f(1,p),vec3f(-1,p),vec3f(p.x,1,p.y),vec3f(p.x,-1,p.y),vec3f(p,1),vec3f(p,-1));
        let direction=normalize(directions[index%6u]);
        let pixel=vec2f(f32(index)+0.5,7.5);
        let radius=f32(id.x/64u);
        let actual=sample_shadow_cube_vogel(map,compare,direction,0,0.5,1.0+2.0*radius,pixel);
        // Independent transcription of r184 PointShadowNode / PCFShadowFilter:
        // trigonometric taps rather than the production precomputed table.
        let up=select(vec3f(1,0,0),vec3f(0,1,0),abs(direction.x)>abs(direction.z));
        let tangent=normalize(cross(direction,up));
        let bitangent=cross(direction,tangent);
        let phi=fract(52.9829189*fract(dot(pixel,vec2f(0.06711056,0.00583715))))*6.28318530718;
        var reference=0.0;
        for(var i=0u;i<5u;i++){
          let angle=f32(i)*2.399963229728653+phi;
          let r=sqrt((f32(i)+0.5)/5.0)*radius/32.0;
          reference+=textureSampleCompareLevel(map,compare,direction+(tangent*cos(angle)+bitangent*sin(angle))*r,0,0.5);
        }
        let hard=textureSampleCompareLevel(map,compare,direction,0,0.5);
        result[id.x]=vec4f(actual,reference*0.2,hard,0);
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
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: depth.createView({ dimension: 'cube-array' }) },
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
    for (let face = 0; face < 6; face++) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView({ dimension: '2d', baseArrayLayer: face, arrayLayerCount: 1 }),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
      });
      pass.setPipeline(seedPipeline);
      pass.draw(3);
      pass.end();
    }
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(24);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 192 * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    let filteredChanges = 0,
      widthChanges = 0;
    for (let i = 0; i < 192; i++) {
      expect(Math.abs((values[i * 4] ?? NaN) - (values[i * 4 + 1] ?? NaN))).toBeLessThan(1e-5);
      if (i >= 64 && Math.abs((values[i * 4] ?? 0) - (values[i * 4 + 2] ?? 0)) > 0.01)
        filteredChanges++;
      if (i >= 128 && Math.abs((values[i * 4] ?? 0) - (values[(i - 64) * 4] ?? 0)) > 0.01)
        widthChanges++;
    }
    expect(filteredChanges).toBeGreaterThan(30);
    expect(widthChanges).toBeGreaterThan(15);
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    depth.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
