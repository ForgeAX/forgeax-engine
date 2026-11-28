import { describe, expect, it } from 'vitest';
import type { ColorImage } from '../tools/image-metrics';
import { scoreFeatures } from '../tools/visual-microscope';
import { subject } from './visual-fixture';

const EYE = [0.58, 0.38, 0.06] as const;
const ref = { image: subject(256, { eye: EYE }) };
const eyeRoi = [0.55, 0.12, 0.85, 0.42] as const;
const bodyRoi = [0.1, 0.5, 0.5, 0.9] as const;

describe('model.microscope per-feature scoring', () => {
  it('passes every feature of an identical render at another resolution', () => {
    const r = scoreFeatures(ref, { image: subject(320, { eye: EYE }) }, [
      { id: 'eye', tier: 'critical', roi: eyeRoi },
      { id: 'belly', tier: 'important', roi: bodyRoi },
    ]);
    expect(r.pass).toBe(true);
    expect(r.features.map((f) => f.status)).toEqual(['scored', 'scored']);
    expect(r.features[0]?.score as number).toBeGreaterThan(0.8);
  });

  it('fails a critical feature the render lacks while the body still matches', () => {
    const r = scoreFeatures(ref, { image: subject(256, {}) }, [
      { id: 'eye', tier: 'critical', roi: eyeRoi },
      { id: 'belly', tier: 'important', roi: bodyRoi },
    ]);
    expect(r.pass).toBe(false);
    const eye = r.features.find((f) => f.id === 'eye');
    const belly = r.features.find((f) => f.id === 'belly');
    expect(eye?.pass).toBe(false);
    expect(belly?.pass).toBe(true);
    const issue = r.issues.find((i) => i.code === 'feature-below-minimum');
    expect(issue?.detail.subject).toBe('eye');
    expect(issue?.detail.worstPatch).toBeDefined();
  });

  it('registers untouched features when a local edit moves the subject bbox', () => {
    const finned = { image: subject(256, { eye: EYE, fin: [0.14, 0.45, 0.25, 0.6] }) };
    const features = [{ id: 'eye', tier: 'critical' as const, roi: eyeRoi }];
    const registered = scoreFeatures(ref, finned, features);
    const fixed = scoreFeatures(ref, finned, features, { maxShift: 0 });
    expect(registered.features[0]?.pass).toBe(true);
    expect(registered.features[0]?.shift).not.toEqual([0, 0]);
    expect(fixed.features[0]?.score as number).toBeLessThan(
      registered.features[0]?.score as number,
    );
    expect(registered.maxShift).toBe(8);
  });

  it('still fails a feature the render lacks after registration', () => {
    const finned = { image: subject(256, { fin: [0.14, 0.45, 0.25, 0.6] }) };
    const r = scoreFeatures(ref, finned, [{ id: 'eye', tier: 'critical', roi: eyeRoi }]);
    expect(r.features[0]?.pass).toBe(false);
  });

  it('lists critical features first whatever the input order', () => {
    const r = scoreFeatures(ref, { image: subject(256, { eye: EYE }) }, [
      { id: 'd', tier: 'detail', roi: bodyRoi },
      { id: 'c', tier: 'critical', roi: eyeRoi },
    ]);
    expect(r.features.map((f) => f.id)).toEqual(['c', 'd']);
  });

  it('fails closed on a region the reference does not resolve', () => {
    const r = scoreFeatures(ref, { image: subject(256, { eye: EYE }) }, [
      { id: 'speck', tier: 'critical', roi: [0.5, 0.5, 0.52, 0.52] },
    ]);
    expect(r.pass).toBe(false);
    expect(r.features[0]?.status).toBe('insufficient-reference-resolution');
  });

  it('fails closed on a region outside the subject', () => {
    const large = { image: subject(512, { eye: EYE }) };
    const r = scoreFeatures(large, { image: subject(256, { eye: EYE }) }, [
      { id: 'corner', tier: 'detail', roi: [0, 0, 0.12, 0.12] },
    ]);
    expect(r.pass).toBe(false);
    expect(r.features[0]?.status).toBe('no-reference-signal');
  });

  it('skips the color term of a concave feature', () => {
    const tinted = { image: subject(256, { eye: EYE, rgb: [0.3, 0.4, 0.8] }) };
    const flat = scoreFeatures(ref, tinted, [{ id: 'f', tier: 'detail', roi: bodyRoi }]);
    const concave = scoreFeatures(ref, tinted, [
      { id: 'f', tier: 'detail', roi: bodyRoi, concave: true },
    ]);
    expect(flat.features[0]?.worst?.color).toBeDefined();
    expect(concave.features[0]?.worst?.color).toBeUndefined();
    expect(concave.features[0]?.score as number).toBeGreaterThan(flat.features[0]?.score as number);
  });

  it('limits scoring to a footprint mask', () => {
    const mask = new Uint8Array(256 * 256);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 128; x++) mask[y * 256 + x] = 1;
    const r = scoreFeatures(ref, { image: subject(256, {}) }, [
      { id: 'eye', tier: 'critical', roi: eyeRoi, mask },
    ]);
    expect(r.features[0]?.status).toBe('no-reference-signal');
  });

  it('fails closed when the render is a blank frame', () => {
    const blank: ColorImage = {
      width: 64,
      height: 64,
      rgb: new Float32Array(64 * 64 * 3).fill(0.85),
    };
    const r = scoreFeatures(ref, { image: blank }, [{ id: 'eye', tier: 'critical', roi: eyeRoi }]);
    expect(r.pass).toBe(false);
    expect(r.issues[0]?.code).toBe('mask-unreliable');
  });
});
