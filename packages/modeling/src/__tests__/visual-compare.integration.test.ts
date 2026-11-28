import { describe, expect, it } from 'vitest';
import type { ColorImage } from '../tools/image-metrics';
import { compareImages } from '../tools/visual-compare';
import { subject } from './visual-fixture';

const EYE = [0.58, 0.38, 0.06] as const;

describe('model.compare image comparison', () => {
  const ref = { image: subject(160, { eye: EYE }) };

  it('passes a render identical to the reference at another resolution', () => {
    const { report } = compareImages(ref, { image: subject(240, { eye: EYE }) });
    expect(report.verdict).toBe('pass');
    expect(report.pass).toBe(true);
    expect(report.hard.silhouetteIoU).toBeGreaterThan(0.97);
    expect(report.fidelity).toBeGreaterThan(0.9);
    expect(report.interior?.cellsCompared).toBeGreaterThan(1000);
  });

  it('passes the same subject framed smaller (the bbox alignment absorbs framing)', () => {
    const framed = subject(160, {
      eye: [0.5 + (EYE[0] - 0.5) * 0.6, 0.5 + (EYE[1] - 0.5) * 0.6, EYE[2] * 0.6],
      body: [0.5, 0.5, 0.18, 0.21],
    });
    const { report } = compareImages(ref, { image: framed });
    expect(report.hard.silhouetteIoU).toBeGreaterThan(0.95);
    expect(report.issues.some((i) => i.code === 'silhouette-mismatch')).toBe(false);
  });

  it('rejects a different silhouette with the located IoU facts', () => {
    const { report } = compareImages(ref, {
      image: subject(160, { eye: EYE, body: [0.5, 0.5, 0.42, 0.18] }),
    });
    expect(report.pass).toBe(false);
    expect(report.verdict).toBe('reject');
    const issue = report.issues.find((i) => i.code === 'silhouette-mismatch');
    expect(issue?.severity).toBe('error');
    expect(issue?.detail.iou as number).toBeLessThan(0.85);
  });

  it('rejects a wrongly colored render that matches in structure', () => {
    const { report } = compareImages(ref, {
      image: subject(160, { eye: EYE, rgb: [0.2, 0.3, 0.85] }),
    });
    expect(report.pass).toBe(false);
    expect(report.issues.find((i) => i.code === 'palette-mismatch')?.severity).toBe('error');
    expect(report.hueZones?.some((z) => z.pass === false)).toBe(true);
    expect(report.deltaE?.mean as number).toBeGreaterThan(10);
  });

  it('rejects a hue swap that the mean color hides', () => {
    const swapped = subject(160, { eye: EYE });
    const rgb = swapped.rgb.map((_, i) => swapped.rgb[i - (i % 3) + (2 - (i % 3))] as number);
    const { report } = compareImages(ref, { image: { ...swapped, rgb } });
    expect(report.pass).toBe(false);
    expect(
      report.issues.some((i) => i.code === 'hue-zone-mismatch' && i.severity === 'error'),
    ).toBe(true);
    expect(report.hueZoneGate).toBe(15);
  });

  it('fails closed when the render is a blank frame', () => {
    const blank: ColorImage = {
      width: 64,
      height: 64,
      rgb: new Float32Array(64 * 64 * 3).fill(0.85),
    };
    const { report, sheet } = compareImages(ref, { image: blank });
    expect(report.pass).toBe(false);
    expect(report.verdict).toBe('unverifiable');
    expect(report.signals).toBeUndefined();
    expect(report.issues[0]?.code).toBe('mask-unreliable');
    expect(report.issues[0]?.detail.subject).toBe('render');
    expect(sheet.length).toBe(0);
  });

  it('fails closed when the subject fills the frame', () => {
    const solid: ColorImage = {
      width: 64,
      height: 64,
      rgb: new Float32Array(64 * 64 * 3).fill(0.2),
    };
    const noisy = { ...solid, rgb: solid.rgb.map((v, i) => (i % 7 === 0 ? 0.9 : v)) };
    const { report } = compareImages({ image: noisy }, ref);
    expect(report.verdict).toBe('unverifiable');
  });

  it('is deterministic and reports the weights it used', () => {
    const a = compareImages(ref, { image: subject(200, { eye: EYE }) });
    const b = compareImages(ref, { image: subject(200, { eye: EYE }) });
    expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report));
    expect(Object.keys(a.report.weights)).toHaveLength(9);
    expect(a.sheet.length).toBeGreaterThan(100);
    expect(a.heatmap.length).toBeGreaterThan(100);
  });

  it('keeps the report bounded: no per-pixel arrays leak into the JSON', () => {
    const { report } = compareImages(ref, { image: subject(200, { eye: EYE }) }, { size: 256 });
    expect(JSON.stringify(report).length).toBeLessThan(20000);
    expect(report.signals?.edges).not.toHaveProperty('bits');
  });

  it('uses the alpha channel as the mask when the image has transparency', () => {
    const image = subject(160, { eye: EYE });
    const alpha = new Uint8Array(160 * 160);
    for (let i = 0; i < alpha.length; i++)
      alpha[i] =
        image.rgb[i * 3] === Math.fround(0.85) && image.rgb[i * 3 + 1] === Math.fround(0.85)
          ? 0
          : 255;
    const { report } = compareImages({ image, alpha }, ref);
    expect(report.hard.masks.reference.source).toBe('alpha');
    expect(report.hard.masks.render.source).toBe('color-key');
    expect(report.hard.silhouetteIoU).toBeGreaterThan(0.97);
  });
});
