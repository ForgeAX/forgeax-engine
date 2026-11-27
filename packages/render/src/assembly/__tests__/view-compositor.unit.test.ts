import { renderGraphCompileCount } from '@forgeax/engine-render-graph';
import { ok } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../../device/device-scope';
import type { RenderSystemInternals } from '../../record/render-context';
import { createRenderWorld } from '../../world/render-world';
import {
  type CompositeChannels,
  type CompositeSource,
  createViewCompositor,
} from '../view-compositor';

async function setup() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const profile = { format: 'rgba8unorm' as const, surfaceProfile: 'raw-only' as const };
  const runtime = {
    device,
    deviceScope: DeviceScope.create(1, 'composite'),
    canvas: { width: 8, height: 8 },
    renderWorld: createRenderWorld(),
    getPipelineState: () => profile,
    immediateShaderModuleFactory: { createShaderModule: () => ok(module) },
    framePassNames: [] as string[],
    observationCaptureDomains: [] as 'final-display'[],
  };
  const compositor = createViewCompositor(runtime as unknown as RenderSystemInternals);
  const source = (): CompositeSource => ({
    texture: device
      .createTexture({ size: [8, 8], format: profile.format, usage: 0x10 | 0x04 })
      .unwrap(),
    width: 8,
    height: 8,
  });
  const picture = (x: number, channels: CompositeChannels) => ({
    source: source(),
    channels,
    viewport: { x, y: 0, width: 4, height: 8, renderWidth: 8, renderHeight: 8 },
  });
  return { device, runtime, compositor, output: source().texture, picture };
}

it('issues the current rectangles and masks across 300 changing frames with only source-owned bindings', async () => {
  const { device, runtime, compositor, output, picture } = await setup();
  const a = picture(0, 'red'),
    b = picture(4, 'cyan');
  const groups = vi.spyOn(device, 'createBindGroup');
  const pipelines = vi.spyOn(device, 'createRenderPipeline');
  const before = renderGraphCompileCount();
  try {
    for (let i = 0; i < 300; i++) {
      const rows = i % 3 === 0 ? [b, a] : i % 3 === 1 ? [a] : [a, b];
      a.channels = i % 2 === 0 ? 'all' : 'red';
      const encoder = device.createCommandEncoder().unwrap();
      const xs: number[] = [];
      const begin = encoder.beginRenderPass.bind(encoder);
      vi.spyOn(encoder, 'beginRenderPass').mockImplementation((desc) => {
        const pass = begin(desc);
        vi.spyOn(pass, 'setViewport').mockImplementation((x) => {
          xs.push(x);
        });
        return pass;
      });
      expect(compositor.encode(encoder, rows, output)).toBe(true);
      expect(xs).toEqual(rows.map((row) => row.viewport.x));
      encoder.finish().unwrap();
    }
    expect(renderGraphCompileCount()).toBe(before);
    expect(groups).toHaveBeenCalledTimes(2);
    expect(pipelines.mock.calls.map(([p]) => p.fragment?.targets[0]?.writeMask).sort()).toEqual(
      [6, 9, 15].sort(),
    );
    expect(runtime.framePassNames).toHaveLength(300);
    expect(compositor.generation).toBeGreaterThan(0);
  } finally {
    compositor.dispose();
    for (const texture of [a.source.texture, b.source.texture, output])
      device.destroyTexture(texture);
    runtime.deviceScope.dispose();
  }
});

it('releases the raw output observation attachment on its original queue and rejects physical feedback', async () => {
  const { device, runtime, compositor, output, picture } = await setup();
  const row = picture(0, 'all');
  const textures = vi.spyOn(device, 'createTexture');
  const destroy = vi.spyOn(device, 'destroyTexture');
  let complete!: () => void;
  const fence = new Promise<undefined>((resolve) => {
    complete = () => resolve(undefined);
  });
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockReturnValue(fence);
  const run = () => {
    const encoder = device.createCommandEncoder().unwrap();
    expect(compositor.encode(encoder, [row], output)).toBe(true);
    encoder.finish().unwrap();
  };
  try {
    runtime.observationCaptureDomains.push('final-display');
    run();
    run();
    const allocated = textures.mock.results[0]?.value.unwrap();
    expect(allocated).toBeDefined();
    expect(textures).toHaveBeenCalledTimes(1);
    expect(runtime.framePassNames.slice(-3)).toEqual([
      'camera-view-composite',
      'camera-view-present',
      'final-display-observation',
    ]);
    const generation = compositor.generation;
    runtime.observationCaptureDomains.length = 0;
    run();
    expect(compositor.generation).toBe(generation);
    expect(destroy).not.toHaveBeenCalled();
    complete();
    await fence;
    expect(destroy).toHaveBeenCalledWith(allocated);
    runtime.observationCaptureDomains.push('final-display');
    run();
    expect(compositor.generation).toBe(generation);
    expect(textures).toHaveBeenCalledTimes(2);
    expect(textures.mock.results[1]?.value.unwrap()).not.toBe(allocated);
    runtime.observationCaptureDomains.length = 0;
    run();
    const encoder = device.createCommandEncoder().unwrap();
    const begin = vi.spyOn(encoder, 'beginRenderPass');
    expect(() => compositor.encode(encoder, [row], row.source.texture)).toThrow();
    expect(begin).not.toHaveBeenCalled();
  } finally {
    complete();
    compositor.dispose();
    device.destroyTexture(row.source.texture);
    device.destroyTexture(output);
    runtime.deviceScope.dispose();
  }
});
