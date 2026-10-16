export const READINESS_FRAME_LIMIT = 60;

/** Normalize raw GPU channel order without touching padded row bytes. */
export function normalizeReadbackRgba(pixels, width, height, bytesPerRow, format) {
  if (format === 'rgba8unorm' || format === 'rgba8unorm-srgb') return pixels;
  if (format !== 'bgra8unorm' && format !== 'bgra8unorm-srgb') {
    throw new Error(`Unsupported Dawn evidence format: ${format}`);
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * bytesPerRow + x * 4;
      [pixels[offset], pixels[offset + 2]] = [pixels[offset + 2], pixels[offset]];
    }
  }
  return pixels;
}

export function isRecoverableWarmupError(error) {
  return (
    error.code === 'render-feature-preparation-failed' &&
    error.detail?.stage === 'prepare' &&
    error.detail?.recovery === 'next-frame'
  );
}

export function classifyDawnErrors(errors, readinessFrame) {
  const warmupErrors = [];
  const persistentErrors = [];
  for (const error of errors) {
    const isBeforeReadiness = readinessFrame === undefined || error.frame <= readinessFrame;
    if (isRecoverableWarmupError(error) && isBeforeReadiness) warmupErrors.push(error);
    else persistentErrors.push(error);
  }
  return { warmupErrors, persistentErrors };
}

export function assertAtomicPatchSnapshot(snapshot) {
  const before = snapshot?.before;
  const after = snapshot?.after;
  if (before === undefined || after === undefined) {
    throw new Error('atomic patch snapshot requires before and after blocks');
  }
  if (after.generation !== before.generation + 1) {
    throw new Error('atomic patch generation did not advance exactly once');
  }
  if (!Array.isArray(before.payload) || !Array.isArray(after.payload)) {
    throw new Error('atomic patch snapshot payloads must be arrays');
  }
  if (after.payload.length !== before.payload.length) {
    throw new Error('atomic patch payload shape changed during FixedUpdate');
  }
  const changed = after.payload.filter((value, index) => value !== before.payload[index]);
  if (changed.length > 0 && changed.length < after.payload.length) {
    throw new Error('atomic patch exposed a partial generation');
  }
}
