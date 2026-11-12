import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import { RenderGraphBuilder } from '../builder';
import type { CompiledRenderGraph, ComputeGraphPass } from '../types';

type Frame = {
  readonly encoder: RhiCommandEncoder;
  readonly value: number;
  readonly fail?: boolean;
};

it('encodes all direct pass kinds with current arguments, receiver binding, errors and reentry', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const builder = new RenderGraphBuilder<Frame>();
  const texture = builder
    .createTexture('color', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
    .unwrap();
  const view = builder.view(texture).unwrap();
  const seen: number[] = [];
  const frames: Frame[] = [];
  let compiled: CompiledRenderGraph<Frame>;
  builder
    .addCopyPass('copy', {
      accesses: [],
      encodeDirect: (_encoder, frame, resources) => {
        frames.push(frame);
        seen.push(frame.value);
        expect(resources.textureView(view).ok).toBe(false);
        expect(compiled.execute(frame).ok).toBe(false);
      },
    })
    .unwrap();
  const compute = {
    accesses: [],
    encodeDirect(
      ...[_pass, frame]: Parameters<NonNullable<ComputeGraphPass<Frame>['encodeDirect']>>
    ) {
      expect(this).toBe(compute);
      seen.push(frame.value);
      if (frame.fail) throw new Error('encode probe');
    },
  };
  builder.addComputePass('compute', compute).unwrap();
  builder
    .addRasterPass('raster', {
      accesses: [{ resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      encodeDirect: (_pass, frame, resources) => {
        expect(resources.textureView(view).ok).toBe(true);
        seen.push(frame.value);
      },
    })
    .unwrap();
  compiled = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  for (let value = 0; value < 3; value++) {
    const encoder = device.createCommandEncoder().unwrap();
    expect(compiled.execute({ encoder, value, fail: value === 1 }).ok).toBe(value !== 1);
    encoder.finish().unwrap();
  }
  expect(seen).toEqual([0, 0, 0, 1, 1, 2, 2, 2]);
  expect(frames.map((frame) => frame.value)).toEqual([0, 1, 2]);
  await compiled.retire();
});

it('keeps ordinary context records detached from later frames', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const builder = new RenderGraphBuilder<Frame>();
  const contexts: Parameters<NonNullable<ComputeGraphPass<Frame>['encode']>>[0][] = [];
  builder
    .addComputePass('ordinary', {
      accesses: [],
      encode: (context) => {
        contexts.push(context);
      },
    })
    .unwrap();
  const compiled = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  for (let value = 0; value < 2; value++) {
    const encoder = device.createCommandEncoder().unwrap();
    compiled.execute({ encoder, value }).unwrap();
    encoder.finish().unwrap();
  }
  expect(contexts[0]).not.toBe(contexts[1]);
  expect(contexts.map((context) => context.frame.value)).toEqual([0, 1]);
  await compiled.retire();
});

it('rejects missing, conflicting and malformed callbacks without consuming a pass name', () => {
  const builder = new RenderGraphBuilder<Frame>();
  for (const descriptor of [
    { accesses: [] },
    { accesses: [], encode: () => undefined, encodeDirect: () => undefined },
    { accesses: [], encodeDirect: 'invalid' },
  ]) {
    const result = builder.addComputePass(
      'retry',
      descriptor as unknown as ComputeGraphPass<Frame>,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('resource-descriptor-invalid');
  }
  expect(builder.addComputePass('retry', { accesses: [], encodeDirect: () => undefined }).ok).toBe(
    true,
  );
});
