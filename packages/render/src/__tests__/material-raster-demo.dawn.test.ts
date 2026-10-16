import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { RhiDevice } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  readbackTexturePixels,
} from '@forgeax/engine-rhi-debug';
import * as backend from '@forgeax/engine-rhi-webgpu';
import type { MaterialRenderState, Result } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { Materials } from '../materials';
import { buildPipelineForMaterialShader } from '../pipeline-builder';
import { pipelineRenderState } from '../render-system-extract';

function value<T>(result: Result<T, { readonly hint: string }>): T {
  if (!result.ok) throw new Error(result.error.hint);
  return result.value;
}

const width = 800;
const height = 480;
const output = 'artifacts/material-raster-state';
type Rect = readonly [number, number, number, number];
type Rgb = readonly [number, number, number];

it('captures a four-panel material raster demo from the real GPU', async () => {
  const recorder = value(attachRecorder(backend));
  const adapter = value(await recorder.backend.rhi.requestAdapter());
  const device = value(await adapter.requestDevice());
  let fresh: RhiDevice | undefined;
  try {
    const capture = recorder.captureFrame();
    value(await recorder.frameBoundary());
    const color = value(
      device.createTexture({
        size: { width, height, depthOrArrayLayers: 1 },
        format: 'rgba8unorm',
        usage: 0x11,
      }),
    );
    const depth = value(
      device.createTexture({
        size: { width, height, depthOrArrayLayers: 1 },
        format: 'depth32float',
        usage: 0x10,
      }),
    );
    const colorView = value(device.createTextureView(color, {}));
    const depthView = value(device.createTextureView(depth, {}));
    const layout = value(device.createPipelineLayout({ bindGroupLayouts: [] }));
    const encoder = value(device.createCommandEncoder({}));
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: colorView,
          clearValue: { r: 0.025, g: 0.035, b: 0.06, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    let draws = 0;
    const draw = (rect: Rect, z: number, rgb: Rgb, state: MaterialRenderState = {}) => {
      const [left, top, right, bottom] = rect;
      const x0 = ((2 * left) / width - 1).toFixed(6);
      const x1 = ((2 * right) / width - 1).toFixed(6);
      const y0 = (1 - (2 * top) / height).toFixed(6);
      const y1 = (1 - (2 * bottom) / height).toFixed(6);
      const source = `
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 6>(
    vec2<f32>(${x0}, ${y0}), vec2<f32>(${x1}, ${y0}), vec2<f32>(${x0}, ${y1}),
    vec2<f32>(${x0}, ${y1}), vec2<f32>(${x1}, ${y0}), vec2<f32>(${x1}, ${y1})
  );
  return vec4<f32>(p[i], ${(1 - z).toFixed(6)}, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(${rgb.map((v) => v.toFixed(4)).join(', ')}, 1.0);
}`;
      const material = Materials.unlit([1, 1, 1, 1], {
        renderState: { cullMode: 'none', ...state },
      });
      const forward = material.passes?.find((entry) => entry.name === 'forward');
      if (forward === undefined) throw new Error('missing forward material pass');
      const immediate = recorder.backend.createShaderModuleImmediate;
      if (immediate === undefined) throw new Error('missing immediate shader factory');
      const pipeline = value(
        buildPipelineForMaterialShader(
          `material-raster-demo-${draws}`,
          { source, paramSchema: [] },
          {
            device,
            pipelineLayout: layout,
            vertexBuffers: [],
            colorFormat: 'rgba8unorm',
            colorFormats: ['rgba8unorm'],
            depthFormat: 'depth32float',
            shaderModuleFactory: { createShaderModule: (desc) => immediate(device, desc) },
          },
          pipelineRenderState(forward.renderState as MaterialRenderState),
          undefined,
          'vs_main',
          'fs_main',
          undefined,
          'forward',
        ),
      );
      pass.setPipeline(pipeline);
      pass.draw(6, 1, 0, 0);
      draws++;
    };

    for (const [x, y] of [
      [0, 0],
      [400, 0],
      [0, 240],
      [400, 240],
    ] as const) {
      draw([x + 10, y + 10, x + 390, y + 230], 0.99, [0.19, 0.23, 0.31]);
      draw([x + 14, y + 14, x + 386, y + 226], 0.98, [0.055, 0.09, 0.15]);
    }
    // Upper row: the same distant green card, without and with an invisible occluder.
    draw([70, 70, 330, 176], 0.6, [0.19, 0.81, 0.61]);
    draw([565, 85, 665, 165], 0.4, [1, 1, 1], { colorWriteMask: 0 });
    draw([470, 70, 730, 176], 0.6, [0.19, 0.81, 0.61]);
    // Lower row: equal-depth overlays fail normally and appear when pulled forward.
    draw([70, 310, 330, 416], 0.5, [0.89, 0.27, 0.32]);
    draw([120, 332, 280, 394], 0.5, [0.19, 0.81, 0.61], { depthWriteEnabled: false });
    draw([470, 310, 730, 416], 0.5, [0.89, 0.27, 0.32]);
    draw([520, 332, 680, 394], 0.5, [0.19, 0.81, 0.61], {
      depthBias: -4,
      depthWriteEnabled: false,
    });
    pass.end();
    value(device.queue.submit([value(encoder.finish())]));
    await device.queue.onSubmittedWorkDone();
    value(await recorder.frameBoundary());
    const recorded = value(await capture);
    const pixels = await readbackTexturePixels(device, color, width, height);
    const sample = (x: number, y: number) => [
      ...pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4),
    ];
    const samples = {
      noOccluder: sample(600 - 400, 120),
      occluderGap: sample(600, 120),
      occluderSide: sample(500, 120),
      coplanarNoBias: sample(200, 360),
      coplanarPulled: sample(600, 360),
    };
    expect(samples.noOccluder[1]).toBeGreaterThan(180);
    expect(samples.occluderGap[1]).toBeLessThan(50);
    expect(samples.occluderSide[1]).toBeGreaterThan(180);
    expect(samples.coplanarNoBias[0]).toBeGreaterThan(180);
    expect(samples.coplanarPulled[1]).toBeGreaterThan(180);
    const model = buildFrameModel(value(decodeTape(recorded.bytes)));
    fresh = value(await value(await backend.rhi.requestAdapter()).requestDevice());
    const replay = value(
      await openReplay(value(decodeTape(recorded.bytes)), {
        device: fresh,
        createShaderModule: backend.createShaderModule,
      }),
    );
    try {
      const result = value(
        await replay.inspectWork(model.works.length - 1, ['pipeline', 'pixels']),
      );
      expect(result.attachment?.bytes).toEqual(pixels);
    } finally {
      value(await replay.dispose());
    }
    mkdirSync(output, { recursive: true });
    writeFileSync(`${output}/material-demo.rgba`, Buffer.from(pixels));
    writeFileSync(`${output}/material-demo.rhitape`, recorded.bytes);
    writeFileSync(
      `${output}/material-demo.json`,
      JSON.stringify(
        {
          width,
          height,
          draws,
          tapeSha256: createHash('sha256').update(recorded.bytes).digest('hex'),
          replayMatchesLive: true,
          samples,
          panels: ['no occluder', 'invisible depth occluder', 'coplanar no bias', 'bias -4'],
        },
        null,
        2,
      ),
    );
  } finally {
    value(await recorder.dispose());
  }
}, 120_000);
