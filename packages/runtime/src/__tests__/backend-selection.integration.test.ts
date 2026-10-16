import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { loadBackendPack, loadRhiPack } from '../backend-selection';

describe('backend selection', () => {
  it('uses an explicitly injected backend without probing global state', async () => {
    const result = await loadBackendPack({ rhi });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rhi).toBe(rhi);
  });

  it('preserves Runtime instrumentation policy and backend callback identity', async () => {
    let receiver: unknown;
    const createShaderModule = async function (this: unknown, ..._args: unknown[]) {
      receiver = this;
      return { ok: true as const, value: {} as never };
    };
    const createShaderModuleImmediate = (..._args: unknown[]) => ({
      ok: true as const,
      value: {} as never,
    });
    const translateErrorEventToRhiError = (_event: unknown) => ({
      ok: false as const,
      error: {} as never,
    });
    const rawDeviceAccessor = (_device: unknown) => undefined;
    const moduleInstrumentation = { onFrameBoundary: () => undefined };
    const explicitInstrumentation = { onDeviceLost: () => undefined };
    const module = {
      rhi,
      createShaderModule,
      createShaderModuleImmediate,
      translateErrorEventToRhiError,
      _internal_getRawDevice: rawDeviceAccessor,
      instrumentation: moduleInstrumentation,
    };

    const fallbackPack = loadRhiPack(module);
    const explicitPack = loadRhiPack(module, explicitInstrumentation);
    expect(fallbackPack.instrumentation).toBe(moduleInstrumentation);
    expect(explicitPack.instrumentation).toBe(explicitInstrumentation);
    expect(explicitPack.rhi).toBe(rhi);
    expect(explicitPack.createShaderModule).toBe(createShaderModule);
    expect(explicitPack.createShaderModuleImmediate).toBe(createShaderModuleImmediate);
    expect(explicitPack.translateErrorEventToRhiError).toBe(translateErrorEventToRhiError);
    expect(explicitPack._internal_getRawDevice).toBe(rawDeviceAccessor);

    await explicitPack.createShaderModule?.({} as never, { code: '' });
    expect(receiver).toBe(explicitPack);
  });

  it('does not invent optional backend properties when the module omits them', () => {
    const pack = loadRhiPack({ rhi });
    expect(pack.rhi).toBe(rhi);
    expect(Object.hasOwn(pack, 'createShaderModule')).toBe(false);
    expect(Object.hasOwn(pack, 'createShaderModuleImmediate')).toBe(false);
    expect(Object.hasOwn(pack, 'translateErrorEventToRhiError')).toBe(false);
    expect(Object.hasOwn(pack, '_internal_getRawDevice')).toBe(false);
    expect(Object.hasOwn(pack, 'instrumentation')).toBe(false);
  });
});
