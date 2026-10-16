import { createRayDisplay, createRayPathTracer } from '../../../packages/render/dist/internal.mjs';
import { RenderGraphBuilder } from '../../../packages/render-graph/dist/index.mjs';
import { readbackTexturePixels } from '../../../packages/rhi-debug/dist/index.mjs';
import { readBuffer } from '../scene/render.mjs';
import { createGltfResources } from './resources.mjs';

/** Frozen imported scene; the caller supplies binary loading and owns the backend/recorder. */
export async function renderGltf(
  device,
  compile,
  prepared,
  load,
  options,
  recorder,
  progress = () => {},
) {
  const {
    resolution = 256,
    samples = 32,
    camera = { origin: [-8, 1.6, 0], target: [2, 3, 0], up: [0, 1, 0], verticalFov: 1.05 },
    light = 1,
    exposure = 1,
    graphOwned = true,
  } = options;
  const owned = [],
    tracers = [],
    displays = [],
    outputs = [];
  const resources = await createGltfResources(device, compile, prepared, load, progress);
  const { scene, resolveTexture } = resources;
  let compiled;
  try {
    progress('Preparing full-scene reference');
    for (const bounces of [1, 2]) {
      const tracer = (
        await createRayPathTracer(device, compile, {
          kernel: prepared.kernel,
          scene,
          materials: prepared.materials,
          resolveTexture,
          lights: [
            {
              kind: 'directional',
              direction: new Float32Array([0.45, -1, -0.2]),
              color: new Float32Array([4 * light, 0.95 * 4 * light, 0.85 * 4 * light]),
              intensity: 4 * light,
            },
          ],
          settings: {
            width: resolution,
            height: resolution,
            camera,
            maxBounces: bounces,
            seed: 47,
            environment: [0.4 * light, 0.5 * light, 0.6 * light],
            maxDistance: 120,
          },
        })
      ).unwrap();
      tracers.push(tracer);
      displays.push(
        (
          await createRayDisplay(device, compile, {
            kernel: prepared.displayKernel,
            buffer: tracer.buffers.accumulation,
            resolution,
            mode: 'path',
            exposure,
          })
        ).unwrap(),
      );
      const texture = device
        .createTexture({
          label: `gltf.${bounces}-bounce`,
          size: { width: resolution, height: resolution },
          format: 'rgba8unorm',
          usage: 17,
        })
        .unwrap();
      owned.push(texture);
      outputs.push({ texture, view: device.createTextureView(texture, {}).unwrap() });
    }
    if (graphOwned) {
      const graph = new RenderGraphBuilder();
      const textures = resources.importTextures(graph);
      tracers.forEach((tracer, index) => {
        tracer
          .addSampleToGraph(graph, {
            label: `gltf.${index + 1}-bounce`,
            buffers: new Map(),
            textures,
            reset: false,
          })
          .unwrap();
      });
      compiled = graph
        .compile({ device, surfaceSize: { width: resolution, height: resolution } })
        .unwrap();
    }
    const timing = [];
    const record = async () => {
      const started = performance.now();
      const encoder = device.createCommandEncoder({}).unwrap();
      if (compiled) compiled.execute({ encoder }).unwrap();
      else for (const tracer of tracers) tracer.recordSample(encoder).unwrap();
      const encoded = performance.now();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      timing.push({ encodeMs: encoded - started, serialCompletionMs: performance.now() - started });
    };
    for (let i = 0; i < samples - 1; i++) {
      await record();
      if (i % 4 === 0) progress(`Tracing ${i + 1}/${samples}`);
    }
    progress('Capturing final sample and display');
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await record();
    const e = device.createCommandEncoder({}).unwrap();
    displays.forEach((display, i) => {
      display.record(e, outputs[i].view).unwrap();
    });
    device.queue.submit([e.finish().unwrap()]).unwrap();
    const images = [],
      raw = [];
    for (let i = 0; i < tracers.length; i++) {
      images.push(await readbackTexturePixels(device, outputs[i].texture, resolution, resolution));
      raw.push(
        await readBuffer(device, tracers[i].buffers.accumulation, resolution * resolution * 80),
      );
    }
    (await recorder.frameBoundary()).unwrap();
    const tape = (await pending).unwrap();
    const counts = raw.map((bytes) => {
      const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      let invalid = 0,
        incomplete = 0;
      for (let i = 0; i < resolution * resolution; i++) {
        if (words[i * 20 + 7]) invalid++;
        if (words[i * 20 + 3] !== samples) incomplete++;
      }
      return { invalid, incomplete };
    });
    return {
      images,
      raw,
      tape,
      report: {
        ...prepared.report,
        resolution,
        samples,
        camera,
        light,
        exposure,
        counts,
        graphOwned,
        graph: compiled?.inspect(),
        timing,
        timingScope:
          'one/two-bounce reference samples together; CPU encoding and serial GPU completion, not Renderer frame time; last sample captured',
        scope:
          'complete source, shared Standard materials; exact triangle PT reference, not SDF/probe GI or production Renderer integration',
      },
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    await compiled?.retire();
    displays.forEach((d) => {
      d.dispose();
    });
    tracers.forEach((t) => {
      t.dispose();
    });
    resources.dispose();
    owned.forEach((t) => {
      device.destroyTexture(t);
    });
  }
}
