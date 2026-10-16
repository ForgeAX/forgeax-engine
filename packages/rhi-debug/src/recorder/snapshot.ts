import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import type { DebugRhiInstance } from '../recorder';
import type { ResourceRegistry } from './resource-registry';

export interface SnapshotOptions {
  readonly snapshotTimeoutMs: number;
  readonly byteBudget: number;
  readonly maxResourceBytes?: number;
}

export async function snapshotFrame(
  recorder: DebugRhiInstance,
  registry: ResourceRegistry,
  options: SnapshotOptions,
): Promise<Result<void, RhiDebugError>> {
  const estimatedBytes = registry.estimateSnapshotBytes(options.maxResourceBytes);
  const requiredBytes = Math.max(1, estimatedBytes);
  if (requiredBytes > options.byteBudget) {
    return err(
      createRhiDebugError('capture-snapshot-failed', {
        stage: 'snapshot',
        cause: `snapshot byte budget ${options.byteBudget} is smaller than the ${requiredBytes}-byte capture minimum`,
      }),
    );
  }
  try {
    const result = await recorder.snapshotAllLiveResources(
      options.snapshotTimeoutMs,
      options.maxResourceBytes,
    );
    if (result.ok) return ok(undefined);
    return err(result.error);
  } catch (cause) {
    return err(
      createRhiDebugError('capture-snapshot-failed', {
        stage: 'snapshot',
        cause: String(cause),
      }),
    );
  }
}
