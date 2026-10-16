import type { RenderPipeline, RhiDevice } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  readbackTexturePixels,
} from '@forgeax/engine-rhi-debug';
import * as backend from '@forgeax/engine-rhi-webgpu';
import type { MaterialRenderState, Result } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { Materials } from '../materials';
import { buildPipelineForMaterialShader } from '../pipeline-builder';
import { pipelineRenderState } from '../render-system-extract';

function value<T>(result: Result<T, { readonly hint: string }>): T {
  if (!result.ok) throw new Error(result.error.hint);
  return result.value;
}

export const rasterCases = [
  { name: 'default', state: {}, expected: [255, 255, 255, 255] },
  { name: 'red-blue', state: { colorWriteMask: 5 }, expected: [255, 0, 255, 0] },
  { name: 'green-only', state: { colorWriteMask: 2 }, expected: [0, 255, 0, 0] },
  { name: 'alpha-only', state: { colorWriteMask: 8 }, expected: [0, 0, 0, 255] },
  { name: 'occluder', state: { colorWriteMask: 0 }, expected: [0, 0, 0, 0], behind: true },
  {
    name: 'occluder-write-off',
    state: { colorWriteMask: 0, depthWriteEnabled: false },
    expected: [0, 255, 0, 255],
    behind: true,
  },
  { name: 'coplanar-control', state: {}, expected: [255, 0, 0, 255], overlay: true },
  { name: 'coplanar-pull', state: { depthBias: -4 }, expected: [0, 255, 0, 255], overlay: true },
  { name: 'coplanar-push', state: { depthBias: 4 }, expected: [255, 0, 0, 255], overlay: true },
  {
    name: 'slope-pull',
    state: { depthBiasSlopeScale: -1 },
    expected: [0, 255, 0, 255],
    overlay: true,
    slope: true,
  },
  {
    name: 'slope-push',
    state: { depthBiasSlopeScale: 1 },
    expected: [255, 0, 0, 255],
    overlay: true,
    slope: true,
  },
  {
    name: 'slope-gap-unclamped',
    state: { depthBiasSlopeScale: -1 },
    expected: [0, 255, 0, 255],
    overlay: true,
    slope: true,
    overlayDepth: 0.501,
  },
  {
    name: 'slope-gap-clamped',
    state: { depthBiasSlopeScale: -1, depthBiasClamp: -0.0001 },
    expected: [255, 0, 0, 255],
    overlay: true,
    slope: true,
    overlayDepth: 0.501,
  },
  {
    name: 'shadow-push',
    state: { depthBias: 4, colorWriteMask: 0 },
    expected: [0, 255, 0, 255],
    shadow: true,
  },
  {
    name: 'shadow-depth',
    state: { depthBias: -4, colorWriteMask: 0 },
    expected: [0, 0, 0, 0],
    shadow: true,
  },
] satisfies readonly RasterCase[];

interface RasterCase {
  readonly name: string;
  readonly state: MaterialRenderState;
  readonly expected: readonly number[];
  readonly behind?: boolean;
  readonly overlay?: boolean;
  readonly slope?: boolean;
  readonly shadow?: boolean;
  readonly overlayDepth?: number;
}

/** Real material pipeline -> recorded RHI -> fresh-device replay, shared by Browser and Dawn. */
export async function verifyRasterCase(testCase: RasterCase) {
  const recorder = value(attachRecorder(backend));
  const adapter = value(await recorder.backend.rhi.requestAdapter());
  const device = value(await adapter.requestDevice());
  let fresh: RhiDevice | undefined;
  try {
    const capture = recorder.captureFrame();
    value(await recorder.frameBoundary());
    const color = value(
      device.createTexture({
        size: { width: 16, height: 16, depthOrArrayLayers: 1 },
        format: 'rgba8unorm',
        usage: 0x11,
      }),
    );
    const depth = value(
      device.createTexture({
        size: { width: 16, height: 16, depthOrArrayLayers: 1 },
        format: 'depth32float',
        usage: 0x10,
      }),
    );
    const colorView = value(device.createTextureView(color, {}));
    const depthView = value(device.createTextureView(depth, {}));
    const layout = value(device.createPipelineLayout({ bindGroupLayouts: [] }));
    const pipeline = (
      state: MaterialRenderState,
      rgba: readonly number[],
      z: number,
      shadow = false,
    ): RenderPipeline => {
      const material = Materials.unlit([1, 1, 1, 1], {
        renderState: { cullMode: 'none', ...state },
      });
      const pass = material.passes?.find(
        (entry) => entry.name === (shadow ? 'shadow-caster' : 'forward'),
      );
      if (pass === undefined) throw new Error('missing material pass');
      const source = `
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], ${(1 - z).toFixed(4)} - p[i].x * ${testCase.slope ? '0.05' : '0.0'}, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(${rgba.map((n) => n.toFixed(1)).join(', ')}); }`;
      const immediate = recorder.backend.createShaderModuleImmediate;
      if (immediate === undefined) throw new Error('backend lacks immediate shader factory');
      return value(
        buildPipelineForMaterialShader(
          testCase.name,
          { source, paramSchema: [] },
          {
            device,
            pipelineLayout: layout,
            vertexBuffers: [],
            colorFormat: 'rgba8unorm',
            colorFormats: shadow ? [] : ['rgba8unorm'],
            depthFormat: 'depth32float',
            shaderModuleFactory: { createShaderModule: (desc) => immediate(device, desc) },
          },
          pipelineRenderState(pass.renderState as MaterialRenderState),
          undefined,
          'vs_main',
          shadow ? null : 'fs_main',
          undefined,
          shadow ? 'shadow-caster' : 'forward',
        ),
      );
    };
    const first = pipeline(
      testCase.overlay ? {} : testCase.state,
      testCase.overlay ? [1, 0, 0, 1] : [1, 1, 1, 1],
      0.5,
      testCase.shadow,
    );
    const second =
      testCase.behind || testCase.overlay || testCase.shadow
        ? pipeline(
            testCase.overlay ? testCase.state : {},
            [0, 1, 0, 1],
            testCase.behind ? 0.6 : (testCase.overlayDepth ?? 0.5),
          )
        : undefined;
    const encoder = value(device.createCommandEncoder({}));
    const draw = (pipelines: readonly RenderPipeline[], shadow: boolean, clearDepth: boolean) => {
      const pass = encoder.beginRenderPass({
        colorAttachments: shadow
          ? []
          : [
              {
                view: colorView,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 0,
          depthLoadOp: clearDepth ? 'clear' : 'load',
          depthStoreOp: 'store',
        },
      });
      for (const p of pipelines) {
        pass.setPipeline(p);
        pass.draw(3, 1, 0, 0);
      }
      pass.end();
    };
    if (testCase.shadow) {
      draw([first], true, true);
      if (second === undefined) throw new Error('missing shadow receiver');
      draw([second], false, false);
    } else draw(second === undefined ? [first] : [first, second], false, true);
    value(device.queue.submit([value(encoder.finish())]));
    await device.queue.onSubmittedWorkDone();
    value(await recorder.frameBoundary());
    const captured = value(await capture);
    const decoded = value(decodeTape(captured.bytes));
    const model = buildFrameModel(decoded);
    // Both attachments are born in this frame and explicitly cleared before use.
    // They need no retained initial bytes; preserve that diagnostic in the evidence.
    expect(model.unseededResources.map((resource) => resource.format).sort()).toEqual([
      'depth32float',
      'rgba8unorm',
    ]);
    const workIndex = model.works.length - 1;
    const live = await readbackTexturePixels(device, color, 16, 16);
    const center = [...live.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)];
    expect(center, testCase.name).toEqual(testCase.expected);
    fresh = value(await value(await backend.rhi.requestAdapter()).requestDevice());
    const session = value(
      await openReplay(decoded, { device: fresh, createShaderModule: backend.createShaderModule }),
    );
    try {
      const inspection = value(
        await session.inspectWork(workIndex, ['pipeline', 'bindings', 'pixels']),
      );
      expect(inspection.attachment?.bytes).toEqual(live);
      const inspectedWork = testCase.overlay ? workIndex : 0;
      const event = model.works[inspectedWork]?.pipeline.descriptor;
      if (event === null || typeof event !== 'object' || !('desc' in event))
        throw new Error('missing pipeline event');
      const descriptor = event.desc;
      expect(descriptor).toMatchObject({
        depthStencil: {
          ...(testCase.state.depthBiasClamp === undefined
            ? {}
            : { depthBiasClamp: -testCase.state.depthBiasClamp }),
          ...(testCase.state.depthBias === undefined
            ? {}
            : { depthBias: -testCase.state.depthBias }),
          ...(testCase.state.depthBiasSlopeScale === undefined
            ? {}
            : { depthBiasSlopeScale: -testCase.state.depthBiasSlopeScale }),
        },
      });
      if (!testCase.shadow && testCase.state.colorWriteMask !== undefined) {
        expect(descriptor).toMatchObject({
          fragment: { targets: [{ writeMask: testCase.state.colorWriteMask }] },
        });
      }
      return {
        name: testCase.name,
        digest: captured.digest,
        bytes: captured.bytes,
        workIndex: inspectedWork,
        pixelWorkIndex: workIndex,
        eventIndex: model.works[inspectedWork]?.eventIndex,
        center,
        replayMatchesLive: true,
        unseededResources: model.unseededResources,
        initialization: 'color and depth cleared before first draw',
        descriptor,
      };
    } finally {
      value(await session.dispose());
    }
  } finally {
    value(await recorder.dispose());
  }
}
