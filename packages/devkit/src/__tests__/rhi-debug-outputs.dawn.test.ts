import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachRecorder, buildFrameModel, decodeTape, tapeDigest } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { describe, expect, it } from 'vitest';
import { type RhiDebugOperationContext, runRhiDebugOperation } from '../rhi-debug/operations';

const SKIP_DAWN = process.env.FORGEAX_SKIP_DAWN === '1';
const RENDER_ATTACHMENT = 0x10;
const COPY_SRC = 0x01;

const DEPTH_ONLY = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0.25, 1);
}`;

/** Records one depth-only draw into layer 1 of a 2-layer shadow array. */
async function recordShadowLayer(): Promise<Uint8Array> {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const depth = device
    .createTexture({
      size: { width: 4, height: 4, depthOrArrayLayers: 2 },
      format: 'depth32float',
      textureBindingViewDimension: undefined,
      usage: RENDER_ATTACHMENT | COPY_SRC,
    })
    .unwrap();
  const view = device
    .createTextureView(depth, {
      dimension: '2d',
      baseArrayLayer: 1,
      arrayLayerCount: 1,
      aspect: 'depth-only',
    })
    .unwrap();
  const shader = (await recorder.backend.createShaderModule(device, { code: DEPTH_ONLY })).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs', buffers: [] },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    })
    .unwrap();
  try {
    await device.queue.onSubmittedWorkDone();
    const captured = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 1,
      },
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    return (await captured).unwrap().bytes;
  } finally {
    device.destroyTexture(depth).unwrap();
    (await recorder.dispose()).unwrap();
  }
}

/** Replays on the test's Dawn instance; one process holds one Dawn instance, as the CLI does. */
function dawnContext(bytes: Uint8Array): RhiDebugOperationContext {
  return {
    captureFrame: async () => {
      throw new Error('not captured live');
    },
    readArtifact: async () => ({ ok: true, value: bytes }),
    createReplayBackend: async () => {
      const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const device = (await adapter.requestDevice()).unwrap();
      const release = () => device.nativeDevice().unwrap().destroy();
      return {
        ok: true,
        value: { device, createShaderModule: webgpu.createShaderModule, release },
      };
    },
    writeFile: async (path, data) => {
      await writeFile(path, data);
      return { ok: true, value: path };
    },
  };
}

describe.skipIf(SKIP_DAWN)('forgeax rhi outputs on Dawn', () => {
  it('inspects and reads a depth-only shadow layer as linear depth', async () => {
    const bytes = await recordShadowLayer();
    const work = buildFrameModel(decodeTape(bytes).unwrap()).works.find(
      (candidate) => candidate.drawCall !== null,
    );
    if (work === undefined) throw new Error('missing depth-only draw');
    const root = await mkdtemp(join(tmpdir(), 'rhi-outputs-'));
    const png = join(root, 'shadow.png');
    const artifact = { kind: 'rhi-tape' as const, digest: tapeDigest(bytes), source: 'test' };
    const context = dawnContext(bytes);
    try {
      const inspected = await runRhiDebugOperation(
        'rhi.inspect',
        {
          artifact,
          workIndex: work.workIndex,
          fields: ['outputs'],
        },
        context,
      );
      if (!inspected.ok) throw new Error(inspected.error.hint);
      expect(inspected.value.inspection.outputs).toMatchObject([
        { name: 'depth', role: 'depth', read: { ok: true, value: { byteLength: 64 } } },
      ]);
      const read = await runRhiDebugOperation(
        'rhi.read',
        {
          artifact,
          reads: [
            {
              output: 'depth',
              workIndex: work.workIndex,
              image: { depth: { near: 1, far: 100 }, range: 'auto', png },
            },
            { output: 'color0', workIndex: work.workIndex },
          ],
        },
        context,
      );
      if (!read.ok) throw new Error(read.error.hint);
      const linear = 100 / (100 - 0.25 * 99);
      const [depthRead, missing] = read.value.reads;
      if (depthRead?.ok !== true) throw new Error('depth output was not read');
      expect(depthRead.value.image?.width).toBe(4);
      expect(depthRead.value.image?.stats.min[0]).toBeCloseTo(linear, 4);
      expect(depthRead.value.image?.stats.max[0]).toBeCloseTo(linear, 4);
      expect(depthRead.value.image?.png).toBe(png);
      expect((await readFile(png)).subarray(1, 4).toString()).toBe('PNG');
      expect(missing).toMatchObject({
        ok: false,
        error: { code: 'read-request-invalid', hint: expect.stringContaining('wrote depth') },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
