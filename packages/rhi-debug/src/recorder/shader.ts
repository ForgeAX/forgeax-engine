// @forgeax/engine-rhi-debug/src/recorder/shader -- standalone shader factory proxy.

import type { Result, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import type { HandleId } from '../types';
import {
  type CreateShaderModuleFn,
  type CreateShaderModuleImmediateFn,
  type DebugRhiInstance,
  recorderDeviceIdentity,
} from './core';

function recordShaderModule(
  debugInst: DebugRhiInstance,
  result: Result<ShaderModule, import('@forgeax/engine-rhi').RhiError>,
  desc: { code: string; label?: string | undefined },
): Result<ShaderModule, import('@forgeax/engine-rhi').RhiError> {
  if (!result.ok) return result;
  const hId = debugInst.pushExternalCreateEvent(result.value, 'shaderModule', {
    kind: 'createShaderModule',
    handleId: '' as HandleId,
    wgslCode: desc.code,
  });
  // Register the shader module handle in the recorder's handleMap so
  // downstream pipeline events can resolve the handleId during replay.
  debugInst.registerShaderModule(result.value, hId);
  return result;
}

export function wrapCreateShaderModule(
  originalFn: CreateShaderModuleFn,
  debugInst: DebugRhiInstance,
): CreateShaderModuleFn {
  return async function wrappedCreateShaderModule(
    device: RhiDevice,
    desc: { code: string; label?: string | undefined },
  ): Promise<Result<ShaderModule, import('@forgeax/engine-rhi').RhiError>> {
    // The renderer threads the proxied RhiDevice (from proxyDevice()) here, but
    // engine-rhi-webgpu's createShaderModule reverse-looks-up the GPUDevice via
    // a WeakMap keyed on the RhiDevice that makeRhiDevice registered. The proxy
    // is a different JS object, so WeakMap.get(proxy) is undefined and the real
    // fn returns shader-compile-failed ("unregistered RhiDevice"). Unwrap the
    // proxy to the registered device via the _realDevice escape hatch that
    // proxyDevice exposes for exactly this purpose.
    const realDevice = recorderDeviceIdentity(device) ?? device;
    const result = await originalFn(realDevice, desc);
    return recordShaderModule(debugInst, result, desc);
  };
}

/** Wrap the synchronous render-path factory while preserving tape ownership. */
export function wrapCreateShaderModuleImmediate(
  originalFn: CreateShaderModuleImmediateFn,
  debugInst: DebugRhiInstance,
): CreateShaderModuleImmediateFn {
  return (device, desc) => {
    const realDevice = recorderDeviceIdentity(device) ?? device;
    return recordShaderModule(debugInst, originalFn(realDevice, desc), desc);
  };
}
