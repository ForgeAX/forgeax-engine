import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import type { DeviceScope, LifecycleResourceSpec } from '../device/device-scope';

/** Explicit candidate-owned inputs for lifecycle-root preparation. */
export interface RecoveryRootRuntime {
  readonly scope: DeviceScope;
}

/** Candidate roots plus the one synchronous owner switch at publication. */
export interface RecoveryRootBundle {
  readonly roots: readonly LifecycleResourceSpec<unknown>[];
  publish(): void;
  discard(): void;
}

/** Device-bound post-process resources prepared off to the side of the active renderer. */
export interface RecoveryPostProcessResources {
  readonly device: RhiDevice;
  readonly paramsBuffers: Map<string, Buffer>;
}
