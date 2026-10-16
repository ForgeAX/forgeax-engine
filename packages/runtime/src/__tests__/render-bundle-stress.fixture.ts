import type { Result, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import * as backend from '@forgeax/engine-rhi-webgpu';
import { expect, vi } from 'vitest';
import { RenderBundleCache } from '../../../render/src/record/render-bundle-cache';
import { buildFrameModel } from '../../../rhi-debug/src/frame-model';
import { decodeTape } from '../../../rhi-debug/src/protocol/codec';
import { readbackTexturePixels } from '../../../rhi-debug/src/readback';
import { attachRecorder } from '../../../rhi-debug/src/recorder/session';
import { openReplay } from '../../../rhi-debug/src/replay/session';

export const bundleStressCases = [
  'dynamic-lists',
  'resource-lifecycle',
  'live-data',
  'pass-state',
  'many-passes',
] as const;
type StressCase = (typeof bundleStressCases)[number];
type Capture = { bytes: Uint8Array; digest: string };
function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Direct rendering is the pixel oracle for every completed frame. Capture the
 * same cached frame before comparison, so a failure retains its real work tape.
 */
export async function runRenderBundleStressCase(
  scenario: StressCase,
  save?: (capture: Capture, frame: number) => Promise<void>,
) {
  const recorder = value(attachRecorder(backend));
  const adapter = value(await recorder.backend.rhi.requestAdapter());
  const device = value(await adapter.requestDevice());
  const builds = vi.spyOn(device, 'createRenderBundleEncoder');
  const passCount = scenario === 'many-passes' ? 8 : 1;
  const frames = scenario === 'many-passes' ? 64 : 96;
  const width = 32,
    height = 16;
  const texture = value(
    device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: 0x11 }),
  );
  const view = value(device.createTextureView(texture, {}));
  const vertexData = new Float32Array([-1, -1, 3, -1, -1, 3]);
  const makeVertex = () => {
    const buffer = value(device.createBuffer({ size: 24, usage: 0x28 }));
    value(device.queue.writeBuffer(buffer, 0, vertexData));
    return buffer;
  };
  let vertices = makeVertex();
  const indices = value(device.createBuffer({ size: 8, usage: 0x18 }));
  value(device.queue.writeBuffer(indices, 0, new Uint16Array([0, 1, 2, 0])));
  const uniform = value(device.createBuffer({ size: 1024, usage: 0x48 }));
  const colors = [
    [1, 0, 0, 1],
    [0, 1, 0, 1],
    [0, 0, 1, 1],
    [1, 1, 0, 1],
  ];
  const color = (index: number) => {
    const selected = colors[index];
    if (!selected) throw new Error('Missing uniform color');
    return new Float32Array(selected);
  };
  for (let index = 0; index < colors.length; index++) {
    value(device.queue.writeBuffer(uniform, index * 256, color(index)));
  }
  const indirect = value(device.createBuffer({ size: 40, usage: 0x108 }));
  const indirectData = new Uint32Array([3, 1, 0, 0, 3, 1, 0, 0, 0, 0]);
  value(device.queue.writeBuffer(indirect, 0, indirectData));
  const bgl = value(
    device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 2,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
        },
      ],
    }),
  );
  const makeGroup = () =>
    value(
      device.createBindGroup({
        layout: bgl,
        entries: [
          {
            binding: 0,
            resource: { kind: 'buffer', value: { buffer: uniform, offset: 0, size: 16 } },
          },
        ],
      }),
    );
  let group = makeGroup();
  const layout = value(device.createPipelineLayout({ bindGroupLayouts: [bgl] }));
  const shader = value(
    await recorder.backend.createShaderModule(device, {
      code: `
@group(0) @binding(0) var<uniform> color:vec4f;
@vertex fn vs(@location(0) p:vec2f)->@builtin(position) vec4f{return vec4f(p,0.,1.);}
@fragment fn fs()->@location(0) vec4f{return color;}
@fragment fn inverse()->@location(0) vec4f{return vec4f(vec3f(1.)-color.rgb,1.);}`,
    }),
  );
  const pipelines = ['fs', 'inverse'].map((entryPoint) =>
    value(
      device.createRenderPipeline({
        layout,
        vertex: {
          module: shader,
          entryPoint: 'vs',
          buffers: [
            { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          ],
        },
        fragment: { module: shader, entryPoint, targets: [{ format: 'rgba8unorm' }] },
      }),
    ),
  );
  const queries =
    scenario === 'pass-state'
      ? value(device.createQuerySet({ type: 'occlusion', count: 1 }))
      : undefined;
  let caches = Array.from(
    { length: passCount },
    () => new RenderBundleCache({ colorFormats: ['rgba8unorm'] }),
  );
  // Nonzero byte offset, large shared arena, and an interior one-element slice.
  const offsets = new Uint32Array(new ArrayBuffer(262_160), 16, 65_536);
  const signatures = new Set<string>();
  let draws = 0,
    replayedWorks = 0,
    queryFrames = 0,
    outsideQueryBundleExecutions = 0;
  try {
    for (let frame = 0; frame < frames; frame++) {
      const revision = Math.floor(frame / 3);
      // Two consecutive query-free frames exercise admission after the
      // query-only frame retires generic command segments.
      const queryActive = queries !== undefined && Math.floor(frame / 2) % 2 === 0;
      if (scenario === 'resource-lifecycle' && frame % 3 === 0) {
        const old = vertices;
        vertices = makeVertex();
        group = makeGroup();
        value(device.destroyBuffer(old));
        if (frame % 12 === 0) caches = [new RenderBundleCache({ colorFormats: ['rgba8unorm'] })];
      }
      if (scenario === 'live-data') {
        indirectData[0] = indirectData[4] = frame % 2 === 0 ? 3 : 0;
        value(device.queue.writeBuffer(indirect, 0, indirectData));
        const positions = frame % 5 === 4 ? new Float32Array([3, 3, 5, 3, 3, 5]) : vertexData;
        value(device.queue.writeBuffer(vertices, 0, positions));
      }
      const count =
        scenario === 'many-passes'
          ? 128
          : scenario === 'dynamic-lists'
            ? frame % 17 === 0
              ? 0
              : revision % 35
            : 20;
      const buildsBeforeFrame = builds.mock.calls.length;
      let bundleExecutions = 0;
      const render = async (cached: boolean) => {
        if (scenario === 'live-data') {
          value(device.queue.writeBuffer(uniform, 0, color(frame % colors.length)));
        }
        const encoder = value(device.createCommandEncoder());
        for (let passIndex = 0; passIndex < passCount; passIndex++) {
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view,
                loadOp: passIndex === 0 ? 'clear' : 'load',
                storeOp: 'store',
                clearValue: [0, 0, 0, 1],
              },
            ],
            ...(queries === undefined ? {} : { occlusionQuerySet: queries }),
          });
          const executionSpy =
            scenario === 'pass-state' && cached ? vi.spyOn(pass, 'executeBundles') : undefined;
          const record = (p: RhiRenderPassEncoder) => {
            const x = passCount > 1 ? (passIndex % 4) * 8 : 0;
            const y = passCount > 1 ? Math.floor(passIndex / 4) * 8 : 0;
            p.setViewport(x, y, passCount > 1 ? 8 : width, passCount > 1 ? 8 : height, 0, 1);
            const pipeline = pipelines[scenario === 'resource-lifecycle' ? revision % 2 : 0];
            if (!pipeline) throw new Error('Missing pipeline');
            p.setPipeline(pipeline);
            p.setVertexBuffer(0, vertices, 0, 24);
            p.setIndexBuffer(indices, 'uint16', 0, 6);
            if (queryActive) value(p.beginOcclusionQuery(0));
            for (let draw = 0; draw < count; draw++) {
              const order =
                scenario === 'dynamic-lists' && revision % 2 === 1 ? count - draw - 1 : draw;
              const delta =
                scenario === 'live-data' || (scenario === 'many-passes' && passIndex % 2 === 0)
                  ? 0
                  : revision;
              offsets[32_768] =
                scenario === 'live-data' ? 0 : ((order + delta + passIndex) % 4) * 256;
              p.setBindGroup(0, group, offsets, 32_768, 1);
              offsets[32_768] = 123; // Changes to the caller's arena must not alter prior bindings.
              if (scenario === 'pass-state' && draw === 4) {
                p.insertDebugMarker('mid-draw state transition');
                p.setScissorRect(frame % 2 === 0 ? 0 : 16, 0, 16, height);
                p.setBlendConstant([0.5, 0.5, 0.5, 1]);
                p.setStencilReference(frame % 256);
              }
              switch (order % 4) {
                case 0:
                  p.draw(3, 1, 0, 0);
                  break;
                case 1:
                  p.drawIndexed(3, 1, 0, 0, 0);
                  break;
                case 2:
                  p.drawIndirect(indirect, 0);
                  break;
                case 3:
                  p.drawIndexedIndirect(indirect, 16);
                  break;
              }
            }
            if (queryActive) value(p.endOcclusionQuery());
            // Queue writes before submission affect even draws already encoded.
            // Exercise first-frame streaming as well as a warmed bundle here.
            if (scenario === 'live-data') {
              value(device.queue.writeBuffer(uniform, 0, color((frame + 1) % colors.length)));
            }
          };
          const cache = caches[passIndex];
          if (!cache) throw new Error('Missing cache');
          if (cached) cache.encode(device, pass, record);
          else record(pass);
          if (executionSpy !== undefined) {
            bundleExecutions += executionSpy.mock.calls.length;
            executionSpy.mockRestore();
          }
          pass.end();
        }
        value(device.queue.submit([value(encoder.finish())]));
        await device.queue.onSubmittedWorkDone();
      };
      // Alternate execution order while keeping the exact frame inputs fixed.
      const capture = async () => {
        const pending = recorder.captureFrame();
        value(await recorder.frameBoundary());
        await render(true);
        value(await recorder.frameBoundary());
        return value(await pending);
      };
      let artifact: Capture;
      let cached: Uint8Array, direct: Uint8Array;
      if (frame % 2 === 0) {
        await render(false);
        direct = await readbackTexturePixels(device, texture, width, height);
        artifact = await capture();
        cached = await readbackTexturePixels(device, texture, width, height);
      } else {
        artifact = await capture();
        cached = await readbackTexturePixels(device, texture, width, height);
        await render(false);
        direct = await readbackTexturePixels(device, texture, width, height);
      }
      if (scenario === 'pass-state') {
        if (queryActive) {
          // Every draw is inside the query: neither recording nor executing
          // native bundles may hide its pass-only state or query region.
          expect(builds.mock.calls.length, `query frame=${frame}`).toBe(buildsBeforeFrame);
          expect(bundleExecutions, `query frame=${frame}`).toBe(0);
          queryFrames++;
        } else outsideQueryBundleExecutions += bundleExecutions;
      }
      const matches = cached.length === direct.length && cached.every((n, i) => n === direct[i]);
      const inspect =
        frame === 32 ||
        (scenario === 'pass-state' && frame === 34) ||
        (scenario === 'live-data' && frame === 0);
      if (!matches || inspect) await save?.(artifact, frame);
      expect(matches, `${scenario} frame=${frame} tape=${artifact.digest}`).toBe(true);
      signatures.add(Array.from(cached.filter((_, index) => index % 4 !== 3)).join(','));
      draws += passCount * count;
      if (inspect) {
        const tape = value(decodeTape(artifact.bytes));
        const model = buildFrameModel(tape);
        expect(model.unseededResources).toHaveLength(0);
        expect(model.works).toHaveLength(passCount * count);
        const replayDevice = value(await value(await backend.rhi.requestAdapter()).requestDevice());
        const replay = value(
          await openReplay(tape, {
            device: replayDevice,
            createShaderModule: backend.createShaderModule,
          }),
        );
        try {
          const inspection = value(
            await replay.inspectWork(model.works.length - 1, ['pipeline', 'bindings', 'pixels']),
          );
          expect(inspection.attachment?.bytes).toEqual(cached);
          expect(inspection.bindings?.length).toBeGreaterThan(0);
          replayedWorks += model.works.length;
        } finally {
          value(await replay.dispose());
        }
      }
    }
    expect(signatures.size).toBeGreaterThan(1);
    if (scenario === 'live-data') expect(builds).toHaveBeenCalledTimes(1);
    else if (scenario === 'pass-state') {
      expect(queryFrames).toBe(frames / 2);
      expect(outsideQueryBundleExecutions).toBeGreaterThan(0);
      expect(builds.mock.calls.length).toBeGreaterThan(0);
      expect(replayedWorks).toBe(40);
    } else expect(builds.mock.calls.length).toBeGreaterThan(0);
    return {
      scenario,
      frames,
      passesPerFrame: passCount,
      drawsPerPath: draws,
      replayedWorks,
      queryFrames,
      outsideQueryBundleExecutions,
      builds: builds.mock.calls.length,
      distinctOutputs: signatures.size,
    };
  } finally {
    builds.mockRestore();
    value(await recorder.dispose());
    if (queries !== undefined) value(device.destroyQuerySet(queries));
    for (const buffer of [vertices, indices, uniform, indirect])
      value(device.destroyBuffer(buffer));
    value(device.destroyTexture(texture));
  }
}
