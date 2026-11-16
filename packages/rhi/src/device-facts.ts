import type { RhiCaps } from './index.js';

export type RhiCapabilityStatus = 'supported' | 'unsupported' | 'unvalidated';

/** Descriptor-validation facts. These do not certify a renderer or physical residency. */
export function inspectRhiDeviceFacts(
  caps: Readonly<RhiCaps>,
  limits: Readonly<Record<string, number>>,
) {
  const status = (value: boolean | undefined): RhiCapabilityStatus =>
    value === undefined ? 'unvalidated' : value ? 'supported' : 'unsupported';
  return {
    version: 1 as const,
    compute: status(caps.compute),
    storageBuffer: status(caps.storageBuffer),
    indirectDraw: status(caps.indirectDrawing),
    timestampQuery: status(caps.timestampQuery),
    formats: {
      rgba16float: {
        renderSample: status(caps.rgba16floatRenderable),
        arrayRenderSample: status(caps.rgba16floatArrayRenderable),
        storageSample: status(caps.rgba16floatStorage),
      },
      rgba32float: {
        renderSample: status(caps.rgba32floatRenderable),
        arrayRenderSample: status(caps.rgba32floatArrayRenderable),
        storageSample: status(caps.rgba32floatStorage),
      },
      depth32float: { renderSample: status(caps.depth32floatSampled) },
      rg16float: { renderSample: status(caps.rg16floatRenderable) },
    },
    limits: { ...limits },
  };
}

export type RhiDeviceFacts = ReturnType<typeof inspectRhiDeviceFacts>;
