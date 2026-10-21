import type {
  RenderGraphFrame,
  RenderGraphPassInstrumentation,
  RenderGraphPassInstrumentationScope,
} from '@forgeax/engine-render-graph';
import type { RenderPassDescriptor } from '@forgeax/engine-rhi';
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
  const applyTimestampWrites = (
    descriptor: Pick<RenderPassDescriptor, 'timestampWrites'>,
  ): void => {
    if (activeWrites === undefined) return;
    if (descriptor.timestampWrites !== undefined) {
      capture.markOwnerConflict(activeIdentity);
      return;
    }
    descriptor.timestampWrites = activeWrites;
  };
  const rasterScope: RenderGraphPassInstrumentationScope = {
    renderPassDescriptor: (descriptor) => {
      applyTimestampWrites(descriptor);
      return descriptor;
    },
  };
  const computeScope: RenderGraphPassInstrumentationScope = {
    computePassDescriptor: (descriptor) => {
      applyTimestampWrites(descriptor);
      return descriptor;
    },
  };
  const copyScope: RenderGraphPassInstrumentationScope = {
    beforeCopy: (encoder) => {
      capture.copyBoundaryBefore(activeIdentity, encoder);
    },
    afterCopy: (encoder) => {
      capture.copyBoundaryAfter(activeIdentity, encoder);
    },
  };
  const instrumentation: RenderGraphPassInstrumentation<Frame> = {
    begin: (pass) => {
      if (pass.kind === 'subgraph') return undefined;
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
