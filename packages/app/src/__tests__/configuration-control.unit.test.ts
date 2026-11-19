import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { EngineConfigurationError, resolveEngineStartup } from '../configuration';
import { ConfigurationRequests, configurationApplyResponse } from '../configuration-apply';
import { createEngineConfigurationControl } from '../configuration-control';

const startup = () => {
  const result = resolveEngineStartup({}, { platform: 'unknown' });
  if (!result.ok) throw result.error;
  return result.value;
};
const ao = (level: 'low' | 'high') => ({
  base: { kind: 'device-default' as const },
  groups: { ambientOcclusion: level },
});

describe('configuration adoption', () => {
  it('preserves structured owner errors across a native structured-clone reply', async () => {
    const channel = new ConfigurationRequests();
    let sent: import('../configuration-apply').ConfigurationApplyRequest | undefined;
    const request = channel.request(startup(), 0, 'world-a', (message) => {
      sent = message;
    });
    if (sent === undefined) throw new Error('Missing request');
    const error = new EngineConfigurationError('configuration-invalid', {
      path: 'rendering',
      reason: 'required shader unavailable',
      cause: Object.assign(new Error('cook input missing'), { code: 'missing-program' }),
    });
    channel.receive(structuredClone(configurationApplyResponse(sent, { ok: false, error })));
    const result = await request;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('configuration-invalid');
      expect(result.error.detail.cause).toMatchObject({ code: 'missing-program' });
      expect(result.error.expected).toBe(error.expected);
    }
    channel.dispose();
  });

  it('distinguishes accepted parameters from submitted and completed scene pictures', async () => {
    const apply = vi.fn(async () => ok(undefined));
    const control = createEngineConfigurationControl({}, startup(), { apply });
    const result = await control.setQuality(ao('low'));
    expect(result.ok).toBe(true);
    expect(control.inspect().rendering).toEqual({});
    control.observe('completed', { configurationRevision: 2, presentation: 'ui-only' });
    control.observe('completed', { configurationRevision: 1, presentation: 'ready' });
    expect(control.inspect().rendering).toEqual({});
    control.observe('submitted', { configurationRevision: 2, presentation: 'ready' });
    expect(control.inspect().rendering).toEqual({ submittedRevision: 2 });
    control.observe('completed', { configurationRevision: 2, presentation: 'ready' });
    expect(control.inspect().rendering.completedRevision).toBe(2);
  });

  it('owns the selection at request time before queued application starts', async () => {
    const selection = ao('low');
    const control = createEngineConfigurationControl({}, startup(), {
      apply: async () => ok(undefined),
    });
    const request = control.setQuality(selection);
    selection.groups.ambientOcclusion = 'high';
    expect((await request).ok).toBe(true);
    expect(control.inspect().applied.requestedGroups.ambientOcclusion).toBe('low');
  });

  it('preflights texture residency before applying any other group', async () => {
    const apply = vi.fn(async () => ok(undefined));
    const control = createEngineConfigurationControl({}, startup(), { apply });
    const result = await control.setQuality({ base: { kind: 'preset', preset: 'low' } });
    expect(!result.ok && result.error.code).toBe('configuration-recreate-required');
    expect(apply).not.toHaveBeenCalled();
    expect(control.inspect().applied.revision).toBe(1);
    expect(control.inspect().pendingRestart?.effectiveGroups.shadows).toBe('low');
  });

  it('keeps the previous accepted plan when its owner rejects a request', async () => {
    const error = new EngineConfigurationError('configuration-invalid', {
      path: 'rendering',
      reason: 'required program missing',
    });
    const write = vi.fn();
    const control = createEngineConfigurationControl({}, startup(), {
      apply: async () => err(error),
      store: { read: vi.fn(), write },
    });
    expect(await control.setQuality(ao('low'))).toEqual({ ok: false, error });
    expect(control.inspect().applied.revision).toBe(1);
    expect(control.inspect().requested.revision).toBe(2);
    expect(write).not.toHaveBeenCalled();
  });

  it('retains saved restart intent when a later hot request is rejected', async () => {
    const error = new EngineConfigurationError('configuration-invalid', {
      path: 'rendering',
      reason: 'required program missing',
    });
    const write = vi.fn();
    const control = createEngineConfigurationControl({}, startup(), {
      apply: async () => err(error),
      store: { read: vi.fn(), write },
    });
    await control.setQuality({ base: { kind: 'preset', preset: 'low' } });
    const pending = control.inspect().pendingRestart;
    expect(pending).toBeDefined();
    expect(await control.setQuality(ao('low'))).toEqual({ ok: false, error });
    expect(control.inspect().pendingRestart).toBe(pending);
    expect(write).toHaveBeenCalledExactlyOnceWith(pending?.selection);
  });

  it('clears restart intent only after its replacement is accepted and saved', async () => {
    const write = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('quota'));
    const control = createEngineConfigurationControl({}, startup(), {
      apply: async () => ok(undefined),
      store: { read: vi.fn(), write },
    });
    await control.setQuality({ base: { kind: 'preset', preset: 'low' } });
    const pending = control.inspect().pendingRestart;
    expect(pending).toBeDefined();
    expect((await control.setQuality(ao('low'))).ok).toBe(false);
    expect(control.inspect().applied.revision).toBe(3);
    expect(control.inspect().pendingRestart).toBe(pending);
    write.mockResolvedValue(undefined);
    expect((await control.setQuality(ao('high'))).ok).toBe(true);
    expect(control.inspect().pendingRestart).toBeUndefined();
  });

  it('derives A to B to A from the source definition and serializes overlapping requests', async () => {
    const revisions: number[] = [];
    const control = createEngineConfigurationControl({}, startup(), {
      apply: async (plan) => {
        revisions.push(plan.revision);
        await Promise.resolve();
        return ok(undefined);
      },
    });
    await Promise.all([control.setQuality(ao('low')), control.setQuality(ao('high'))]);
    expect(revisions).toEqual([2, 3]);
    expect(control.inspect().applied.effectiveGroups).toEqual(startup().effectiveGroups);
    expect(control.inspect().applied.selection).toEqual(ao('high'));
  });

  it('reports persistence failure while preserving actual parameter acceptance', async () => {
    const control = createEngineConfigurationControl({}, startup(), {
      apply: async () => ok(undefined),
      store: {
        read: vi.fn(),
        write: async () => {
          throw new Error('quota');
        },
      },
    });
    const result = await control.setQuality(ao('low'));
    expect(!result.ok && result.error.detail.path).toBe('configurationHost.store');
    expect(control.inspect().applied.revision).toBe(2);
  });

  it('does not adopt a delayed result after disposal', async () => {
    let accept!: () => void;
    const control = createEngineConfigurationControl({}, startup(), {
      apply: () =>
        new Promise((resolve) => {
          accept = () => resolve(ok(undefined));
        }),
    });
    const request = control.setQuality(ao('low'));
    await Promise.resolve();
    control.dispose();
    accept();
    const result = await request;
    expect(!result.ok && result.error.code).toBe('configuration-stale');
    expect(control.inspect().applied.revision).toBe(1);
  });

  it('ignores replies for another World or revision and settles disposal immediately', async () => {
    const channel = new ConfigurationRequests();
    const sent = vi.fn();
    const request = channel.request(startup(), 0, 'world-a', sent);
    const id = sent.mock.calls[0]?.[0].requestId;
    channel.receive({
      kind: 'configuration-result',
      requestId: id,
      worldIdentity: 'world-b',
      revision: 1,
      result: { ok: true, value: undefined },
    });
    channel.receive({
      kind: 'configuration-result',
      requestId: id,
      worldIdentity: 'world-a',
      revision: 9,
      result: { ok: true, value: undefined },
    });
    channel.dispose();
    const result = await request;
    expect(!result.ok && result.error.code).toBe('configuration-stale');
  });
});
