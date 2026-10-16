import { describe, expect, it, vi } from 'vitest';
import { createRenderer as constructRenderer } from '../assembly/factory';
import { executeRendererFrameTransaction } from '../assembly/renderer-frame-transaction';
import { DeviceScope, LifecycleTransaction } from '../device/device-scope';
import { RenderRecoveryError } from '../errors/recover';
import { LifecycleConstructionError, type RenderError } from '../errors/render';

describe('renderer lifecycle', () => {
  it('keeps cube capture in the existing renderer lifecycle boundary', () => {
    const calls: string[] = [];
    const frame = () => {
      calls.push('extract');
      calls.push('encode');
      calls.push('finish');
      calls.push('submit');
    };
    frame();
    expect(calls).toEqual(['extract', 'encode', 'finish', 'submit']);
    expect(calls.filter((call) => call === 'extract')).toHaveLength(1);
    expect(calls.filter((call) => call === 'submit')).toHaveLength(1);
  });

  it.each([
    undefined,
    null,
  ])('rejects missing construction input before backend acquisition (%s)', async (canvas) => {
    const requestAdapter = vi.fn(rhi.requestAdapter);
    await expect(
      constructRenderer(canvas, { rhi: { ...rhi, requestAdapter } }),
    ).rejects.toMatchObject({
      name: 'EngineEnvironmentError',
    });
    expect(requestAdapter).not.toHaveBeenCalled();
  });

  it('keeps the lifecycle tree structural and independent from a GPU backend', async () => {
    const scope = DeviceScope.create(60, 'renderer');
    const transaction = new LifecycleTransaction(scope);
    transaction.add({
      kind: 'scene-table',
      create: () => ({ id: 'scene-table' }),
      cleanup: () => undefined,
    });

    const result = await transaction.commit();

    expect(result.ok).toBe(true);
    expect(scope.generation).toBe(60);
    expect(scope.resourceDelta()).toBe(1);
  });

  it('keeps lifecycle and recovery failures structured without message parsing', () => {
    const receipt = { owner: 'renderer', generation: 61, resourceCount: 0 } as const;
    const lifecycleError = new LifecycleConstructionError({
      owner: receipt.owner,
      generation: receipt.generation,
      operation: 'create',
      resourceKind: 'pipeline',
      cause: new Error('driver failure'),
      cleanupFailures: [],
      receipt,
    });
    const renderError: RenderError = lifecycleError;
    expect(renderError.code).toBe('lifecycle-construction-failed');
    expect(renderError.detail.owner).toBe('renderer');
    expect(renderError.detail.receipt).toEqual(receipt);
    expect(renderError.hint).toContain('recover');

    const recoveryError = new RenderRecoveryError('recover-lifecycle-failed', {
      owner: receipt.owner,
      generation: receipt.generation,
      recovery: 'recover',
      receipt,
      cause: lifecycleError,
    });
    expect(recoveryError.code).toBe('recover-lifecycle-failed');
    expect(recoveryError.detail.receipt).toEqual(receipt);
    expect(recoveryError.hint).toContain('rebuild');
  });

  it('retains the last successful state when a candidate fails', () => {
    const state = { signature: 'env:1', revision: 1, frameIndex: 12, history: 'history:1' };
    const result = executeRendererFrameTransaction({
      build: () => ({
        ok: true,
        value: { signature: 'env:2', revision: 2, frameIndex: 13, history: 'history:2' },
      }),
      execute: () => ({ ok: true, value: undefined }),
      finish: () => ({ ok: false, stage: 'finish' as const }),
      submit: () => ({ ok: true, value: undefined }),
      commit: (candidate) => Object.assign(state, candidate),
    });
    expect(result).toEqual({ ok: false, error: { stage: 'finish' } });
    expect(state).toEqual({
      signature: 'env:1',
      revision: 1,
      frameIndex: 12,
      history: 'history:1',
    });
  });
});

import { rhi } from '@forgeax/engine-rhi-null';
