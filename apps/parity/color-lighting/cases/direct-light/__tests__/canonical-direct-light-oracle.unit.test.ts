import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import oracle from '../canonical-direct-light-oracle.json' with { type: 'json' };
import {
  compareSpotShadowToCanonicalExpected,
  createDirectLightCanonicalExpected,
  perturbDirectLightCanonicalExpected,
  SPOT_SHADOW_SCENES,
} from '../spot-shadow-fixture';

const fixturePath = resolve(import.meta.dirname, '../canonical-direct-light-oracle.json');
const generatorPath = resolve(import.meta.dirname, '../generate-canonical-direct-light-oracle.mjs');

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

describe('canonical direct-light oracle', () => {
  it('has a finite numeric payload, bounded thresholds, and auditable hashes', () => {
    const value = oracle as typeof oracle & { provenance: { payloadBytesSha256: string; generatorSha256: string } };
    const core = { ...value } as Record<string, unknown>;
    delete core.provenance;
    expect(value.expected.base.rgb.every(Number.isFinite)).toBe(true);
    expect(value.expected.clearcoat.rgb.every(Number.isFinite)).toBe(true);
    expect(value.expected.clearcoatDelta.rgb.every(Number.isFinite)).toBe(true);
    expect(value.epsilonAbs).toBeGreaterThan(0);
    expect(value.epsilonAbs).toBeLessThanOrEqual(0.05);
    expect(value.pairwiseEpsilonAbs).toBeGreaterThan(0);
    expect(value.pairwiseEpsilonAbs).toBeLessThanOrEqual(0.05);
    expect(value.provenance.payloadBytesSha256).toBe(sha256(JSON.stringify(core)));
    expect(value.provenance.generatorSha256).toBe(sha256(readFileSync(generatorPath)));
    expect(sha256(readFileSync(fixturePath))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('reproduces checked fixture bytes on two independent generator runs', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'forgeax-direct-light-oracle-'));
    try {
      const outputs = [join(temporaryDirectory, 'run-1.json'), join(temporaryDirectory, 'run-2.json')];
      for (const output of outputs) {
        const result = spawnSync('node', ['--experimental-strip-types', generatorPath], {
          cwd: process.cwd(),
          env: { ...process.env, FORGEAX_CANONICAL_ORACLE_OUTPUT: output },
          encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(0);
      }
      const fixtureBytes = readFileSync(fixturePath);
      expect(readFileSync(outputs[0]!)).toEqual(fixtureBytes);
      expect(readFileSync(outputs[1]!)).toEqual(fixtureBytes);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('compares numeric RGB observations and rejects a canonical channel perturbation', () => {
    const expected = createDirectLightCanonicalExpected(SPOT_SHADOW_SCENES.hdrp);
    const target = expected.expected.base;
    const observed = {
      lit: 0,
      shadow: 0,
      delta: 0,
      rgb: {
        lit: target.rgb,
        shadow: target.shadowRgb,
        delta: target.deltaRgb,
      },
    };
    const pass = compareSpotShadowToCanonicalExpected(expected, 'base', observed);
    expect(pass.maxChannelAbs).toBe(0);
    expect(pass.verdict).toBe('pass');
    const perturbed = perturbDirectLightCanonicalExpected(expected, 'base', 1, expected.epsilonAbs + 0.001);
    const falsified = compareSpotShadowToCanonicalExpected(perturbed, 'base', observed);
    expect(falsified.maxChannelAbs).toBeGreaterThan(expected.epsilonAbs);
    expect(falsified.verdict).toBe('non-pass');
  });
});
