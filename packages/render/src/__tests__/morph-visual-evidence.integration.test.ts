import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const evidencePath = resolve(repoRoot, 'artifacts/format-tier1/morph-visual-evidence.json');

describe.skipIf(!existsSync(evidencePath))('Morph Dawn evidence contract', () => {
  it('binds a complete GPU result of at least 60 frames to the immutable source and readback', async () => {
    const evidence = await readFile(evidencePath, 'utf8').then(
      (source) =>
        JSON.parse(source) as {
          schemaVersion?: string;
          featureId?: string;
          source?: { csvSha256?: string; firstTierRows?: number[]; sourceCodeSha?: string };
          environment?: { backend?: string };
          requiredFrames?: number;
          framesObserved?: number;
          phases?: {
            standardFrames?: number;
            baseWeightFrames?: number;
            zeroWeightFrames?: number;
            animatedFrames?: number;
          };
          readback?: { status?: string; path?: string; maxAbsError?: number };
          screenshot?: { status?: string; path?: string | null; reason?: string };
          falsifiers?: { zeroWeights?: string; standardLane?: string; staleWeights?: string };
          observed?: string;
          producer?: { status?: string; kind?: string };
          verdict?: string;
          confidence?: string;
          capabilityRefusal?: unknown;
        },
    );

    expect(evidence.schemaVersion).toBe('morph-visual-evidence/1');
    expect(evidence.featureId).toBe('feat-20260812-format-classification-tier1');
    expect(evidence.source?.csvSha256).toBe(
      'a87159400f5de776ce46304540999c2e7f84cec07defceaa661d0a0926a9c2d5',
    );
    expect(evidence.source?.firstTierRows).toEqual([8, 18, 26]);
    expect(evidence.source?.sourceCodeSha).toMatch(/^[a-f0-9]{40,64}$/);
    expect(evidence.environment?.backend).toBe('dawn');
    expect(evidence.requiredFrames).toBeGreaterThanOrEqual(60);
    expect(evidence.framesObserved).toBe(evidence.requiredFrames);
    const phaseFrames = (evidence.requiredFrames ?? 0) / 3;
    expect(evidence.phases).toEqual({
      standardFrames: evidence.requiredFrames,
      baseWeightFrames: phaseFrames,
      zeroWeightFrames: phaseFrames,
      animatedFrames: phaseFrames,
    });
    expect(evidence.readback?.status).toBe('pass');
    expect(evidence.readback?.path).toContain('observe(FrameReceipt)');
    expect(evidence.readback?.maxAbsError).toBeNull();
    expect(evidence.screenshot).toBeUndefined();
    expect(evidence.falsifiers).toEqual({
      zeroWeights: 'pass',
      standardLane: 'pass',
      staleWeights: 'pass',
    });
    expect(evidence.observed).toEqual(expect.any(String));
    expect(evidence.producer).toMatchObject({ status: 'pass', kind: 'imported-loadByGuid' });
    expect(evidence.verdict).toBe('pass');
    expect(evidence.confidence).toBe('high');
    expect(evidence.capabilityRefusal).toBeUndefined();
  });
});
