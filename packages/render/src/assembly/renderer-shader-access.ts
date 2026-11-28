import type { RhiError } from '@forgeax/engine-rhi';
import { ShaderCatalog } from '@forgeax/engine-shader';
import { shaderSourceForDescriptor } from '@forgeax/engine-types';
import type { DeviceScope } from '../device/device-scope';
import {
  makeShaderDeviceAdapter,
  type ShaderDeviceAdapterInternal,
} from './material-shader-policy';
import type { RendererShaderState } from './recovery/renderer-recover';
import type { WebGPURendererInternals } from './webgpu-renderer-contract';

export function canDeferStandardFullscreen(internals: WebGPURendererInternals): boolean {
  return (
    internals.options?.publicationSource !== undefined &&
    internals.device.caps.backendKind === 'webgpu' &&
    internals.pack.createShaderModuleImmediate !== undefined
  );
}

/** Resolve shader modules in the active or candidate generation through one owner. */
export function createRendererShaderAccess(
  internals: Pick<WebGPURendererInternals, 'bundler' | 'errorRegistry' | 'pack'>,
  getActiveState: () => RendererShaderState,
  getSelectedState: () => RendererShaderState,
  getSelectedScope: () => DeviceScope,
) {
  const getShaderModuleAdapter = (
    mode: 'validated' | 'immediate' = 'validated',
  ): ShaderDeviceAdapterInternal => {
    const state = getSelectedState();
    const slot =
      mode === 'validated' ? 'sharedShaderModuleAdapter' : 'sharedImmediateShaderModuleAdapter';
    let adapter = state[slot];
    if (adapter === null) {
      adapter = makeShaderDeviceAdapter(
        state.device,
        internals.errorRegistry,
        internals.pack.createShaderModule,
        internals.pack.createShaderModuleImmediate,
        mode,
        mode === 'immediate'
          ? (key, source) => state.sharedShaderModuleAdapter?.completedModule(key, source)
          : undefined,
      );
      state[slot] = adapter;
      getSelectedScope()._adopt('shader', adapter, (value) => value.dispose());
    }
    return adapter;
  };
  // RenderSystem retains this factory across recovery. Module requests select
  // the current adapter synchronously; volume preparation resolves all modules
  // before its first await and shares this exact factory with live recording.
  const peekShaderModule = (
    descriptor: Parameters<ShaderDeviceAdapterInternal['createShaderModule']>[0],
    mode: 'validated' | 'immediate',
  ) => {
    if (descriptor.label === undefined) return undefined;
    const state = getSelectedState();
    const adapter =
      mode === 'validated'
        ? state.sharedShaderModuleAdapter
        : state.sharedImmediateShaderModuleAdapter;
    return adapter?.completedModule(
      descriptor.label,
      shaderSourceForDescriptor(descriptor) ?? descriptor.code,
    );
  };
  const renderShaderModuleFactory = {
    createShaderModule: (
      descriptor: Parameters<ShaderDeviceAdapterInternal['createShaderModule']>[0],
    ) => getShaderModuleAdapter().createShaderModule(descriptor),
    isPending: (error: Parameters<ShaderDeviceAdapterInternal['isPending']>[0]) =>
      getShaderModuleAdapter().isPending(error),
    peekShaderModule: (
      descriptor: Parameters<ShaderDeviceAdapterInternal['createShaderModule']>[0],
    ) => peekShaderModule(descriptor, 'validated'),
    pendingShaderModuleCompletion: (signal: RhiError) =>
      getSelectedState().sharedShaderModuleAdapter?.pendingCompletion(signal),
  };
  const getShader = (): ShaderCatalog => {
    const state = getSelectedState();
    if (state.shaderInstance === null) {
      const activeCatalog =
        getActiveState().shaderInstance ?? internals.bundler?.admittedShaderCatalog;
      // Reuse validated manifest CPU rows; candidate preparation selects variants.
      // feat-20260608-create-app-param-surface-trim / M2 / D-2 q5-A:
      // shaderManifestUrl moved to BundlerOptions (third arg). The fallback
      // literal '/shaders/manifest.json' stays here so the LO 1.1
      // hello-window zero-config takeoff path keeps working without an
      // bundler injection. The 'shaderManifestUrl' in (...) check preserves
      // the zero-entry opt-in: explicitly passing
      // `bundler: { shaderManifestUrl: undefined }` retains the
      // old "no manifest fetched" mode used by tests / camera-only worlds.
      state.shaderInstance =
        activeCatalog !== undefined
          ? activeCatalog.forkForDevice(getShaderModuleAdapter())
          : new ShaderCatalog({
              device: getShaderModuleAdapter(),
              ...(internals.bundler?.prepareShaderProgramCompiler === undefined
                ? {}
                : {
                    prepareProgramCompiler: internals.bundler.prepareShaderProgramCompiler,
                  }),
              ...(internals.bundler?.readShaderManifest === undefined
                ? {}
                : {
                    readText: internals.bundler.readShaderManifest,
                  }),
              manifestUrl:
                internals.bundler !== undefined && 'shaderManifestUrl' in internals.bundler
                  ? internals.bundler.shaderManifestUrl
                  : '/shaders/manifest.json',
            });
    }
    return state.shaderInstance;
  };
  // Boot warms every device-reachable variant; a recovery candidate rebuilds
  // only modules the lost generation drew with, inside the recovery deadline.
  const drewWithModule = (label: string): boolean => {
    const state = getActiveState();
    return (
      state.sharedShaderModuleAdapter?.hasModule(label) === true ||
      state.sharedImmediateShaderModuleAdapter?.hasModule(label) === true
    );
  };
  return {
    getShaderModuleAdapter,
    peekShaderModule,
    renderShaderModuleFactory,
    getShader,
    drewWithModule,
  };
}
