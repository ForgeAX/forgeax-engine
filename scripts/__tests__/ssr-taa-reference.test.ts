import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  accumulateTaaReference,
  measureTaaReferenceRegions,
  readCapturedTaaPose,
} from '../../apps/hello/ssr/scripts/taa-reference.mjs';

describe('independent TAA cycle accumulation reference', () => {
  it.each([
    ['implementation', 'rgba32float', 'Private statistics format must be explicit'],
    [
      'all',
      'rgba16float',
      'Extended private statistics require one explicit implementation candidate',
    ],
  ])('rejects incompatible statistics before reading captures: %s / %s', (variant, format, message) => {
    const result = spawnSync(
      process.execPath,
      [
        'apps/hello/ssr/scripts/compare-taa-feedback.mjs',
        'unused-capture-prefix',
        variant,
        `--stability-format=${format}`,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain('ENOENT');
  });

  it('detects stable color bias without requiring exported frame files', () => {
    const reference = { width: 10, height: 10, values: new Float32Array(400).fill(1) };
    const samples = Float32Array.from({ length: 400 }, (_, i) =>
      i % 4 === 0 ? 1.5 : i % 4 === 1 ? 0.5 : 1,
    );
    const measured = measureTaaReferenceRegions(samples, reference);
    for (const region of Object.values(measured)) {
      expect(region).toEqual({ mean: 0.5, signedMeanRgb: 0, p99: 0.5, maximum: 0.5 });
    }
    for (const region of Object.values(measureTaaReferenceRegions(reference.values, reference))) {
      expect(region).toEqual({ mean: 0, signedMeanRgb: 0, p99: 0, maximum: 0 });
    }
    expect(() => measureTaaReferenceRegions(samples.slice(4), reference)).toThrow();
    samples[0] = Number.NaN;
    expect(() => measureTaaReferenceRegions(samples, reference)).toThrow();
  });

  it('averages compressed HDR samples and inverts once, without a clipped history', () => {
    const frame = (v: number) => ({
      image: { width: 1, height: 1, values: [v, v, v, 1] },
      jitterPixels: [0, 0],
    });
    const result = accumulateTaaReference([frame(0), frame(4)]);
    for (const c of result.values.slice(0, 3)) expect(c).toBeCloseTo(2 / 3, 6);
    expect(result.values[3]).toBe(1);
  });

  it('cancels the source raster offset before accumulating each phase', () => {
    const image = { width: 2, height: 1, values: [0, 0, 0, 1, 4, 4, 4, 1] };
    const result = accumulateTaaReference([{ image, jitterPixels: [0.25, 0] }]);
    expect([...result.values]).toEqual([1, 1, 1, 1, 4, 4, 4, 1]);
  });

  it('preserves a constant HDR signal across jitter phases', () => {
    const image = { width: 2, height: 1, values: [2, 4, 8, 1, 2, 4, 8, 1] };
    const result = accumulateTaaReference(
      [-0.4, 0, 0.4].map((x) => ({ image, jitterPixels: [x, 0] })),
    );
    expect([...result.values]).toEqual(image.values);
  });

  it('compares current bound mesh poses independently of camera and prior transforms', () => {
    const directory = mkdtempSync(join(tmpdir(), 'forgeax-taa-pose-'));
    const prefix = join(directory, 'capture');
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const publish = (phase: number, x: number, priorX: number) => {
      const output = `${prefix}-${phase}`;
      mkdirSync(output);
      // Test the cache/provenance projection, not the separate tape decoder.
      const tape = Buffer.from([phase]);
      const view = Buffer.alloc(960);
      const meshes = Buffer.alloc(256);
      meshes.writeFloatLE(x, 48);
      meshes.writeFloatLE(priorX, 64 + 48);
      writeFileSync(join(output, 'frame.rhitape'), tape);
      writeFileSync(join(output, 'taa-feedback-view.bin'), view);
      writeFileSync(join(output, 'taa-feedback-meshes.bin'), meshes);
      writeFileSync(
        join(output, 'taa-feedback-inputs.json'),
        JSON.stringify({
          digest: digest(tape),
          view: { digest: digest(view) },
          meshes: { digest: digest(meshes) },
        }),
      );
    };
    try {
      publish(0, 2.75, 2.65);
      publish(1, 2.75, 2.75);
      publish(2, 2.25, 2.25);
      expect(readCapturedTaaPose(prefix, 0)).toEqual(readCapturedTaaPose(prefix, 1));
      expect(readCapturedTaaPose(prefix, 0)).not.toEqual(readCapturedTaaPose(prefix, 2));
      writeFileSync(`${prefix}-1/taa-feedback-meshes.bin`, Buffer.alloc(256));
      expect(() => readCapturedTaaPose(prefix, 1)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
