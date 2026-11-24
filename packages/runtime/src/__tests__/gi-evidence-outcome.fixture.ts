import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

function describe(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : String(error);
}

/** Private capture lifecycle shared by the real GPU case and CPU falsifiers. */
export async function withGiEvidenceOutcome(
  result: Record<string, unknown>,
  run: () => Promise<void>,
  cleanup: () => Promise<void>,
  publish: () => void,
  invalidate: () => void,
): Promise<void> {
  const failures: unknown[] = [];
  let validationFailed = false;
  try {
    await run();
  } catch (error) {
    validationFailed = true;
    result.failure = describe(error);
    failures.push(error);
  }
  let cleanupFailed = false;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailed = true;
    result.cleanupFailure = describe(error);
    failures.push(error);
  }
  result.status = cleanupFailed
    ? 'CLEANUP_FAILED'
    : validationFailed
      ? 'VALIDATION_FAILED'
      : 'PASS';
  try {
    await publish();
  } catch (error) {
    result.status = 'PUBLICATION_FAILED';
    result.publicationFailure = describe(error);
    failures.push(error);
    try {
      await invalidate();
    } catch (invalidationError) {
      result.invalidationFailure = describe(invalidationError);
      failures.push(invalidationError);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'GI evidence outcome failed');
}

/** Keep partial writes outside the final manifest; rollback also invalidates stale output. */
export function createGiEvidenceManifest(
  path: string,
  result: Record<string, unknown>,
  io = { writeFileSync, renameSync, rmSync },
) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  return {
    publish() {
      io.writeFileSync(temporary, JSON.stringify(result, null, 2), { flag: 'wx' });
      io.renameSync(temporary, path);
    },
    invalidate() {
      const failures: unknown[] = [];
      for (const target of [temporary, path]) {
        try {
          io.rmSync(target, { force: true });
        } catch (error) {
          failures.push(error);
          if (target === path) {
            try {
              io.writeFileSync(
                path,
                JSON.stringify({ ...result, status: 'PUBLICATION_FAILED' }, null, 2),
              );
            } catch (writeError) {
              failures.push(writeError);
            }
          }
        }
      }
      if (failures.length) throw new AggregateError(failures, 'GI manifest invalidation failed');
    },
  };
}

import { halfFloat } from '@forgeax/engine-math';

/** Check the actual covered HDR texels, including padded or sliced readbacks. */
export function visibleHdrHasSignal(
  bytes: Uint8Array,
  metadata: { readonly width: number; readonly height: number; readonly bytesPerRow: number },
  covered: Uint8Array,
): boolean {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let visible = 0;
  for (let y = 0; y < metadata.height; y++)
    for (let x = 0; x < metadata.width; x++) {
      if (!covered[y * metadata.width + x]) continue;
      visible++;
      let positive = false;
      for (let channel = 0; channel < 3; channel++) {
        const value = halfFloat.f16ToF32(
          data.getUint16(y * metadata.bytesPerRow + x * 8 + channel * 2, true),
        );
        if (!Number.isFinite(value) || value < 0) return false;
        positive ||= value > 0;
      }
      if (!positive) return false;
    }
  return visible > 0;
}
