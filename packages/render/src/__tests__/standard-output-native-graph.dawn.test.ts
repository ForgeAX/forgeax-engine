import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { prepareShaderProgramCompiler } from '../../../shader-compiler/src/program-template';
import { buildEngineShaderTemplateManifest } from '../../../vite-plugin-shader/src/index';
import { DeviceScope } from '../device/device-scope';
import {
  addNativeOutputParameters,
  addNativeOutputPass,
} from '../pipeline/standard-output/native-gpu';
import { disposeStandardOutput } from '../pipeline/standard-output/resources';
import type { RenderFrameState } from '../record/frame-snapshot';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../render-pipeline';

it('preserves distinct native view exposures in one submission through Grade and encoded FXAA', async () => {
  const wire = await buildEngineShaderTemplateManifest();
  const row = wire.entries.find((entry) => entry.identifier === 'forgeax::standard-output-v2');
  if (row === undefined) throw Error('Missing published native output recipe');
  const registry = new ShaderRegistry({
    manifestUrl: undefined,
    programCompiler: (await prepareShaderProgramCompiler()).unwrap(),
  });
  registry.installProgramTemplates(wire.library).unwrap();
  const source = registry.resolveProgramTemplate(row.program, row.selection).unwrap()
    .manifestEntry.wgsl;
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await createShaderModule(device, { code: source })).unwrap();
  const scope = DeviceScope.create(1, 'native-output-gpu-test');
  const factory = { createShaderModule: () => ok(module) };
  const views = [0.5, 2, 0.5, 2].map((exposure, index) => ({
    exposure,
    linearSeam: index >= 2,
    color: [0.125, 0.25, 0.375],
    dither: false,
  }));
  // Final-output dither must retain exact black/white endpoints and primaries.
  views.push(
    ...[
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 1],
    ].map((color) => ({
      exposure: 1,
      linearSeam: false,
      color,
      dither: true,
    })),
  );
  const builds = views.map(({ exposure, linearSeam, color, dither }) => {
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const scene = createRenderPipelineTarget(graph, 'scene', {
      format: 'rgba16float',
      size: 'surface',
    }).unwrap();
    const grade = createRenderPipelineTarget(graph, 'grade', {
      format: linearSeam ? 'rgba16float' : 'rgba8unorm',
      size: 'surface',
    }).unwrap();
    const output = createRenderPipelineTarget(graph, 'output', {
      format: 'rgba8unorm',
      size: 'surface',
    }).unwrap();
    graph
      .addRasterPass('scene', {
        accesses: [{ resource: scene.view, usage: 'color-attachment' }],
        colorAttachments: [
          {
            view: scene.view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: color[0] ?? NaN, g: color[1] ?? NaN, b: color[2] ?? NaN, a: 1 },
          },
        ],
        encode() {},
      })
      .unwrap();
    const parameters = addNativeOutputParameters(graph, {
      bloomIntensity: 0,
      sharpen: 0,
      dither,
      finishInGrade: false,
      linearGrade: linearSeam,
    }).unwrap();
    addNativeOutputPass(graph, 'grade', scene, grade, parameters, { kind: 'grade' }).unwrap();
    let encoded = grade;
    if (linearSeam) {
      encoded = createRenderPipelineTarget(graph, 'encoded', {
        format: 'rgba8unorm',
        size: 'surface',
      }).unwrap();
      addNativeOutputPass(graph, 'encode', grade, encoded, parameters, { kind: 'encode' }).unwrap();
    }
    addNativeOutputPass(graph, 'final', encoded, output, parameters, {
      kind: 'final',
      fxaa: true,
    }).unwrap();
    const readback = device.createBuffer({ size: 1024, usage: 9 }).unwrap();
    const target = graph
      .importBuffer('readback', { size: 1024, usage: 9 }, () => readback)
      .unwrap();
    graph
      .addCopyPass('readback', {
        accesses: [
          { resource: output.view, usage: 'copy-src' },
          { resource: target, usage: 'copy-dst' },
        ],
        encode: ({ encoder, resources }) =>
          encoder.copyTextureToBuffer(
            { texture: resources.texture(output.texture).unwrap() },
            { buffer: readback, bytesPerRow: 256, rowsPerImage: 4 },
            { width: 4, height: 4, depthOrArrayLayers: 1 },
          ),
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 4, height: 4 } }).unwrap();
    const frameState = {} as RenderFrameState;
    const frame = {
      frameState,
      camera: { exposure, whitePoint: 1, tonemap: 'linear' },
      runtime: {
        device,
        deviceScope: scope,
        immediateShaderModuleFactory: factory,
        lookupPostProcess: () => ({ source }),
      },
    } as unknown as RenderPipelineFrame;
    return { compiled, frame, frameState, readback, exposure, color, dither };
  });
  try {
    // Every queue upload happens before the shared command buffer is submitted.
    const encoder = device.createCommandEncoder().unwrap();
    for (const build of builds) build.compiled.execute({ ...build.frame, encoder }).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    for (const build of builds) {
      const mapped = (await build.readback.mapAsync(1)).unwrap();
      const image = new Uint8Array(mapped.getMappedRange().unwrap()).slice();
      const pixel = image.slice(0, 4);
      mapped.unmap();
      const encode = (v: number) =>
        Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
      build.color.forEach((channel, index) => {
        expect(
          Math.abs((pixel[index] ?? NaN) - encode(channel * build.exposure)),
        ).toBeLessThanOrEqual(build.dither ? 0 : 1);
      });
      expect(pixel[3]).toBe(255);
      if (build.dither) {
        for (let y = 0; y < 4; y++)
          for (let x = 0; x < 4; x++) {
            expect(Array.from(image.slice(y * 256 + x * 4, y * 256 + x * 4 + 4))).toEqual([
              ...build.color.map((value) => value * 255),
              255,
            ]);
          }
      }
    }
    // The same view, targets, Grade and Final pipelines receive alternating camera values.
    // Read a corner after every submission so a retained uniform cannot satisfy the oracle.
    const moving = builds[0];
    if (moving === undefined) throw Error('Missing Grade view');
    let neutral: Uint8Array | undefined;
    for (let i = 0; i < 12; i++) {
      const active = i % 2 === 1;
      const camera = {
        ...moving.frame.camera,
        lensEffects: active
          ? {
              vignetteIntensity: 1,
              vignetteRadius: 0,
              vignetteSoftness: 0.05,
              vignetteColor: [0, 0, 0],
              grainIntensity: 0,
              grainSize: 1,
              chromaticAberration: 0.5 + i / 12,
              chromaticAberrationStartOffset: 0,
            }
          : undefined,
      };
      const commands = device.createCommandEncoder().unwrap();
      moving.compiled.execute({ ...moving.frame, camera, encoder: commands }).unwrap();
      device.queue.submit([commands.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const mapped = (await moving.readback.mapAsync(1)).unwrap();
      const pixel = new Uint8Array(mapped.getMappedRange().unwrap()).slice(0, 4);
      mapped.unmap();
      if (active) expect(Array.from(pixel)).toEqual([0, 0, 0, 255]);
      else if (neutral !== undefined) expect(pixel).toEqual(neutral);
      else {
        neutral = pixel;
        expect(pixel[2]).toBeGreaterThan(40);
      }
    }
  } finally {
    for (const build of builds) {
      (await build.compiled.retire()).unwrap();
      disposeStandardOutput(build.frameState);
      device.destroyBuffer(build.readback).unwrap();
    }
    scope.dispose();
  }
});
