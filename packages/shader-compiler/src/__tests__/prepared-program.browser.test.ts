import {
  findVariantByKey,
  publishShaderProgramTemplates,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import { sha256 } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  prepareShaderCompiler,
  prepareShaderProgramCompiler,
  readMaterialSourceModules,
  rebuildMaterialRasterProgram,
} from '../program.js';

it('composes selected template branches, reflects them and executes both on the browser GPU', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('A native browser GPU adapter is required');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  try {
    const compiler = (await prepareShaderProgramCompiler()).unwrap();

    const source = `#import template::color::red
@group(0) @binding(0) var<storage, read_write> output: array<vec4u>;
@compute @workgroup_size(1) fn main() {
#if TINT == true
  output[0] = red();
#else
  output[0] = vec4u(0u, 255u, 0u, 255u);
#endif
}`;
    const imports = {
      'template::color':
        '#define_import_path template::color\nfn red() -> vec4u { return vec4u(255u, 0u, 0u, 255u); }',
    };
    const library = publishShaderProgramTemplates(
      new Map([
        [
          'test::color',
          {
            schemaVersion: 'shader-program-template/1',
            compilerProfile: compiler.profile,
            source,
            imports,
            axes: ['TINT'],
            options: { computeEntry: 'main' },
          },
        ],
      ]),
    ).unwrap();
    const manifest = {
      schemaVersion: '7.0.0',
      library,
      entries: [
        {
          hash: 'native-program',
          identifier: 'test::color',
          program: 'test::color',
          selection: { TINT: false },
        },
      ],
      materialShaders: [
        {
          identifier: 'test::color',
          sourcePath: 'test::color',
          paramSchema: '[]',
          program: 'test::color',
          selection: { TINT: false },
        },
      ],
    };
    const registry = new ShaderRegistry({
      manifestUrl: '/template-manifest',
      readText: async () => JSON.stringify(manifest),
      programCompiler: compiler,
    });
    (await registry.loadManifest()).unwrap();
    const family = registry.materialShaderManifestEntry('test::color');
    if (family === undefined) throw new Error('Missing template family');
    expect(registry.programTemplateInspection().selections).toBe(0);
    for (const tint of [false, true]) {
      const variant = findVariantByKey(family, tint ? '' : 'TINT=false');
      if (variant === undefined) throw new Error('Missing exact native shader selection');
      const wgsl = variant.composedWgsl;
      const selected = registry.resolveProgramTemplate('test::color', { TINT: tint }).unwrap();
      expect(selected.program.source).toBe(wgsl);
      expect(registry.resolveProgramTemplate('test::color', { TINT: tint }).unwrap()).toBe(
        selected,
      );
      const program = selected.manifestEntry;
      expect(program.reflection?.entryPoints).toEqual([
        expect.objectContaining({ name: 'main', stage: 'compute' }),
      ]);
      const module = device.createShaderModule({ code: program.wgsl });
      expect(
        (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
      ).toEqual([]);
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      });
      const output = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      const readback = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      try {
        const bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: output } }],
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        expect(Array.from(new Uint32Array(readback.getMappedRange()))).toEqual(
          tint ? [255, 0, 0, 255] : [0, 255, 0, 255],
        );
        readback.unmap();
      } finally {
        output.destroy();
        readback.destroy();
      }
    }
    expect(registry.programTemplateInspection()).toMatchObject({
      selections: 2,
      requests: 6,
      cacheHits: 4,
    });
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    device.destroy();
  }
}, 60_000);

it('draws a material recompiled from an Engine module reference and project source', async () => {
  const compiler = (await prepareShaderCompiler()).unwrap();
  const engineModule = 'forgeax_test::material_color';
  const engineSource = `#define_import_path ${engineModule}
fn pixelColor() -> vec4f { return vec4f(1, 0, 0.5, 1); }`;
  const projectModule = 'test::material_color';
  const projectSource = `#define_import_path ${projectModule}
#import ${engineModule}::{pixelColor}
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return pixelColor(); }
`;
  const reference = compiler
    .compile(projectSource, {
      imports: { [engineModule]: engineSource },
      renderEntries: { vertex: 'vs_main', fragment: 'fs_main' },
    })
    .unwrap();
  const sources = readMaterialSourceModules(
    {
      schemaVersion: 'material-source-modules/1',
      modules: [
        { kind: 'engine', module: engineModule, digest: sha256(engineSource) },
        {
          kind: 'project',
          module: projectModule,
          digest: sha256(projectSource),
          source: projectSource,
        },
      ],
    },
    { sources: { [sha256(engineSource)]: engineSource } },
  ).unwrap();
  const rebuilt = rebuildMaterialRasterProgram(
    compiler,
    {
      material: 'material',
      sources,
      table: {
        material: {
          kind: 'material',
          passes: [{ name: 'forward', program: { module: projectModule } }],
        },
      },
    },
    { pass: 'forward', address: 'direct', artifactDigest: `sha256:${sha256(reference.wgsl)}` },
  ).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('A native browser GPU adapter is required');
  const device = await adapter.requestDevice();
  const color = device.createTexture({
    format: 'rgba8unorm',
    size: [1, 1],
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const capture = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const module = device.createShaderModule({ code: rebuilt.wgsl });
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: color.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture: color }, { buffer: capture }, [1, 1]);
    device.queue.submit([encoder.finish()]);
    await capture.mapAsync(GPUMapMode.READ);
    expect(Array.from(new Uint8Array(capture.getMappedRange()).subarray(0, 4))).toEqual([
      255, 0, 128, 255,
    ]);
  } finally {
    capture.destroy();
    color.destroy();
    device.destroy();
  }
});
