import type {
  RenderGraphPassInstrumentation,
  RenderGraphPassInstrumentationScope,
} from '@forgeax/engine-render-graph';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { GpuTimingCapture } from './gpu-timing';

/** Add portable timestamp writes only to raster and compute pass descriptors. */
export function createTimingInstrumentation(
  capture: GpuTimingCapture,
): RenderGraphPassInstrumentation<RenderPipelineFrame> {
  return {
    begin: (pass): RenderGraphPassInstrumentationScope | undefined => {
      if (pass.kind === 'copy' || pass.kind === 'subgraph') return undefined;
      const writes = capture.beginPass(pass.name, pass.kind, pass.executionIndex);
      if (writes === undefined) return undefined;
      const descriptorWithTimestamps = <T extends { readonly timestampWrites?: unknown }>(
        descriptor: T,
      ): T | (T & { readonly timestampWrites: typeof writes }) => {
        if (descriptor.timestampWrites !== undefined) {
          capture.markOwnerConflict(pass.name);
          return descriptor;
        }
        return { ...descriptor, timestampWrites: writes };
      };
      return pass.kind === 'raster'
        ? { renderPassDescriptor: descriptorWithTimestamps }
        : { computePassDescriptor: descriptorWithTimestamps };
    },
  };
}
