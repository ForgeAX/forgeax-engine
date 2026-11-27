import {
  appendCompiledRenderGraphPassNames,
  RenderGraphBuilder,
  renderGraphCompileCount,
} from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { createPmremAtlas } from '../ibl/pmrem';
import { addCurrentReflectionProbeFilters } from '../record/reflection-probe-pmrem';
import {
  addReflectionProbeGraphPasses,
  type ReflectionProbeGraphState,
} from '../record/typed-frame-graph';
import type { RenderPipelineFrame } from '../render-pipeline';

async function createProbeWork() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const rawTexture = device
    .createTexture({
      label: 'reflection-test-raw',
      format: 'rgba8unorm',
      size: { width: 1, height: 1, depthOrArrayLayers: 6 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      usage: 0x15,
      textureBindingViewDimension: undefined,
    })
    .unwrap();
  const rawCubeView = device
    .createTextureView(rawTexture, { dimension: 'cube', arrayLayerCount: 6 })
    .unwrap();
  const rawFaceViews = Array.from({ length: 6 }, (_, face) =>
    device
      .createTextureView(rawTexture, {
        dimension: '2d',
        baseArrayLayer: face,
        arrayLayerCount: 1,
      })
      .unwrap(),
  );
  const depthTexture = device
    .createTexture({
      label: 'reflection-test-depth',
      format: 'depth24plus-stencil8',
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      usage: 0x10,
      textureBindingViewDimension: undefined,
    })
    .unwrap();
  const depthView = device.createTextureView(depthTexture, { dimension: '2d' }).unwrap();
  const sampler = device.createSampler().unwrap();
  const emptyLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const filterGroup1 = device.createBindGroup({ layout: emptyLayout, entries: [] }).unwrap();
  const atlas = createPmremAtlas(device, 'probe-test-atlas', 16, 'rgba8unorm').unwrap();
  const scratch = createPmremAtlas(device, 'probe-test-scratch', 16, 'rgba8unorm').unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const filterPipeline = device
    .createRenderPipeline({
      label: 'reflection-test-filter',
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'main', buffers: [] },
      fragment: { module: shader, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  const work: ReflectionProbeGraphState['work'][number] = {
    probeIndex: 0,
    rawTexture,
    rawCubeView,
    rawFaceViews,
    rawDepthTexture: depthTexture,
    rawCaptureFace: 0,
    rawDepthView: depthView,
    rawSize: 1,
    filteredTexture: atlas.texture,
    filteredView: atlas.view,
    filterScratchTexture: scratch.texture,
    filterScratchView: scratch.view,
    outputFormat: 'rgba8unorm',
    sampler,
    filterPipeline,
    filterGroup0: undefined,
    filterGroup1,
    filteredSize: 16,
    step: undefined,
  };
  return {
    device,
    work,
    dispose() {
      for (const texture of [rawTexture, depthTexture, atlas.texture, scratch.texture])
        device.destroyTexture(texture);
    },
  };
}

describe('ReflectionProbe capture pass encoding', () => {
  it('resolves imported capture views through the execution resolver', async () => {
    const { device, work, dispose } = await createProbeWork();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    expect(addReflectionProbeGraphPasses(graph, { work: [work] }).ok).toBe(true);
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const encoder = device.createCommandEncoder({ label: 'reflection-test-frame' }).unwrap();
    const frame = {
      runtime: { device },
      validatedOrdered: [],
      frameState: { standardLighting: undefined, installedPipelineConfig: undefined },
      msaaActive: false,
      splitLdrSprite: false,
    } as unknown as RenderPipelineFrame;
    const executed = compiled.execute({ ...frame, encoder });
    expect(executed.ok).toBe(true);
    expect(encoder.finish().ok).toBe(true);
    await compiled.retire();
    dispose();
  });

  it('encodes current filter tiles between the same two passes as probe work changes', async () => {
    const { device, work, dispose } = await createProbeWork();
    const builder = new RenderGraphBuilder<RenderPipelineFrame>();
    builder.addCopyPass('before', { accesses: [], encodeDirect: () => {} }).unwrap();
    addCurrentReflectionProbeFilters(builder).unwrap();
    builder.addCopyPass('after', { accesses: [], encodeDirect: () => {} }).unwrap();
    const before = renderGraphCompileCount();
    const compiled = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const groups = [work.filterGroup1, work.filterGroup1];
    try {
      for (let i = 0; i < 300; i++) {
        const probeIndex = i % 7;
        const mipLevel = Math.floor(i / 3) % 4;
        const faceIndex = (i % 3) * 2;
        const step = { probeIndex, mipLevel, faceIndex };
        const active = {
          ...work,
          probeIndex,
          rawCaptureFace: undefined,
          filterGroup0: groups,
          step,
        };
        const other = {
          ...active,
          probeIndex: probeIndex + 8,
          step: { ...step, probeIndex: probeIndex + 8 },
        };
        const scheduled =
          i % 4 === 0 ? [] : i % 4 === 1 ? [work] : i % 4 === 2 ? [active] : [other, active];
        const encoder = device.createCommandEncoder().unwrap();
        const copy = vi.spyOn(encoder, 'copyTextureToTexture');
        const raster = vi.spyOn(encoder, 'beginRenderPass');
        const frame = {
          encoder,
          probeFilterWork: { work: scheduled },
        } as unknown as RenderPipelineFrame;
        const names: string[] = [];
        appendCompiledRenderGraphPassNames(compiled, names, frame);
        const actual: string[] = [];
        const phases: string[] = [];
        compiled
          .execute(frame, (pass, encode) => {
            if (pass.kind !== 'subgraph') actual.push(pass.name);
            if (pass.profileName) phases.push(pass.profileName);
            encode();
          })
          .unwrap();
        const filtered = scheduled.filter((job) => job.step !== undefined);
        const expected = filtered.flatMap((job) => [
          `reflection-probe.${job.probeIndex}.pmrem.${mipLevel}.${faceIndex}`,
          `reflection-probe.${job.probeIndex}.pmrem-copy.${mipLevel}.${faceIndex}`,
        ]);
        expect(actual).toEqual(['before', ...expected, 'after']);
        expect(names).toEqual(actual);
        expect(phases).toEqual(
          filtered.flatMap(() => ['reflection-probe-filter', 'reflection-probe-filter-copy']),
        );
        expect(copy).toHaveBeenCalledTimes(2 * filtered.length);
        expect(raster).toHaveBeenCalledTimes(filtered.length);
        for (const [from, to] of copy.mock.calls) {
          expect(from.texture).toBe(work.filteredTexture);
          expect(to.texture).toBe(work.filterScratchTexture);
        }
        for (const [pass] of raster.mock.calls) {
          expect(Array.from(pass.colorAttachments)[0]?.loadOp).toBe(
            mipLevel === 0 && faceIndex === 0 ? 'clear' : 'load',
          );
        }
        encoder.finish().unwrap();
        copy.mockRestore();
        raster.mockRestore();
      }
      expect(renderGraphCompileCount()).toBe(before + 1);
    } finally {
      await compiled.retire();
      dispose();
    }
  });
});
