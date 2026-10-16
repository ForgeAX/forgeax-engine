import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readReferencePng } from '../../../shared/png-codec.mjs';

// Adjacent submitted frames, not golden-image comparison. Keep local peaks:
// a small mean cannot excuse a flashing seam or a missing phase transition.
export function measureDisplayCycle(receipts, images, regions) {
  assert.ok(receipts.length >= 9 && (receipts.length - 1) % 8 === 0,
    'Measure complete eight-phase cycles plus their closing image');
  assert.equal(images.length, receipts.length);
  const { width, height } = images[0];
  assert.ok(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0);
  for (let i = 0; i < receipts.length; i++) {
    const { before, after } = receipts[i];
    assert.ok(before.historyValid && after.historyValid && before.frameIndex >= 128);
    assert.equal(after.resetReason, undefined);
    assert.equal(after.frameIndex, before.frameIndex + 1);
    assert.equal(after.epoch, before.epoch + 1);
    assert.equal(after.viewIdentity, before.viewIdentity);
    assert.equal(after.deviceGeneration, before.deviceGeneration);
    if (i > 0) assert.deepEqual(before, receipts[i - 1].after, 'Missing or discontinuous rendered frame');
    const credit = receipts[i].execution;
    if (credit !== undefined) {
      assert.equal(credit.before.inFlight, 0);
      assert.equal(credit.after.inFlight, 0);
      assert.equal(credit.after.submitted, credit.before.submitted + 1);
      assert.equal(credit.after.completed, credit.before.completed + 1);
      assert.equal(credit.before.submitted, credit.before.completed);
      assert.equal(credit.after.submitted, credit.after.completed);
    }
    assert.equal(images[i].width, width);
    assert.equal(images[i].height, height);
    assert.ok(images[i].pixels instanceof Uint8Array);
    assert.equal(images[i].pixels.length, width * height * 4);
  }
  const statistics = {};
  for (const [name, region] of Object.entries(regions)) {
    assert.ok(region.length === 4 && region.every(v => Number.isFinite(v) && v >= 0 && v <= 1));
    const [left, top, right, bottom] = region;
    assert.ok(left < right && top < bottom);
    let sum = 0, samples = 0, maximum = 0, above4 = 0, worstPixel = null;
    const phasePeaks = [];
    for (let phase = 1; phase < images.length; phase++) {
      let peak = 0;
      for (let y = Math.ceil(top * height); y < bottom * height; y++) {
        for (let x = Math.ceil(left * width); x < right * width; x++) {
          const offset = (y * width + x) * 4;
          let difference = 0;
          for (let c = 0; c < 3; c++) difference = Math.max(difference,
            Math.abs(images[phase].pixels[offset + c] - images[phase - 1].pixels[offset + c]));
          sum += difference; samples++;
          if (difference > 4) above4++;
          if (difference > maximum) { maximum = difference; worstPixel = [phase, x, y]; }
          peak = Math.max(peak, difference);
        }
      }
      phasePeaks.push(peak);
    }
    assert.ok(samples > 0, 'Region contains no pixels');
    // Adjacent deltas alone miss slow drift across repeated jitter cycles.
    const temporalRange = { maximum: 0, above4: 0, worstPixel: null };
    for (let y = Math.ceil(top * height); y < bottom * height; y++) {
      for (let x = Math.ceil(left * width); x < right * width; x++) {
        const offset = (y * width + x) * 4;
        let range = 0;
        for (let c = 0; c < 3; c++) {
          let minimum = 255, maximum = 0;
          for (const image of images) {
            const value = image.pixels[offset + c];
            minimum = Math.min(minimum, value);
            maximum = Math.max(maximum, value);
          }
          range = Math.max(range, maximum - minimum);
        }
        if (range > 4) temporalRange.above4++;
        if (range > temporalRange.maximum) {
          temporalRange.maximum = range;
          temporalRange.worstPixel = [x, y];
        }
      }
    }
    statistics[name] = { mean: sum / samples, maximum, above4, worstPixel, phasePeaks, temporalRange };
  }
  return { domain: 'native-display-rgba8-code-values', extent: [width, height],
    transitions: receipts.length - 1, frames: receipts.map(f => f.after.frameIndex), regions, statistics };
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  assert.ok(process.argv[2], 'usage: measure-display-cycle.mjs <native frames.json>');
  const manifestPath = resolve(process.argv[2]);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // This decoder accepts only the native smoke producer, not Chrome's adaptive
  // PNG filtering or CSS-composited screenshots.
  assert.equal(manifest.mode, 'display-only-actual-rendered-frames');
  const measured = measureDisplayCycle(manifest.frames,
    manifest.frames.map(f => readReferencePng(resolve(dirname(manifestPath), f.path))), {
      wall: [0.1, 0.2, 0.9, 0.48], contact: [0.1, 0.47, 0.9, 0.56],
      floorSeams: [0.1, 0.55, 0.9, 0.77], upperEdge: [0.15, 0.7, 0.8, 0.81], scene: [0, 0, 1, 1],
    });
  console.log(JSON.stringify({ shaderManifestDigest: manifest.shaderManifestDigest, ...measured }, null, 2));
}
