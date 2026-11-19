import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  runVisualNormalDetailPublishGpuProbes,
  visualNormalDetailGpuEvidenceJson,
} from './visual-normal-detail-gpu';

it('publishes signed +Y-up visual normals and preserves raw height on the GPU', async () => {
  const evidence = await runVisualNormalDetailPublishGpuProbes();
  const json = visualNormalDetailGpuEvidenceJson(evidence);
  const evidenceDirectory = process.env.FORGEAX_I05_EVIDENCE_DIR;
  if (evidenceDirectory !== undefined) {
    await mkdir(evidenceDirectory, { recursive: true });
    for (const probe of evidence.probes) {
      await writeFile(
        join(evidenceDirectory, `visual-normal-detail-${probe.format}-${probe.name}.bin`),
        probe.rawBytes,
      );
    }
    await writeFile(
      join(evidenceDirectory, 'visual-normal-detail-dawn.json'),
      `${JSON.stringify(json, null, 2)}\n`,
    );
  }
  console.info(`I05_VISUAL_FFT_EVIDENCE_JSON=${JSON.stringify(json)}`);

  expect(evidence.validationErrors).toEqual([]);
  expect(evidence.uncapturedErrors).toEqual([]);
  expect(evidence.probes).toHaveLength(12);
  for (const probe of evidence.probes) {
    const normalTolerance = probe.format === 'rgba16float' ? 0.001 : 0.00001;
    const heightTolerance = probe.format === 'rgba16float' ? 0.001 : 0.000001;
    expect(probe.actual.every(Number.isFinite)).toBe(true);
    expect(probe.maxNormalError).toBeLessThan(normalTolerance);
    expect(probe.heightError).toBeLessThan(heightTolerance);
    expect(probe.rawBytes.byteLength).toBe(probe.bytesPerRow * probe.extent.height);
  }
  for (const format of ['rgba16float', 'rgba32float'] as const) {
    const positiveX = evidence.probes.find(
      (probe) => probe.format === format && probe.name === 'positive-x-ramp',
    );
    const positiveZ = evidence.probes.find(
      (probe) => probe.format === format && probe.name === 'positive-z-ramp',
    );
    const smallSpacing = evidence.probes.find(
      (probe) => probe.format === format && probe.name === 'small-spacing-ramp',
    );
    expect(positiveX?.actual[0]).toBeLessThan(0);
    expect(positiveX?.actual[1]).toBeGreaterThan(0);
    expect(positiveZ?.actual[2]).toBeLessThan(0);
    expect(smallSpacing?.actual[0]).toBeLessThan(0);
    expect(smallSpacing?.actual[1]).toBeGreaterThan(0);
  }
});
