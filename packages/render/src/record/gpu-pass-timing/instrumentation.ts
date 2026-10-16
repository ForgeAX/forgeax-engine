import type {
  RenderGraphFrame,
  RenderGraphPassInstrumentation,
  RenderGraphPassInstrumentationScope,
} from '@forgeax/engine-render-graph';
import type { GpuPassTimingPassIdentity } from './contract';
import type { GpuPassTimingCapture } from './session';

/** Every graph in a Renderer frame allocates from the same ordered timestamp roster. */
export function createPassTimingInstrumentation<Frame extends RenderGraphFrame>(
  capture: GpuPassTimingCapture,
  viewId?: number,
): RenderGraphPassInstrumentation<Frame> {
  type TimestampWrites = NonNullable<ReturnType<GpuPassTimingCapture['timestampWrites']>>;
  const activeIdentity: {
    passName: string;
    passKind: GpuPassTimingPassIdentity['passKind'];
    executionIndex: number;
    viewId: number | undefined;
  } = {
    passName: '',
    passKind: 'raster',
    executionIndex: 0,
    viewId,
  };
  let activeWrites: TimestampWrites | undefined;
  const activeCapture = capture;
  const rasterScope: RenderGraphPassInstrumentationScope = {
    renderPassDescriptor: (descriptor) => {
      const capture = activeCapture;
      const identity = activeIdentity;
      const writes = activeWrites;
      if (capture === undefined || identity === undefined || writes === undefined) {
        return descriptor;
      }
      if (descriptor.timestampWrites !== undefined) {
        capture.markOwnerConflict(identity);
        return descriptor;
      }
      (descriptor as { timestampWrites?: TimestampWrites }).timestampWrites = writes;
      return descriptor;
    },
  };
  const computeScope: RenderGraphPassInstrumentationScope = {
    computePassDescriptor: (descriptor) => {
      const capture = activeCapture;
      const identity = activeIdentity;
      const writes = activeWrites;
      if (capture === undefined || identity === undefined || writes === undefined) {
        return descriptor;
      }
      if (descriptor.timestampWrites !== undefined) {
        capture.markOwnerConflict(identity);
        return descriptor;
      }
      (descriptor as { timestampWrites?: TimestampWrites }).timestampWrites = writes;
      return descriptor;
    },
  };
  const copyScope: RenderGraphPassInstrumentationScope = {
    beforeCopy: (encoder) => {
      const capture = activeCapture;
      const identity = activeIdentity;
      if (capture === undefined || identity === undefined) return;
      capture.copyBoundaryBefore(identity, encoder);
    },
    afterCopy: (encoder) => {
      const capture = activeCapture;
      const identity = activeIdentity;
      if (capture === undefined || identity === undefined) return;
      capture.copyBoundaryAfter(identity, encoder);
    },
  };
  const instrumentation: RenderGraphPassInstrumentation<Frame> = {
    begin: (pass) => {
      const capture = activeCapture;
      if (capture === undefined) return undefined;
      activeIdentity.passName = pass.name;
      activeIdentity.passKind = pass.kind;
      activeIdentity.executionIndex = capture.nextExecutionIndex;
      activeWrites = capture.recordPass(activeIdentity);
      if (activeWrites === undefined) return undefined;
      switch (pass.kind) {
        case 'raster':
          return rasterScope;
        case 'compute':
          return computeScope;
        case 'copy':
          return copyScope;
      }
    },
  };
  return instrumentation;
}
