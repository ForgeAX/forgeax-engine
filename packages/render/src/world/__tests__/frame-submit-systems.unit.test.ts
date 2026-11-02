import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { RenderSystemInternals } from '../../record/render-context';
import {
  beginFrameSubmission,
  frameSubmitOutcome,
  submitEncodedFrame,
} from '../frame-submit-systems';
import { renderFrameEncoder } from '../record-systems';
import { createRenderWorld, renderSubmission, runRenderRecord } from '../render-world';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const world = createRenderWorld();
  beginFrameSubmission(world);
  expect(runRenderRecord(world, { device, frameId: 1 }).ok).toBe(true);
  const owner = {
    device,
    deviceScope: { generation: 0 },
    errorRegistry: { fire: vi.fn() },
  } as unknown as RenderSystemInternals;
  const input = { device, frameId: 1, rendererInternals: owner, shared: true };
  return {
    world,
    device,
    owner,
    input,
    state: frameSubmitOutcome(world),
    submit: vi.spyOn(device.queue, 'submit'),
  };
}

it('pins every observer to the same physical fence even when a sibling throws', async () => {
  const f = await fixture();
  const failure = new Error('observer failed');
  const sibling = vi.fn();
  const reportError = vi.fn();
  expect(
    submitEncodedFrame(
      f.world,
      f.input,
      [
        {
          reportError,
          onSubmittedWork: () => {
            throw failure;
          },
        },
        { reportError, onSubmittedWork: sibling },
      ],
      f.state,
    ),
  ).toBe(true);
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.state.failures).toEqual([failure]);
  expect(sibling).toHaveBeenCalledExactlyOnceWith(renderSubmission(f.world).completion);
  expect(renderSubmission(f.world).accepted).toBe(true);
  expect(renderFrameEncoder(f.world).kind).toBe('closed');
  expect(f.world.execution.health).toBe('healthy');
});

it('rejects a failed finish, completes staged uploads and leaves the World healthy', async () => {
  const f = await fixture();
  const encoder = renderFrameEncoder(f.world);
  if (encoder.kind !== 'open') throw new Error('Missing encoder');
  const complete = vi.fn();
  Object.assign(f.owner, {
    gpuStore: {
      prepareTextureMips: () => ({ ok: true, value: { buffer: undefined, complete } }),
      morphGeometry: { prepare: () => undefined },
    },
  });
  vi.spyOn(encoder.encoder, 'finish').mockReturnValue(
    err(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'command encoding finishes',
        hint: 'retry the frame',
      }),
    ),
  );
  expect(submitEncodedFrame(f.world, f.input, [], f.state)).toBe(false);
  expect(f.state.result).toEqual({ ok: false, stage: 'finish' });
  expect(complete).toHaveBeenCalledExactlyOnceWith(false);
  expect(f.submit).not.toHaveBeenCalled();
  expect(renderSubmission(f.world).accepted).toBe(false);
  expect(f.world.execution.health).toBe('healthy');
});

it('checks the live generation after the pre-submit callback', async () => {
  const f = await fixture();
  let generation = 0;
  Object.assign(f.owner, {
    beforeSubmit: () => {
      generation++;
    },
  });
  expect(
    submitEncodedFrame(f.world, { ...f.input, isCurrent: () => generation === 0 }, [], f.state),
  ).toBe(false);
  expect(f.state.result).toEqual({ ok: false, stage: 'submit' });
  expect(f.submit).not.toHaveBeenCalled();
  expect(renderSubmission(f.world).accepted).toBe(false);
  expect(f.world.execution.health).toBe('healthy');
});

it('keeps the physical fence on its captured generation when an observer replaces the device scope', async () => {
  const f = await fixture();
  const sibling = vi.fn();
  const reportError = vi.fn();
  expect(
    submitEncodedFrame(
      f.world,
      { ...f.input, generation: 0, isCurrent: () => f.owner.deviceScope.generation === 0 },
      [
        {
          reportError,
          onSubmittedWork: () => {
            Object.assign(f.owner, { deviceScope: { generation: 1 } });
          },
        },
        { reportError, onSubmittedWork: sibling },
      ],
      f.state,
    ),
  ).toBe(true);
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.state.result.ok).toBe(true);
  expect(renderSubmission(f.world)).toMatchObject({ accepted: false, generation: 0 });
  expect(sibling).toHaveBeenCalledExactlyOnceWith(renderSubmission(f.world).completion);
  expect(f.world.execution.health).toBe('healthy');
});

it.each([
  false,
  true,
])('retains the stale input cause even if diagnostics throw=%s', async (diagnosticThrows) => {
  const f = await fixture();
  const cause = {
    code: 'fixture-stale-input',
    expected: 'input remains current',
    hint: 'reprepare input',
  };
  expect(
    submitEncodedFrame(
      f.world,
      f.input,
      [
        {
          reportError() {},
          isCurrent: () => false,
          rejectionCause: () => {
            if (diagnosticThrows) throw Error('diagnostic failed');
            return cause;
          },
        },
      ],
      f.state,
    ),
  ).toBe(false);
  expect(f.state.rejectionCause?.code).toBe(
    diagnosticThrows ? 'frame-generation-stale' : cause.code,
  );
  expect(f.state.result).toEqual({ ok: false, stage: 'submit' });
  expect(f.submit).not.toHaveBeenCalled();
});

it.each(['before-submit', 'queue'] as const)('retains the %s rejection details', async (stage) => {
  const f = await fixture();
  const error = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'queue accepts work',
    hint: 'inspect queue',
  });
  if (stage === 'before-submit') Object.assign(f.owner, { beforeSubmit: () => error });
  else f.submit.mockReturnValue(err(error));
  expect(submitEncodedFrame(f.world, f.input, [], f.state)).toBe(false);
  expect(f.state.rejectionCause).toBe(error);
});
