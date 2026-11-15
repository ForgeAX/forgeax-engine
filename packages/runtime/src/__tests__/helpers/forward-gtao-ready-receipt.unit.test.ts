import { readFileSync } from 'node:fs';
import type { FrameReceipt } from '@forgeax/engine-render';
import { err, ok } from '@forgeax/engine-types';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { RendererContractFailureError } from '../../../../render/src/errors/render';
import { settleForwardGtaoFeaturePreparation } from './forward-gtao-capture';

afterEach(() => vi.useRealTimers());

function pending(preparationCompleted?: FrameReceipt['preparationCompleted']): FrameReceipt {
  return {
    frameId: 54,
    deviceGeneration: 0,
    graphGeneration: 5,
    backendId: 'webgpu',
    presentation: 'pending',
    presentationPendingReason: {
      code: 'feature-preparation',
      featureIdentity: 'test.forward-gtao-scene-data-consumer',
      preparationStage: 'resource-preparation',
      resource: 'surface-data-consumer-program',
      operation: 'prepare-gpu-program',
      reason: 'shader-module-pending',
    },
    completed: Promise.resolve(ok(undefined)),
    ...(preparationCompleted === undefined ? {} : { preparationCompleted }),
  };
}

it('settles the current feature preparation without accepting its pending receipt as ready', async () => {
  let release!: (value: ReturnType<typeof ok<void>>) => void;
  const receipt = pending(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  let settled = false;
  const waiting = settleForwardGtaoFeaturePreparation(receipt, Date.now() + 30_000).then(
    (value) => {
      settled = true;
      return value;
    },
  );
  await receipt.completed;
  expect(settled).toBe(false);
  release(ok(undefined));
  expect(await waiting).toBe(true);
  expect(receipt.presentation).toBe('pending');
  expect(receipt.frameId).toBe(54);
});

it('retains preparation rejection and requires the current receipt completion signal', async () => {
  const failure = new RendererContractFailureError('draw', 'current native preparation rejected');
  await expect(
    settleForwardGtaoFeaturePreparation(
      pending(Promise.resolve(err(failure))),
      Date.now() + 30_000,
    ),
  ).rejects.toBe(failure);
  await expect(settleForwardGtaoFeaturePreparation(pending(), Date.now() + 30_000)).rejects.toThrow(
    'completion signal',
  );
});

it('keeps the caller deadline and does not retry after a late preparation', async () => {
  vi.useFakeTimers();
  const waiting = settleForwardGtaoFeaturePreparation(
    pending(new Promise(() => {})),
    Date.now() + 30_000,
  );
  const rejected = expect(waiting).rejects.toThrow('capture deadline');
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
});

it('leaves ready receipts and ordinary recorded pending barriers with their strict trace validator', async () => {
  const { presentationPendingReason: _reason, ...ready } = pending();
  expect(
    await settleForwardGtaoFeaturePreparation(
      { ...ready, presentation: 'ready' },
      Date.now() + 30_000,
    ),
  ).toBe(false);
  expect(
    await settleForwardGtaoFeaturePreparation(
      { ...pending(), presentationPendingReason: { code: 'scene-pipeline-preparation' } },
      Date.now() + 30_000,
    ),
  ).toBe(false);
});

it('requires the subsequent submitted ready receipt to match its exact current trace', () => {
  const source = readFileSync(
    new URL('../forward-gtao-webgpu.browser.test.ts', import.meta.url),
    'utf8',
  );
  const parsed = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  const validator = parsed.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'validatedClusterFrameReceipt',
  );
  if (validator === undefined) throw new Error('Missing original strict cluster receipt validator');
  const validate = new Function(
    'receipt',
    'observation',
    'trace',
    ts.transpile(validator.getText(parsed), { target: ts.ScriptTarget.ES2022 }) +
      '\nreturn validatedClusterFrameReceipt(receipt, observation, trace);',
  );
  const receipt = { frameId: 55, presentation: 'ready' };
  const observation = { status: 'captured', frameNumber: 54 };
  const trace = {
    recordFrameNumber: 54,
    observationFrameId: 55,
    recordStatus: 'submitted',
    receipt: { publicReceiptFrameId: 55, presentation: 'ready', completion: 'completed' },
  };
  expect(validate(receipt, observation, trace).pendingBarrier).toBe(false);
  expect(() => validate({ frameId: 54, presentation: 'pending' }, observation, trace)).toThrow(
    'does not match',
  );
  expect(() => validate(receipt, observation, { ...trace, observationFrameId: 53 })).toThrow(
    'does not match',
  );
  expect(() => validate(receipt, observation, { ...trace, recordStatus: 'pending' })).toThrow(
    'does not match',
  );
  expect(() => validate(receipt, { ...observation, frameNumber: 53 }, trace)).toThrow(
    'does not match',
  );
});
