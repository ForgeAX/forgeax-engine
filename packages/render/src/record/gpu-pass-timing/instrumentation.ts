import type {
  RenderGraphFrame,
  RenderGraphPassExecution,
  RenderGraphPassInstrumentation,
  RenderGraphPassInstrumentationScope,
} from '@forgeax/engine-render-graph';
import type { RenderPassDescriptor } from '@forgeax/engine-rhi';
import type { GpuPassTimingPassIdentity } from './contract';
import type { GpuPassTimingCapture } from './session';

export type RenderGraphPassCpuScopeFactory = (
  pass: RenderGraphPassExecution,
  gpuIdentity: GpuPassTimingPassIdentity | undefined,
  gpuIdentityStatus: 'available' | 'not-captured' | 'not-recorded',
) => (() => void) | undefined;

/** Every graph in a Renderer frame allocates from the same ordered timestamp roster. */
export function createPassTimingInstrumentation<Frame extends RenderGraphFrame>(
  capture: GpuPassTimingCapture | undefined,
  viewId?: number,
  beginCpuScope?: RenderGraphPassCpuScopeFactory,
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
    if (capture === undefined || activeWrites === undefined) return;
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
      capture?.copyBoundaryBefore(activeIdentity, encoder);
    },
    afterCopy: (encoder) => {
      capture?.copyBoundaryAfter(activeIdentity, encoder);
    },
  };
  const instrumentation: RenderGraphPassInstrumentation<Frame> = {
    begin: (pass) => {
      if (pass.kind === 'subgraph') return undefined;
      let gpuIdentityStatus: 'available' | 'not-captured' | 'not-recorded' =
        capture === undefined ? 'not-captured' : 'not-recorded';
      activeWrites = undefined;
      if (capture !== undefined) {
        activeIdentity.passName = pass.name;
        activeIdentity.passKind = pass.kind;
        activeIdentity.executionIndex = capture.nextExecutionIndex;
        activeWrites = capture.recordPass(activeIdentity);
        if (activeWrites !== undefined) gpuIdentityStatus = 'available';
      }
      if (beginCpuScope === undefined) {
        if (activeWrites === undefined) return undefined;
        switch (pass.kind) {
          case 'raster':
            return rasterScope;
          case 'compute':
            return computeScope;
          case 'copy':
            return copyScope;
        }
      }
      let endCpuScope: (() => void) | undefined;
      try {
        endCpuScope = beginCpuScope?.(
          pass,
          activeWrites === undefined ? undefined : activeIdentity,
          gpuIdentityStatus,
        );
      } catch {
        // Render profiling is diagnostic; it cannot change pass execution.
      }
      let nativeScope: RenderGraphPassInstrumentationScope | undefined;
      if (activeWrites !== undefined) {
        switch (pass.kind) {
          case 'raster':
            nativeScope = rasterScope;
            break;
          case 'compute':
            nativeScope = computeScope;
            break;
          case 'copy':
            nativeScope = copyScope;
            break;
        }
      }
      if (nativeScope === undefined && endCpuScope === undefined) return undefined;
      if (endCpuScope === undefined) return nativeScope;
      return {
        ...nativeScope,
        endPass: () => {
          try {
            endCpuScope?.();
          } catch {
            // Render profiling cannot alter graph pass success or failure.
          }
        },
      };
    },
  };
  return instrumentation;
}
