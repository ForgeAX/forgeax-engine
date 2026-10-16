import { err, ok, type Result } from '@forgeax/engine-types';
import type { CurrentFrameObservationLease } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { readbackTexturePixels } from '@forgeax/engine-rhi-debug';

/** Read the producer-owned rgba16float observation without exposing its texture handle. */
export async function readbackRgba16float(
  device: RhiDevice,
  lease: CurrentFrameObservationLease,
): Promise<Result<Uint8Array, Error>> {
  const sourceResult = lease.beginReadback();
  if (!sourceResult.ok) return err(new Error(sourceResult.error.hint));
  try {
    return ok(
      await readbackTexturePixels(
        device,
        sourceResult.value.texture,
        lease.descriptor.size.width,
        lease.descriptor.size.height,
        { bytesPerTexel: 8 },
      ),
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(new Error(`rgba16float readback failed: ${message}`));
  }
}
