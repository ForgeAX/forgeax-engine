import type { RenderBundle, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { makeRhiDevice } from '../device';
import { readRhiCommandCounts, subtractRhiCommandCounts } from '../index';
import { createMockGpu } from './__mocks__/gpu-device';

async function setup(consume: (handles: Iterable<unknown>) => void) {
  const gpu = createMockGpu();
  const adapter = await gpu.requestAdapter();
  if (adapter === null) throw new Error('Mock adapter missing');
  const raw = await adapter.requestDevice();
  const rawEncoder = raw.createCommandEncoder();
  const rawPass = rawEncoder.beginRenderPass({ colorAttachments: [] });
  rawPass.executeBundles = consume;
  rawEncoder.beginRenderPass = () => rawPass;
  raw.createCommandEncoder = () => rawEncoder;
  const { device } = makeRhiDevice(raw as unknown as GPUDevice);
  const encoder = device.createCommandEncoder().unwrap();
  const pass = encoder.beginRenderPass({ colorAttachments: [] });
  return { pass, rawPass };
}

const bundle = (label: string) => ({ label }) as unknown as RenderBundle;

describe('render bundle input consumption', () => {
  it('consumes each borrowed iterator once in order while an iterator reenters the pass', async () => {
    const submitted: unknown[][] = [];
    const { pass } = await setup((handles) => submitted.push(Array.from(handles)));
    const a = bundle('a'),
      b = bundle('b'),
      nested = bundle('nested');
    let started = 0;
    const source = {
      *[Symbol.iterator]() {
        started++;
        yield a;
        pass.executeBundles([nested]).unwrap();
        yield b;
      },
    };
    const before = readRhiCommandCounts();
    pass.executeBundles(source).unwrap();
    expect(started).toBe(1);
    expect(submitted).toEqual([[nested], [a, b]]);
    expect(subtractRhiCommandCounts(readRhiCommandCounts(), before).bundlesExecuted).toBe(3);
  });

  it('keeps the outer native sequence intact when native consumption reenters', async () => {
    const submitted: unknown[][] = [];
    let pass: RhiRenderPassEncoder | undefined;
    let entered = false;
    const a = bundle('outer'),
      nested = bundle('nested');
    const fixture = await setup((handles) => {
      const before = Array.from(handles);
      if (!entered) {
        entered = true;
        if (pass === undefined) throw new Error('Pass fixture missing');
        pass.executeBundles([nested]).unwrap();
      }
      expect(Array.from(handles)).toEqual(before);
      submitted.push(before);
    });
    pass = fixture.pass;
    pass.executeBundles([a]).unwrap();
    expect(submitted).toEqual([[nested], [a]]);
  });

  it('preserves an iterator failure and does not submit its partial sequence', async () => {
    const submitted: unknown[][] = [];
    const { pass } = await setup((handles) => submitted.push(Array.from(handles)));
    const a = bundle('partial'),
      b = bundle('accepted');
    const before = readRhiCommandCounts();
    const source = {
      *[Symbol.iterator]() {
        yield a;
        throw new Error('input iterator failed');
      },
    };
    const failed = pass.executeBundles(source);
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error('Expected iterator failure');
    expect(failed.error.code).toBe('webgpu-runtime-error');
    expect(failed.error.hint).toContain('input iterator failed');
    expect(submitted).toEqual([]);
    pass.executeBundles([b]).unwrap();
    expect(submitted).toEqual([[b]]);
    expect(subtractRhiCommandCounts(readRhiCommandCounts(), before).bundlesExecuted).toBe(1);
  });

  it('recovers after native failure and preserves empty and larger sequences', async () => {
    const submitted: unknown[][] = [];
    let fail = true;
    const { pass } = await setup((handles) => {
      if (fail) throw new Error('native bundle failure');
      submitted.push(Array.from(handles));
    });
    const values = [bundle('a'), bundle('b'), bundle('c')];
    const before = readRhiCommandCounts();
    expect(pass.executeBundles(values.slice(0, 1)).ok).toBe(false);
    fail = false;
    pass.executeBundles([]).unwrap();
    pass.executeBundles(values).unwrap();
    pass.executeBundles(values.slice(1, 2)).unwrap();
    expect(submitted).toEqual([[], values, values.slice(1, 2)]);
    expect(subtractRhiCommandCounts(readRhiCommandCounts(), before).bundlesExecuted).toBe(4);
  });
});
