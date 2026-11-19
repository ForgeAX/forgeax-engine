import {
  findVariantByKey,
  publishShaderProgramTemplates,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { prepareShaderProgramCompiler } from '../program.js';

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
