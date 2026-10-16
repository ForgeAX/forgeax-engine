import * as render from '@forgeax/engine-render';
import {
  type EngineEnvironmentError,
  constructRendererHost as internalConstructRendererHost,
  loadRhiPack as loadRenderRhiPack,
  type RendererHostAssembly,
  type RhiBackendPack,
} from '@forgeax/engine-render/internal/construct-renderer';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import type { RenderError } from '../errors/render';
import type { RenderResult } from '../render-contract';

describe('construct-renderer internal entry', () => {
  it('keeps construction out of the public barrel', () => {
    expect('constructRenderer' in render).toBe(false);
    expect(internalConstructRendererHost).toEqual(expect.any(Function));
  });

  it('freezes the only construct seam as a structured Result factory', () => {
    type Return = ReturnType<typeof internalConstructRendererHost>;
    type Expected = Promise<
      RenderResult<RendererHostAssembly, RenderError | EngineEnvironmentError>
    >;
    expect(null as unknown as Return satisfies Expected).toBeNull();
  });

  it('projects backend fields with Render explicit-only instrumentation policy', () => {
    const createShaderModule = async (..._args: unknown[]) => ({
      ok: true as const,
      value: {} as never,
    });
    const createShaderModuleImmediate = (..._args: unknown[]) => ({
      ok: true as const,
      value: {} as never,
    });
    const translateErrorEventToRhiError = (_event: unknown) => ({
      ok: false as const,
      error: {} as never,
    });
    const rawDeviceAccessor = (_device: unknown) => undefined;
    const moduleInstrumentation: RhiBackendPack['instrumentation'] = {
      onFrameBoundary: () => undefined,
    };
    const explicitInstrumentation: RhiBackendPack['instrumentation'] = {
      onDeviceLost: () => undefined,
    };
    const module = {
      rhi,
      createShaderModule,
      createShaderModuleImmediate,
      translateErrorEventToRhiError,
      _internal_getRawDevice: rawDeviceAccessor,
      instrumentation: moduleInstrumentation,
    };

    const implicitPack = loadRenderRhiPack(module);
    const explicitPack = loadRenderRhiPack(module, explicitInstrumentation);
    expect(Object.hasOwn(implicitPack, 'instrumentation')).toBe(false);
    expect(explicitPack.instrumentation).toBe(explicitInstrumentation);
    expect(explicitPack.rhi).toBe(rhi);
    expect(explicitPack.createShaderModule).toBe(createShaderModule);
    expect(explicitPack.createShaderModuleImmediate).toBe(createShaderModuleImmediate);
    expect(explicitPack.translateErrorEventToRhiError).toBe(translateErrorEventToRhiError);
    expect(explicitPack._internal_getRawDevice).toBe(rawDeviceAccessor);

    const absentPack = loadRenderRhiPack({ rhi });
    expect(Object.hasOwn(absentPack, 'createShaderModule')).toBe(false);
    expect(Object.hasOwn(absentPack, 'createShaderModuleImmediate')).toBe(false);
    expect(Object.hasOwn(absentPack, 'translateErrorEventToRhiError')).toBe(false);
    expect(Object.hasOwn(absentPack, '_internal_getRawDevice')).toBe(false);
  });
});
