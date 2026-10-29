import type { FrameReceipt, RenderError } from '@forgeax/engine-render';
import { err, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createDarkGradientSampler } from '../dark-gradient-sampler';

const receipt = (frameId: number, presentation: 'pending' | 'ready'): FrameReceipt => ({
  frameId,
  deviceGeneration: 0,
  presentation,
  completed: Promise.resolve(ok(undefined)),
});

it('does not sample cold-start pending frames or arm before 60 ready completions', async () => {
  const sampler = createDarkGradientSampler(60);
  for (let id = 1; id <= 120; id++) await sampler.complete('none', receipt(id, 'pending'));
  expect(sampler.arm('none', 121)).toBe(false);
  for (let id = 121; id < 180; id++) await sampler.complete('none', receipt(id, 'ready'));
  expect(sampler.arm('none', 180)).toBe(false);
  let finish!: (value: Awaited<FrameReceipt['completed']>) => void;
  const last = sampler.complete('none', {
    ...receipt(180, 'ready'),
    completed: new Promise((resolve) => {
      finish = resolve;
    }),
  });
  expect(sampler.arm('none', 181)).toBe(false);
  finish(ok(undefined));
  expect((await last).unwrap()).toBe(false);
  expect(sampler.arm('none', 181)).toBe(true);
  expect((await sampler.complete('none', receipt(181, 'ready'))).unwrap()).toBe(true);
  expect(sampler.arm('none', 182)).toBe(false);
  expect(sampler.arm('fxaa', 182)).toBe(false);
});

it('keeps phase windows independent and retries a pending capture with its new receipt', async () => {
  const sampler = createDarkGradientSampler(60);
  for (const phase of ['none', 'fxaa'] as const) {
    for (let id = 200; id < 260; id++) await sampler.complete(phase, receipt(id, 'ready'));
    expect(sampler.arm(phase, 260)).toBe(true);
    expect((await sampler.complete(phase, receipt(260, 'pending'))).unwrap()).toBe(false);
    expect(sampler.arm(phase, 261)).toBe(true);
    expect((await sampler.complete(phase, receipt(259, 'ready'))).unwrap()).toBe(false);
    expect((await sampler.complete(phase, receipt(261, 'ready'))).unwrap()).toBe(true);
  }
});

it('preserves failed GPU completions without crediting the sample window', async () => {
  const sampler = createDarkGradientSampler(60);
  for (let id = 1; id < 60; id++) await sampler.complete('none', receipt(id, 'ready'));
  const error: RenderError = Object.assign(new Error('fixture completion failure'), {
    code: 'renderer-contract-failed',
    expected: 'renderer owner contracts remain valid at the public boundary',
    hint: 'repair the owner contract and retry the operation',
    detail: { operation: 'draw', cause: 'fixture completion failure' },
  } as const);
  const failed = await sampler.complete('none', {
    ...receipt(60, 'ready'),
    completed: Promise.resolve(err(error)),
  });
  expect(failed.ok).toBe(false);
  if (!failed.ok) expect(failed.error).toBe(error);
  expect(sampler.arm('none', 61)).toBe(false);
  await sampler.complete('none', receipt(61, 'ready'));
  expect(sampler.arm('none', 62)).toBe(true);
});
