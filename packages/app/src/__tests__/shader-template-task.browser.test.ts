import { createTaskClient, createTaskPool, serveTaskClient } from '@forgeax/engine-platform';
import {
  runtimeTaskKinds,
  taskCompileMaterialSourcePrograms,
  taskShaderProgramCompiler,
} from '@forgeax/engine-runtime/internal/tasks';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { type MaterialTable, sha256 } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { cookMaterialAsset } from '../../../shader-compiler/src/material/cook';
import { buildMaterialSourceCatalog } from '../../../shader-compiler/src/material/source-catalog';
import {
  type MaterialSourceProgramRequest,
  prepareShaderCompiler,
  publishMaterialSourceModules,
} from '../../../shader-compiler/src/program';
import { prepareShaderProgramCompiler } from '../../../shader-compiler/src/program-template';

function openShaderTasks() {
  const posted = vi.fn();
  const pool = createTaskPool({
    kinds: runtimeTaskKinds,
    workers: 1,
    workerFactory(listener) {
      const worker = new Worker(new URL('../execution/task-worker-runtime.ts', import.meta.url), {
        type: 'module',
      });
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => listener.message(event.data);
      worker.onerror = (event) => listener.error(event.message);
      worker.postMessage({ kind: 'task-connect', port: channel.port2 }, [channel.port2]);
      return {
        postMessage(message, transfer) {
          posted(message.t);
          channel.port1.postMessage(message, transfer ?? []);
        },
        terminate() {
          channel.port1.close();
          worker.terminate();
        },
      };
    },
  });
  const dispatcher = new MessageChannel();
  const submit = vi.spyOn(dispatcher.port1, 'postMessage');
  const tasks = createTaskClient(dispatcher.port1);
  const release = serveTaskClient(dispatcher.port2, pool);
  return {
    posted,
    submit,
    tasks,
    dispose() {
      tasks.dispose();
      release();
      pool.dispose();
    },
  };
}

it('compiles one selected program in the production task Worker and reuses it after admission', async () => {
  const { posted, submit, tasks, dispose } = openShaderTasks();
  try {
    const reference = (await prepareShaderProgramCompiler()).unwrap();
    const compiler = taskShaderProgramCompiler(
      {
        profile: reference.profile,
        compile: () => {
          throw new Error('Synchronous compilation');
        },
      },
      tasks,
    );
    const registry = new ShaderRegistry({ manifestUrl: undefined, programCompiler: compiler });
    const template = {
      schemaVersion: 'shader-program-template/1',
      compilerProfile: reference.profile,
      axes: ['RECEIVER_ACTIVE'],
      imports: {},
      source: `@fragment fn fs() -> @location(0) vec4f {
#if RECEIVER_ACTIVE == true
  return vec4f(1.0, 0.0, 0.5, 1.0);
#else
  return vec4f(0.0);
#endif
}`,
    } as const;
    registry.installProgramTemplate('fixture::receiver', template).unwrap();
    expect(submit).not.toHaveBeenCalled();
    expect(posted).not.toHaveBeenCalled();
    const selection = { RECEIVER_ACTIVE: true };
    expect(registry.prepareProgramTemplate('fixture::receiver', selection).unwrap()).toBe(false);
    expect(submit).toHaveBeenCalledOnce();
    expect(registry.prepareProgramTemplate('fixture::receiver', selection).unwrap()).toBe(false);
    (await registry.pendingTemplatePreparations())?.unwrap();
    const selected = registry.resolveProgramTemplate('fixture::receiver', selection).unwrap();
    expect(selected.manifestEntry).toEqual(
      reference.compile(template, selection).unwrap().manifestEntry,
    );
    expect(registry.resolveProgramTemplate('fixture::receiver', selection).unwrap()).toBe(selected);
    expect(posted).toHaveBeenCalledExactlyOnceWith('run');
    expect(registry.programTemplateInspection().selections).toBe(1);
  } finally {
    dispose();
  }
}, 60_000);

it('rebuilds only the published material programs requested from a shared source closure', async () => {
  const { posted, submit, tasks, dispose } = openShaderTasks();
  const engineModule = 'forgeax_test::shared_color';
  const engineSource = `#define_import_path ${engineModule}
fn materialColor() -> vec4f { return vec4f(0.25, 0.5, 0.75, 1); }`;
  const projectModule = 'task_fixture::material';
  const projectSource = `#define_import_path ${projectModule}
#import ${engineModule}::{materialColor}
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return materialColor(); }
`;
  const materials: MaterialTable = {
    root: {
      kind: 'material',
      parameters: [],
      passes: [
        { name: 'forward', program: { module: projectModule } },
        { name: 'unused', program: { module: projectModule } },
      ],
    },
    material: { kind: 'material', parent: 'root' },
  };
  const sources = buildMaterialSourceCatalog({
    engine: [{ path: engineModule, source: engineSource }],
    project: [{ path: projectModule, source: projectSource }],
  }).unwrap();
  try {
    const compiler = (await prepareShaderCompiler()).unwrap();
    const compiled = (
      await cookMaterialAsset(
        { material: 'material', table: materials, sources },
        async (source, options) => compiler.compile(source, options),
      )
    ).unwrap();
    expect(compiled.passes).toHaveLength(2);
    const selected = compiled.passes.find(({ pass }) => pass === 'forward');
    if (selected === undefined) throw new Error('Missing authored Forward material');
    const engine = { sources: { [sha256(engineSource)]: engineSource } };
    const modules = publishMaterialSourceModules(
      sources,
      [projectModule, engineModule],
      engine,
    ).unwrap();
    const request: MaterialSourceProgramRequest = {
      materials,
      modules,
      engine,
      selections: [
        {
          material: 'material',
          pass: selected.pass,
          context: selected.context,
          address: 'direct',
          artifactDigest: `sha256:${sha256(selected.compile.wgsl)}`,
        },
      ],
    };
    expect(
      (await taskCompileMaterialSourcePrograms(tasks, { ...request, selections: [] })).unwrap(),
    ).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
    expect(posted).not.toHaveBeenCalled();
    const programs = (await taskCompileMaterialSourcePrograms(tasks, request)).unwrap();
    expect(posted).toHaveBeenCalledExactlyOnceWith('run');
    expect(programs).toHaveLength(1);
    const rebuilt = programs[0];
    if (rebuilt === undefined) throw new Error('Missing Worker material program');
    const wgsl = new TextDecoder().decode(rebuilt.bytes);
    expect(wgsl).toBe(selected.compile.wgsl);
    expect(rebuilt.reflection).toEqual(selected.compile.reflection);
    expect(rebuilt.bindings).toEqual(selected.compile.bindings);
    expect(rebuilt.uvSetCount).toBe(selected.compile.uvSetCount);

    const original = request.selections[0];
    if (original === undefined) throw new Error('Missing request selection');
    const failed = await taskCompileMaterialSourcePrograms(tasks, {
      ...request,
      selections: [original, { ...original, artifactDigest: `sha256:${'0'.repeat(64)}` }],
    });
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'shader-compile-failed', message: expect.stringContaining('artifact') },
    });
    expect(posted).toHaveBeenCalledTimes(2);

    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) throw new Error('A native browser GPU adapter is required');
    const device = await adapter.requestDevice();
    const target = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const module = device.createShaderModule({ code: wgsl });
      const pipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
      });
      const encoder = device.createCommandEncoder();
      const render = encoder.beginRenderPass({
        colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
      });
      render.setPipeline(pipeline);
      render.draw(3);
      render.end();
      encoder.copyTextureToBuffer(
        { texture: target },
        { buffer: readback, bytesPerRow: 256 },
        [1, 1],
      );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      expect([...new Uint8Array(readback.getMappedRange(), 0, 4)]).toEqual([64, 128, 191, 255]);
      readback.unmap();
    } finally {
      target.destroy();
      readback.destroy();
      device.destroy();
    }
  } finally {
    dispose();
  }
}, 60_000);
