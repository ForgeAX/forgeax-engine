import { readFileSync } from 'node:fs';
import { mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/compile';
import { createFullscreenPassResources } from '../assembly/webgpu-ready-passes';
import { emptyEngineShaderModules } from '../assembly/webgpu-ready-shaders';
import { addSsaoLinearDepthPass, addSsaoSceneColorPass } from '../pipeline/ssao-scene-color';
import type { CameraSnapshot } from '../render-contract';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTopology,
} from '../render-pipeline';
import { addTypedSsaoPasses } from '../typed-render-graph-primitives';

it('executes native AO depth and composite with distinct per-view parameters in one submission', async () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../../shader/src/${name}`, import.meta.url), 'utf8');
  const source = (
    await compileShader(read('hdrp-ssao.wgsl'), {
      imports: {
        'forgeax_view::common': read('common.wgsl'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer.wgsl'),
      },
    })
  ).unwrap().wgsl;
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await createShaderModule(device, { code: source })).unwrap();
  const perPassResources = createFullscreenPassResources(
    device,
    { createRenderPipeline: (descriptor) => device.createRenderPipeline(descriptor as never) },
    new Map(),
    { ...emptyEngineShaderModules(), ssao: module },
    'rgba8unorm',
    (descriptor) => device.createBuffer(descriptor),
  );
  const config = {
    ambientOcclusion: {
      enabled: true,
      method: 'spiral-ssao' as const,
      application: 'scene-color' as const,
      resolutionScale: 0.5,
    },
  };
  const builds = (
    [
      [0.2, 1],
      [4, 1],
      [1, 1],
      [0.2, 4],
      [4, 4],
      [1, 4],
    ] as const
  ).map(([exposure, sampleCount], index) => {
    const computeAo = index % 3 === 2;
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const scene = createRenderPipelineTarget(graph, 'scene', {
      format: 'rgba16float',
      size: { width: 4, height: 4 },
    }).unwrap();
    const depth = createRenderPipelineTarget(graph, 'depth', {
      format: 'depth32float',
      size: { width: 4, height: 4 },
      sampleCount,
    }).unwrap();
    const ao = createRenderPipelineTarget(graph, 'ao', {
      format: 'r8unorm',
      size: { width: 2, height: 2 },
    }).unwrap();
    graph
      .addRasterPass('scene', {
        accesses: [{ resource: scene.view, usage: 'color-attachment' }],
        colorAttachments: [
          {
            view: scene.view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0.25, g: 0.25, b: 0.25, a: 0.5 },
          },
        ],
        encode() {},
      })
      .unwrap();
    graph
      .addRasterPass('depth', {
        accesses: [{ resource: depth.view, usage: 'depth-stencil-write' }],
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.view,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0.05,
        },
        encode() {},
      })
      .unwrap();
    graph
      .addRasterPass('ao', {
        accesses: [{ resource: ao.view, usage: 'color-attachment' }],
        colorAttachments: [
          {
            view: ao.view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0.25, g: 0, b: 0, a: 1 },
          },
        ],
        encode() {},
      })
      .unwrap();
    const linear = addSsaoLinearDepthPass(graph, depth, { width: 2, height: 2 }).unwrap();
    let visibility = ao;
    if (computeAo) {
      const scalar = (label: string) =>
        createRenderPipelineTarget(graph, label, {
          format: 'r8unorm',
          size: { width: 2, height: 2 },
        }).unwrap();
      const raw = scalar('raw'),
        horizontal = scalar('horizontal'),
        blurred = scalar('blurred');
      addTypedSsaoPasses(graph, { depth, raw, horizontal, blurred, ...linear }).unwrap();
      visibility = blurred;
    }
    const topology = { surface: { width: 4, height: 4 }, config } as RenderPipelineTopology;
    const output = addSsaoSceneColorPass(graph, topology, scene, {
      ao: visibility,
      depth,
      ...linear,
    }).unwrap();
    const readback = device.createBuffer({ size: 256, usage: 9 }).unwrap();
    const target = graph.importBuffer('readback', { size: 256, usage: 9 }, () => readback).unwrap();
    graph
      .addCopyPass('readback', {
        accesses: [
          { resource: output.view, usage: 'copy-src' },
          { resource: target, usage: 'copy-dst' },
        ],
        encode: ({ encoder, resources }) =>
          encoder.copyTextureToBuffer(
            { texture: resources.texture(output.texture).unwrap() },
            { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
            { width: 1, height: 1, depthOrArrayLayers: 1 },
          ),
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 4, height: 4 } }).unwrap();
    const camera: CameraSnapshot = {
      entityKey: 1,
      historyVersion: 0,
      position: vec3.create(),
      world: mat4.identity(mat4.create()),
      fov: Math.PI / 3,
      aspect: 1,
      near: 0.1,
      far: 100,
      projection: 'perspective',
      orthoLeft: -1,
      orthoRight: 1,
      orthoBottom: -1,
      orthoTop: 1,
      tonemap: 'none',
      exposure,
      whitePoint: 1,
      antialias: 'none',
      bloom: 'off',
      bloomThreshold: 1,
      bloomIntensity: 1,
      bloomSmoothWidth: 0.01,
      bloomRadius: 0,
      clearColor: [0, 0, 0, 1],
    };
    const frame = {
      camera,
      frameState: { installedPipelineConfig: config, postProcessBgCache: new WeakMap() },
      pipelineState: { perPassResources },
      runtime: { device },
      bindGroupCounts: { createBindGroup: 0, keys: [] },
    } as unknown as RenderPipelineFrame;
    return { compiled, frame, readback, exposure, visibility: computeAo ? 1 : 64 / 255 };
  });
  try {
    const encoder = device.createCommandEncoder().unwrap();
    for (const b of builds) b.compiled.execute({ ...b.frame, encoder }).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    for (const b of builds) {
      const mapped = (await b.readback.mapAsync(1)).unwrap(),
        pixel = new Uint16Array(mapped.getMappedRange().unwrap());
      const decode = (bits: number | undefined) => {
        if (bits === undefined) throw Error('Missing AO composite channel');
        return (1 + (bits & 1023) / 1024) * 2 ** (((bits >> 10) & 31) - 15);
      };
      const t = Math.max(0, Math.min(1, (0.25 * b.exposure - 0.16) / (0.85 - 0.16))),
        lit = t * t * (3 - 2 * t),
        a = 1 + (b.visibility - 1) * 0.95 * (1 - 0.8 * lit);
      for (let c = 0; c < 3; c++)
        expect(
          Math.abs(decode(pixel[c]) - 0.25 * (a + (1 - a) * ([0, 0.03, 0.07][c] ?? Number.NaN))),
        ).toBeLessThan(0.00025);
      expect(decode(pixel[3])).toBe(0.5);
      mapped.unmap();
    }
  } finally {
    for (const b of builds) {
      (await b.compiled.retire()).unwrap();
      device.destroyBuffer(b.readback).unwrap();
    }
  }
});
