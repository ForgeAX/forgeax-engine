import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { registerAnalyticFogPostProcess } from '../assembly/analytic-fog-registration';
import { deferredPostProcessEntry } from '../assembly/deferred-post-process-entry';
import { createPostProcessParamsOwner } from '../assembly/post-process-params';
import { RhiErrorListenerRegistry } from '../lifecycle';

it('keeps screen fog source lazy until a screen-transport view consumes it', () => {
  const source = vi.fn(() => 'screen-fog-source');
  const register = vi.fn();
  registerAnalyticFogPostProcess({ registerBuiltinPostProcess: register }, source, false);
  expect(source).not.toHaveBeenCalled();
  expect(register).toHaveBeenCalledTimes(1);
  const entry = register.mock.calls[0]?.[1];
  expect(entry.source).toBe('screen-fog-source');
  expect(entry.source).toBe('screen-fog-source');
  expect(source).toHaveBeenCalledTimes(1);
  registerAnalyticFogPostProcess({ registerBuiltinPostProcess: register }, source, true);
  expect(register).toHaveBeenCalledTimes(1);
});

it('keeps unused builtin shader declarations unprepared across frames, recovery and retirement', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const prepareSource = vi.fn(() => 'selected-source');
  const invalidate = vi.fn();
  const owner = createPostProcessParamsOwner(
    { device, errorRegistry: new RhiErrorListenerRegistry() },
    invalidate,
  );
  const entry = deferredPostProcessEntry(
    { params: { byteSize: 32, defaultValue: new Uint8Array(32) } },
    prepareSource,
  );
  const remove = owner.registerBuiltinPostProcess('unused', entry);
  for (let frame = 0; frame < 4; frame++) owner.accept(owner.prepare(new Map()).unwrap());
  const replacement = (await adapter.requestDevice()).unwrap();
  owner.publishRecovery(owner.prepareRecovery(replacement).unwrap());
  expect(prepareSource).not.toHaveBeenCalled();
  remove();
  expect(prepareSource).not.toHaveBeenCalled();
  expect(invalidate).toHaveBeenCalledWith('unused', undefined);
  owner.dispose();
});

it('prepares once at consumption, retries a failed source and invalidates only its prepared module', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const prepareSource = vi
    .fn()
    .mockImplementationOnce(() => {
      throw Error('candidate failed');
    })
    .mockReturnValue('ready-source');
  const invalidate = vi.fn();
  const owner = createPostProcessParamsOwner(
    { device, errorRegistry: new RhiErrorListenerRegistry() },
    invalidate,
  );
  const entry = deferredPostProcessEntry({}, prepareSource);
  const remove = owner.registerBuiltinPostProcess('selected', entry);
  expect(() => owner.lookup('selected')?.source).toThrow('candidate failed');
  expect(owner.lookup('selected')?.source).toBe('ready-source');
  expect(owner.lookup('selected')?.source).toBe('ready-source');
  expect(prepareSource).toHaveBeenCalledTimes(2);
  remove();
  expect(prepareSource).toHaveBeenCalledTimes(2);
  expect(invalidate.mock.calls[0]?.[1]).toMatch(/^post-process-module-/);
  owner.dispose();
});
