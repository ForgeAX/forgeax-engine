import { assert } from 'vitest';
import { temporalMetrics } from './gi-scene-temporal-metrics.fixture';
import type { SceneHarness, SceneImage } from './gi-scenes.fixture';

const LAYERS = ['card-direct', 'card-lit', 'irradiance', 'moments', 'meta'] as const;
const RAW_LIMIT = 512 * 1024 * 1024;

function transportRgb(image: SceneImage): Float32Array {
  assert(image.transport && image.transport.length === image.width * image.height * 4);
  return Float32Array.from({ length: image.rgb.length }, (_, index) => {
    const pixel = Math.floor(index / 3);
    const value = image.transport?.[pixel * 4 + (index % 3)];
    assert(value !== undefined && Number.isFinite(value));
    return value;
  });
}

/** One image draw, then layer copies without another Renderer submission. Saves before assessment. */
export async function captureStaticFieldSequence(
  h: SceneHarness,
  frames: number,
  referenceScale: number,
) {
  assert(frames === 256, 'The declared static temporal window is 256 completed frames');
  const images: Float32Array[] = [];
  const signals: Float32Array[] = [];
  const receipts: { frameId: number; submittedFrames: number; rawBytes: number }[] = [];
  let rawBytes = 0;
  let previousFrame = -1;
  let covered: Uint8Array | undefined;
  for (let frame = 0; frame < frames; frame++) {
    const name = `temporal-${String(frame).padStart(3, '0')}`;
    const image = await h.image(name);
    assert(image.frameId !== undefined && image.frameId > previousFrame);
    previousFrame = image.frameId;
    const state = h.renderer.inspect().diffuseGi;
    assert(state?.state === 'ready' && 'gather' in state && state.gather === 'irradiance-field');
    const submittedFrames = state.submittedFrames;
    const reads = await Promise.allSettled(LAYERS.map((label) => h.read(label)));
    // Preserve every successful layer before classifying any failed or nonfinite read.
    for (const [index, read] of reads.entries()) {
      if (read.status === 'rejected') continue;
      const label = LAYERS[index];
      assert(label);
      const bytes = new Uint8Array(read.value.buffer, read.value.byteOffset, read.value.byteLength);
      rawBytes += bytes.byteLength;
      h.save(`${name}-${label}.${label === 'meta' ? 'u32' : 'f32'}`, bytes);
    }
    assert(rawBytes <= RAW_LIMIT, 'Temporal diagnostic raw storage exceeded its declared bound');
    for (const [index, read] of reads.entries()) {
      if (read.status === 'rejected') throw read.reason;
      const label = LAYERS[index];
      // Meta contains packed integer/f16 fields. Never interpret those bits as f32 radiance.
      if (label !== 'meta')
        for (const value of read.value)
          assert(Number.isFinite(value), `${name}:${label}:nonfinite`);
    }
    const after = h.renderer.inspect().diffuseGi;
    assert(after?.state === 'ready' && after.submittedFrames === submittedFrames);
    assert(image.covered);
    if (covered === undefined) covered = image.covered.slice();
    else assert(image.covered.every((value, pixel) => value === covered?.[pixel]));
    images.push(image.rgb);
    signals.push(transportRgb(image));
    receipts.push({ frameId: image.frameId, submittedFrames, rawBytes });
    // Each saved path is immutable: the scene manifest retains every file digest.
    h.save(`${name}-progress.json`, {
      status: 'COLLECTING_UNASSESSED',
      targetFrames: frames,
      receipts,
      inspection: h.renderer.inspect(),
    });
  }
  const result = {
    status: 'COLLECTED_UNASSESSED',
    scope: 'Static production-sequence diagnostics; not a stability or physical GI qualification',
    frames,
    rawBytes,
    referenceScale,
    receipts,
    hdr: temporalMetrics(images, referenceScale),
    transport: temporalMetrics(signals, referenceScale),
    missingCoveragePolicy: 'All pixels retained; fixed visible-surface mask checked per frame',
  };
  h.save('temporal-summary.json', result);
  return result;
}
