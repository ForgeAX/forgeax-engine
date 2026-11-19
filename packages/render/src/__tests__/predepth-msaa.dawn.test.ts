import { mkdirSync, writeFileSync } from 'node:fs';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  readbackTexturePixels,
} from '@forgeax/engine-rhi-debug';
import * as backend from '@forgeax/engine-rhi-webgpu';
import type { MaterialRenderState } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { materialDepthStencil, seededDepthRenderState } from '../material-render-state';

it('preserves every masked MSAA edge sample when base shading reuses read-only primary depth', async () => {
  const recorder = attachRecorder(backend).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const immediate = recorder.backend.createShaderModuleImmediate;
  if (immediate === undefined) throw new Error('missing native shader factory');
  const layout = device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap();
  const size = { width: 16, height: 16 };
  const source = `
struct Vertex { @builtin(position) @invariant position: vec4f };
@vertex fn vs_background(@builtin(vertex_index) i: u32) -> Vertex {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return Vertex(vec4f(p * 2.0 - 1.0, 0.25, 1.0));
}
@vertex fn vs_front(@builtin(vertex_index) i: u32) -> Vertex {
  let p = array<vec2f, 3>(vec2f(-0.8,-0.7), vec2f(0.9,-0.7), vec2f(-0.8,0.85));
  return Vertex(vec4f(p[i], 0.75, 1.0));
}
fn reject_coverage(p: vec4f) -> bool { return (u32(p.x) / 3u) % 2u == 0u; }
@fragment fn fs_background() -> @location(0) vec4f { return vec4f(0.0,1.0,0.0,1.0); }
@fragment fn fs_front_masked(in: Vertex) -> @location(0) vec4f {
  if reject_coverage(in.position) { discard; }
  return vec4f(1.0,0.0,0.0,1.0);
}
@fragment fn fs_front() -> @location(0) vec4f { return vec4f(1.0,0.0,0.0,1.0); }
@fragment fn fs_depth_masked(in: Vertex) { if reject_coverage(in.position) { discard; } }
@fragment fn fs_depth() {}
`;
  const module = immediate(device, { code: source }).unwrap();
  const pipeline = (
    vertex: string,
    fragment: string,
    color: boolean,
    state?: MaterialRenderState,
  ) =>
    device
      .createRenderPipeline({
        layout,
        vertex: { module, entryPoint: vertex, buffers: [] },
        fragment: {
          module,
          entryPoint: fragment,
          targets: color ? [{ format: 'rgba8unorm' }] : [],
        },
        primitive: { topology: 'triangle-list' },
        multisample: { count: 4 },
        depthStencil: materialDepthStencil('depth32float', state),
      })
      .unwrap();
  const background = pipeline('vs_background', 'fs_background', true);
  const masked = pipeline('vs_front', 'fs_front_masked', true);
  const backgroundDepth = pipeline('vs_background', 'fs_depth', false);
  const maskedDepth = pipeline('vs_front', 'fs_depth_masked', false);
  const wrongDepth = pipeline('vs_front', 'fs_depth', false);
  const backgroundSeeded = pipeline(
    'vs_background',
    'fs_background',
    true,
    seededDepthRenderState(undefined, false),
  );
  const maskedSeeded = pipeline(
    'vs_front',
    'fs_front',
    true,
    seededDepthRenderState(undefined, true),
  );
  const render = async (mode: 'baseline' | 'seeded' | 'wrong-mask') => {
    const resolved = device.createTexture({ size, format: 'rgba8unorm', usage: 0x11 }).unwrap();
    const color = device
      .createTexture({ size, format: 'rgba8unorm', sampleCount: 4, usage: 0x10 })
      .unwrap();
    const depth = device
      .createTexture({ size, format: 'depth32float', sampleCount: 4, usage: 0x10 })
      .unwrap();
    const depthView = device.createTextureView(depth, {}).unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    if (mode !== 'baseline') {
      const prepass = encoder.beginRenderPass({
        label: 'accurate-four-sample-predepth',
        colorAttachments: [],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      prepass.setPipeline(backgroundDepth);
      prepass.draw(3);
      prepass.setPipeline(mode === 'seeded' ? maskedDepth : wrongDepth);
      prepass.draw(3);
      prepass.end();
    }
    const pass = encoder.beginRenderPass({
      label: mode,
      colorAttachments: [
        {
          view: device.createTextureView(color, {}).unwrap(),
          resolveTarget: device.createTextureView(resolved, {}).unwrap(),
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        ...(mode === 'baseline'
          ? { depthClearValue: 0, depthLoadOp: 'clear' as const, depthStoreOp: 'store' as const }
          : { depthReadOnly: true }),
      },
    });
    pass.setPipeline(mode === 'baseline' ? background : backgroundSeeded);
    pass.draw(3);
    pass.setPipeline(mode === 'baseline' ? masked : maskedSeeded);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    return resolved;
  };
  try {
    const reference = await readbackTexturePixels(device, await render('baseline'), 16, 16);
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const seeded = await render('seeded');
    (await recorder.frameBoundary()).unwrap();
    const captured = (await capture).unwrap();
    const actual = await readbackTexturePixels(device, seeded, 16, 16);
    expect([...actual]).toEqual([...reference]);
    const wrong = await readbackTexturePixels(device, await render('wrong-mask'), 16, 16);
    expect([...wrong]).not.toEqual([...reference]);
    let edgeSamples = 0,
      redPixels = 0,
      greenPixels = 0;
    for (let pixel = 0; pixel < 256; pixel++) {
      const red = actual[pixel * 4] ?? 0;
      if (red > 0 && red < 255) edgeSamples++;
      if (red === 255) redPixels++;
      if (red === 0) greenPixels++;
      expect(actual[pixel * 4 + 3]).toBe(255);
    }
    expect(edgeSamples).toBeGreaterThan(0);
    expect(redPixels).toBeGreaterThan(0);
    expect(greenPixels).toBeGreaterThan(0);
    const model = buildFrameModel(decodeTape(captured.bytes).unwrap());
    const record = (input: unknown): Readonly<Record<string, unknown>> => {
      if (input === null || typeof input !== 'object' || Array.isArray(input))
        throw new Error('missing captured pipeline record');
      return input as Readonly<Record<string, unknown>>;
    };
    const descriptors = model.works.map((work) => record(record(work.pipeline.descriptor).desc));
    expect(descriptors).toHaveLength(4);
    const colorDescriptors = descriptors.filter((descriptor) => {
      const targets = record(descriptor.fragment).targets;
      return Array.isArray(targets) && targets.length === 1;
    });
    expect(colorDescriptors).toHaveLength(2);
    for (const descriptor of colorDescriptors)
      expect(descriptor).toMatchObject({
        multisample: { count: 4 },
        depthStencil: { depthWriteEnabled: false },
      });
    const output = 'artifacts/predepth-msaa';
    mkdirSync(output, { recursive: true });
    writeFileSync(`${output}/masked.rhitape`, captured.bytes);
  } finally {
    (await recorder.dispose()).unwrap();
  }
}, 30_000);
