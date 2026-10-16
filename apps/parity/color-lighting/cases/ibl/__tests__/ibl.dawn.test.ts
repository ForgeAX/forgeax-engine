import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import capabilityLoss from '../capability-loss.json' with { type: 'json' };
import { captureIblGpuCase, serializeIblGpuCaseResult } from '../../../src/adapters/ibl-adapter';

async function persistIblArtifact(result: Awaited<ReturnType<typeof captureIblGpuCase>>): Promise<void> {
  const path = process.env.FORGEAX_PARITY_IBL_ARTIFACT;
  if (path === undefined) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'ibl-producer',
      caseId: 'ibl-constant-environment',
      invocationId: process.env.FORGEAX_PARITY_INVOCATION_ID ?? 'ibl-dawn-artifact',
      producer: serializeIblGpuCaseResult(result),
    }, null, 2)}\n`,
    'utf8',
  );
}

describe('IBL Dawn GPU case', () => {
  it('keeps unavailable HDR execution failed and captures native raw bytes when available', async () => {
    const result = await captureIblGpuCase(navigator.gpu);

    if (result.capability.capabilityStatus !== 'supported') {
      await persistIblArtifact(result);
      if (process.env.FORGEAX_PARITY_REQUIRED === '1') {
        throw new Error('required IBL Dawn evidence needs rgba16floatRenderable');
      }
      expect(result.capability.verdict).toBe('failed');
      expect(result.capability.executionStatus).toBe('notExecuted');
      expect(result.capability.fallbackArtifact).toBe(capabilityLoss.fallbackArtifact);
      expect(result.evidence.rawHash).toBeNull();
      return;
    }
    await persistIblArtifact(result);
    expect(result.capability.outputFormat).toBe('rgba16float');
    expect(result.evidence.status).toBe('ready');
    expect(result.evidence.format).toBe('rgba16float');
    expect(result.evidence.rawHash).toMatch(/^[0-9a-f]{8}$/);
    expect(result.evidence.lastKnownGood).toContain('rgba16float');
    expect(result.finalDisplay.status).toBe('ready');
    expect(result.finalDisplay.format).toBe('rgba8unorm');
    expect(result.finalDisplay.rawHash).toMatch(/^[0-9a-f]{8}$/);
  });
});
