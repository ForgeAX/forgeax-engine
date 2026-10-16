// @forgeax/engine-runtime/__tests__/ssao-manifest.test.ts —
// feat-20260612-hdrp-ssao M6 / w25: SSAO manifest entry load assertion (RED).
//
// plan-strategy D-E: hdrp-ssao.wgsl must be registered in the manifest with
// two entry points (fs_ssao_calc + fs_ssao_blur). The content-marker triage
// in createRenderer uses 'fs_ssao_calc' (same pattern as BloomDownsampleParams).
//
// RED phase: the manifest entry does not exist yet (hdrp-ssao.wgsl is not
// registered in the vite-plugin-shader engine entries). This test asserts
// that a manifest entry containing 'fs_ssao_calc' marker would be correctly
// identified and parsed.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface ManifestEntry {
  hash: string;
  wgsl: string;
  glsl: string | null;
  bindings: string;
}

interface ManifestFixture {
  entries: ManifestEntry[];
}

function loadManifestFixture(): ManifestFixture {
  const here = fileURLToPath(import.meta.url);
  const fixturePath = resolve(
    here,
    '..',
    '..',
    '..',
    '..',
    'shader',
    'src',
    '__tests__',
    'manifest.fixture.json',
  );
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as ManifestFixture;
}

describe('SSAO manifest entry assertions (w25 — RED)', () => {
  const manifest = loadManifestFixture();

  // ── manifest fixture structure ─────────────────────────────────────────────

  it('(a) manifest fixture has at least 3 entries (including hdrp-ssao)', () => {
    expect(manifest.entries.length).toBeGreaterThanOrEqual(3);
  });

  // ── hdrp-ssao entry content marker ─────────────────────────────────────────

  it('(b) an entry contains fs_ssao_calc fragment entry point marker', () => {
    const ssaoEntries = manifest.entries.filter((e) => e.wgsl.includes('fs_ssao_calc'));
    expect(ssaoEntries).toHaveLength(1);
  });

  it('(c) the hdrp-ssao entry also contains fs_ssao_blur marker', () => {
    const ssaoEntry = manifest.entries.find((e) => e.wgsl.includes('fs_ssao_calc'));
    expect(ssaoEntry).toBeDefined();
    if (ssaoEntry) {
      expect(ssaoEntry.wgsl).toContain('fs_ssao_blur');
    }
  });

  it('(d) the hdrp-ssao entry has a non-empty hash', () => {
    const ssaoEntry = manifest.entries.find((e) => e.wgsl.includes('fs_ssao_calc'));
    expect(ssaoEntry).toBeDefined();
    if (ssaoEntry) {
      expect(ssaoEntry.hash).toBeTruthy();
      expect(typeof ssaoEntry.hash).toBe('string');
    }
  });

  // ── content-marker triage pattern ──────────────────────────────────────────

  it('(e) fs_ssao_calc marker is unique — only one entry contains it', () => {
    const count = manifest.entries.filter((e) => e.wgsl.includes('fs_ssao_calc')).length;
    expect(count).toBe(1);
  });

  it('(f) fs_ssao_calc marker triage pattern matches the Bloom marker pattern', () => {
    // Same triage pattern as: if (entry.wgsl.includes('BloomDownsampleParams'))
    // For SSAO: if (entry.wgsl.includes('fs_ssao_calc'))
    const ssaoEntry = manifest.entries.find((e) => e.wgsl.includes('fs_ssao_calc'));
    expect(ssaoEntry).toBeDefined();
    // The marker string is a WGSL function name that survives naga_oil composition
    expect(ssaoEntry?.wgsl).toMatch(/fn\s+fs_ssao_calc\b/);
  });

  // ── ShaderRegistry integration placeholder ─────────────────────────────────
  // NOTE: This test documents that when ShaderRegistry loads a manifest
  // containing the hdrp-ssao entry, the entry can be looked up by hash
  // and its wgsl content contains the marker for createRenderer triage.
  // In GREEN phase (w27), this will be verified via actual manifest build.

  it('(g) manifest entry wgsl is parseable JSON string (no raw WGSL file)', () => {
    const ssaoEntry = manifest.entries.find((e) => e.wgsl.includes('fs_ssao_calc'));
    expect(ssaoEntry).toBeDefined();
    if (ssaoEntry) {
      // The wgsl is a string (composed WGSL), not a file path
      expect(typeof ssaoEntry.wgsl).toBe('string');
      expect(ssaoEntry.wgsl.length).toBeGreaterThan(50);
    }
  });
});
